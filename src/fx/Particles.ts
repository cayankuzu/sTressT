import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, NormalBlending, Points, type Scene, ShaderMaterial, Vector3 } from "three";

export type ParticleKind = "dust" | "chips" | "sparks" | "glint";

type Style = { size: [number, number]; life: [number, number]; speed: [number, number]; gravity: number; drag: number; grow: number; alpha: number };

const STYLES: Record<ParticleKind, Style> = {
  // Soft puffs that expand and hang in the air.
  dust: { size: [0.05, 0.12], life: [0.5, 1.1], speed: [0.2, 1.1], gravity: -0.25, drag: 2.6, grow: 2.4, alpha: 0.42 },
  // Tiny bits of the material thrown out of the impact.
  chips: { size: [0.012, 0.025], life: [0.45, 0.9], speed: [1.5, 4.2], gravity: -9.8, drag: 0.6, grow: 0, alpha: 1 },
  // Hot metal sparks.
  sparks: { size: [0.01, 0.018], life: [0.12, 0.32], speed: [2.5, 6], gravity: -6, drag: 1.2, grow: -0.6, alpha: 1 },
  // Glints of glass catching the light.
  glint: { size: [0.01, 0.02], life: [0.3, 0.7], speed: [1.2, 3.5], gravity: -9.8, drag: 0.4, grow: 0, alpha: 1 },
};

const vertexShader = /* glsl */ `
  attribute float size;
  attribute float alpha;
  attribute vec3 color;
  varying float vAlpha;
  varying vec3 vColor;
  uniform float scale;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * scale / max(0.05, -mv.z);
    gl_Position = projectionMatrix * mv;
    vAlpha = alpha;
    vColor = color;
  }`;

