import { CanvasTexture, Color, DoubleSide, MeshBasicMaterial, type MeshStandardMaterial, SRGBColorSpace, type Texture } from "three";
import { Rng } from "../core/rng";

const fragmentCache = new Map<string, MeshStandardMaterial>();

/**
 * Material for broken pieces: same look outside, but faces seen from behind (the open cut
 * surface) are shaded with the material's interior colour. That replaces cap geometry, costs one
 * shader branch, and looks right for both solid chunks and thin ceramic shells.
 */
export function fragmentMaterial(source: MeshStandardMaterial, interiorColor: string): MeshStandardMaterial {
  const key = `${source.uuid}|${interiorColor}`;
  const cached = fragmentCache.get(key);
  if (cached) return cached;
  const material = source.clone();
  material.side = DoubleSide;
  const interior = new Color(interiorColor);
  if (!source.transparent) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.interiorColor = { value: interior };
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform vec3 interiorColor;")
        .replace("#include <map_fragment>", "#include <map_fragment>\nif (!gl_FrontFacing) { diffuseColor.rgb = interiorColor; }");
    };
    material.customProgramCacheKey = () => "stresst-interior";
  }
  fragmentCache.set(key, material);
  return material;
}

let crackAtlas: Texture | null = null;

/** 2x2 atlas of procedurally drawn radial crack patterns (white lines on transparent). */
export function getCrackAtlas(): Texture {
  if (crackAtlas) return crackAtlas;
  const size = 512;
  const half = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let v = 0; v < 4; v++) drawCrack(ctx, (v % 2) * half, Math.floor(v / 2) * half, half, new Rng(1337 + v * 101));
  }
  crackAtlas = new CanvasTexture(canvas);
  crackAtlas.colorSpace = SRGBColorSpace;
  return crackAtlas;
}

function drawCrack(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number, rng: Rng): void {
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, size, size);
  ctx.clip();
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const branch = (x: number, y: number, angle: number, length: number, width: number, depth: number): void => {
    let px = x;
    let py = y;
    const steps = 6 + Math.floor(rng.next() * 5);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(px, py);
    for (let i = 0; i < steps; i++) {
      angle += rng.range(-0.45, 0.45);
      const seg = length / steps;
      px += Math.cos(angle) * seg;
      py += Math.sin(angle) * seg;
      ctx.lineTo(px, py);
      if (depth < 2 && rng.next() < 0.22) branch(px, py, angle + rng.range(-1, 1), length * 0.45, width * 0.6, depth + 1);
    }
    ctx.stroke();
  };
  const rays = 6 + Math.floor(rng.next() * 4);
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 + rng.range(-0.3, 0.3);
    branch(cx, cy, a, size * rng.range(0.28, 0.46), rng.range(2, 3.4), 0);
  }
  // Concentric fracture rings near the impact.
  ctx.lineWidth = 1.4;
  for (let ring = 0; ring < 2; ring++) {
    const r = size * (0.08 + ring * 0.09);
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 2; a += rng.range(0.35, 0.8)) {
      const rr = r * rng.range(0.85, 1.15);
      const x = cx + Math.cos(a) * rr;
      const y = cy + Math.sin(a) * rr;
      if (rng.next() < 0.35) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Crushed centre.
  ctx.fillStyle = "rgba(255,255,255,0.8)";
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.025, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

let scuffAtlas: Texture | null = null;

/**
 * 2x2 atlas of impact scuffs for materials that dent rather than crack: a crushed centre, a
 * ring of compression and short scrape streaks along the blow.
 */
export function getScuffAtlas(): Texture {
  if (scuffAtlas) return scuffAtlas;
  const size = 512;
  const half = size / 2;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let v = 0; v < 4; v++) drawScuff(ctx, (v % 2) * half, Math.floor(v / 2) * half, half, new Rng(4242 + v * 77));
  }
  scuffAtlas = new CanvasTexture(canvas);
  scuffAtlas.colorSpace = SRGBColorSpace;
  return scuffAtlas;
}

function drawScuff(ctx: CanvasRenderingContext2D, ox: number, oy: number, size: number, rng: Rng): void {
  const cx = ox + size / 2;
  const cy = oy + size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, size, size);
  ctx.clip();
  // Soft crushed centre.
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.22);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(0.55, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.22, 0, Math.PI * 2);
  ctx.fill();
  // Scrape streaks in one dominant direction.
  const angle = rng.range(0, Math.PI);
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineCap = "round";
  const streaks = 7 + Math.floor(rng.next() * 6);
  for (let i = 0; i < streaks; i++) {
    const off = rng.range(-0.16, 0.16) * size;
    const len = rng.range(0.12, 0.34) * size;
    const a = angle + rng.range(-0.12, 0.12);
    const sx = cx + Math.cos(a + Math.PI / 2) * off - (Math.cos(a) * len) / 2;
    const sy = cy + Math.sin(a + Math.PI / 2) * off - (Math.sin(a) * len) / 2;
    ctx.lineWidth = rng.range(1, 3);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(a) * len, sy + Math.sin(a) * len);
    ctx.stroke();
  }
  // Compression ring.
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.45)";
  ctx.beginPath();
  ctx.arc(cx, cy, size * rng.range(0.13, 0.18), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

const decalCache = new Map<string, MeshBasicMaterial>();

/** Unlit mark material: dark cracks on opaque materials, bright cracks on glass, soft scuffs on the rest. */
export function decalMaterial(kind: "crack" | "glass" | "scuff"): MeshBasicMaterial {
  const cached = decalCache.get(kind);
  if (cached) return cached;
  const material = new MeshBasicMaterial({
    map: kind === "scuff" ? getScuffAtlas() : getCrackAtlas(),
    color: kind === "glass" ? 0xf4fbff : kind === "scuff" ? 0x1b1714 : 0x17130f,
    transparent: true,
    opacity: kind === "glass" ? 0.85 : kind === "scuff" ? 0.62 : 0.78,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  decalCache.set(kind, material);
  return material;
}

/** @deprecated name kept for the warm-up code: crack material for glass or solid surfaces. */
export function crackMaterial(glass: boolean): MeshBasicMaterial {
  return decalMaterial(glass ? "glass" : "crack");
}