const fragmentShader = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    if (d > 0.25) discard;
    gl_FragColor = vec4(vColor, vAlpha * (1.0 - d * 4.0));
    #include <colorspace_fragment>
  }`;

/** One pool of GPU points: a single draw call for every puff, chip and spark in the game. */
class Pool {
  readonly points: Points;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly baseAlpha: Float32Array;
  private readonly kind: Uint8Array;
  private readonly geometry = new BufferGeometry();
  private next = 0;
  private live = 0;

  constructor(
    scene: Scene,
    private readonly capacity: number,
    additive: boolean,
  ) {
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.baseAlpha = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.geometry.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute("color", new BufferAttribute(this.col, 3));
    this.geometry.setAttribute("size", new BufferAttribute(this.size, 1));
    this.geometry.setAttribute("alpha", new BufferAttribute(this.alpha, 1));
    this.geometry.setDrawRange(0, capacity);
    const material = new ShaderMaterial({
      uniforms: { scale: { value: 600 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: additive ? AdditiveBlending : NormalBlending,
    });
    this.points = new Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
    this.points.visible = false;
    scene.add(this.points);
  }

  setScale(pixelsPerMetreAtOneMetre: number): void {
    const uniform = (this.points.material as ShaderMaterial).uniforms.scale;
    if (uniform) uniform.value = pixelsPerMetreAtOneMetre;
  }

  spawn(kind: ParticleKind, p: Vector3, v: Vector3, color: Color, sizeScale: number): void {
    const s = STYLES[kind];
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    if (this.life[i] === 0 || (this.life[i] ?? 0) <= 0) this.live++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    const life = s.life[0] + Math.random() * (s.life[1] - s.life[0]);
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = (s.size[0] + Math.random() * (s.size[1] - s.size[0])) * sizeScale;
    this.baseAlpha[i] = s.alpha;
    this.kind[i] = Object.keys(STYLES).indexOf(kind);
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.live <= 0) {
      this.points.visible = false;
      return;
    }
    const kinds = Object.values(STYLES);
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      const life = this.life[i] as number;
      if (life <= 0) continue;
      const left = life - dt;
      if (left <= 0) {
        this.life[i] = 0;
        this.alpha[i] = 0;
        this.size[i] = 0;
        continue;
      }
      alive++;
      this.life[i] = left;
      const s = kinds[this.kind[i] as number] as Style;
      const o = i * 3;
      const damp = Math.exp(-s.drag * dt);
      this.vel[o] = (this.vel[o] as number) * damp;
      this.vel[o + 1] = (this.vel[o + 1] as number) * damp + s.gravity * dt;
      this.vel[o + 2] = (this.vel[o + 2] as number) * damp;
      this.pos[o] = (this.pos[o] as number) + (this.vel[o] as number) * dt;
      this.pos[o + 1] = (this.pos[o + 1] as number) + (this.vel[o + 1] as number) * dt;
      this.pos[o + 2] = (this.pos[o + 2] as number) + (this.vel[o + 2] as number) * dt;
      // Chips and glints bounce once off the floor and settle.
      if ((this.pos[o + 1] as number) < 0.004 && s.gravity < -1) {
        this.pos[o + 1] = 0.004;
        this.vel[o + 1] = -(this.vel[o + 1] as number) * 0.25;
        this.vel[o] = (this.vel[o] as number) * 0.5;
        this.vel[o + 2] = (this.vel[o + 2] as number) * 0.5;
      }
      const t = 1 - left / (this.maxLife[i] as number);
      this.size[i] = (this.baseSize[i] as number) * (1 + s.grow * t);
      this.alpha[i] = (this.baseAlpha[i] as number) * (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85);
    }
    this.live = alive;
    for (const name of ["position", "size", "alpha", "color"]) (this.geometry.getAttribute(name) as BufferAttribute).needsUpdate = true;
  }
}

const tmpV = new Vector3();
const tmpP = new Vector3();
const SPARK = new Color(1, 0.62, 0.22);
const GLINT = new Color(0.9, 0.97, 1);

/**
 * Cosmetic impact particles. Counts scale with the quality tier (they are pure decoration),
 * everything else in the game is identical on every tier.
 */
export class Particles {
  private readonly soft: Pool;
  private readonly bright: Pool;

  constructor(
    scene: Scene,
    private scale: number,
  ) {
    this.soft = new Pool(scene, Math.round(700 * Math.max(0.3, scale)), false);
    this.bright = new Pool(scene, Math.round(260 * Math.max(0.3, scale)), true);
  }

  /** Quality tier changed in Settings: emit more or fewer cosmetic particles (pools stay as built). */
  setScale(scale: number): void {
    this.scale = scale;
  }

  /** Keeps point sizes in world metres when the viewport or FOV changes. */
  resize(heightPx: number, fovDeg: number): void {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.soft.setScale(s);
    this.bright.setScale(s);
  }

  emit(kind: ParticleKind, at: Vector3, normal: Vector3, color: Color, count: number, energy: number): void {
    const n = Math.round(count * this.scale);
    const style = STYLES[kind];
    const pool = kind === "sparks" || kind === "glint" ? this.bright : this.soft;
    const strength = Math.min(1.6, 0.6 + Math.sqrt(energy) / 12);
    for (let i = 0; i < n; i++) {
      // Spray around the surface normal, never into the surface.
      tmpV.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (tmpV.dot(normal) < 0) tmpV.reflect(normal);
      tmpV.addScaledVector(normal, 0.8).normalize();
      tmpV.multiplyScalar((style.speed[0] + Math.random() * (style.speed[1] - style.speed[0])) * strength);
      tmpP.copy(at).addScaledVector(normal, 0.01);
      pool.spawn(kind, tmpP, tmpV, kind === "sparks" ? SPARK : kind === "glint" ? GLINT : color, kind === "dust" ? strength : 1);
    }
  }

  update(dt: number): void {
    this.soft.update(dt);
    this.bright.update(dt);
  }

  /** Makes the pools visible for one shader compile pass (warm-up), then hides them again. */
  setCompileVisible(visible: boolean): void {
    this.soft.points.visible = visible;
    this.bright.points.visible = visible;
  }
}
