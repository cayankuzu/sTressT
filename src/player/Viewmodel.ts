import { DirectionalLight, Euler, Group, HemisphereLight, MathUtils, Matrix4, Mesh, type PerspectiveCamera, Quaternion, Scene, type Texture, Vector3 } from "three";
import type { Assets } from "../core/assets";
import type { ToolAnimation, ToolDefinition } from "../data/types";

type Vec3 = [number, number, number];

/**
 * One key of a swing, in camera space (+X right, +Y up, -Z forward).
 * `pos` offsets the hand from its resting grip; `dir` is where the tool points (hand towards head);
 * `face` is where its striking face points (omitted = carried along from the resting grip).
 */
type Key = { pos: Vec3; dir: Vec3; face?: Vec3 };

/**
 * A swing: cock back (anticipation), whip into `contact` by the end of the windup (the hit resolves
 * on the first active frame, so the tool is visibly on target during hit-stop), then follow through.
 * `cock` is the share of the windup spent drawing back before the whip.
 */
type Motion = { cock: number; windup: Key; contact: Key; follow: Key };

export const MOTIONS: Record<ToolAnimation, Motion> = {
  punch: {
    cock: 0.6,
    windup: { pos: [0.03, -0.03, 0.08], dir: [0.2, 0.7, -0.68] },
    contact: { pos: [-0.1, 0.06, -0.3], dir: [0, 0.42, -0.9] },
    follow: { pos: [-0.12, 0.07, -0.34], dir: [-0.02, 0.4, -0.92] },
  },
  horizontal: {
    cock: 0.6,
    windup: { pos: [0.06, 0.14, 0.02], dir: [0.5, 0.8, 0.25], face: [-0.3, 0, -1] },
    contact: { pos: [0.06, 0.2, -0.12], dir: [-0.75, 0.1, -0.65], face: [-0.65, 0, 0.75] },
    follow: { pos: [-0.36, 0.04, 0], dir: [-0.8, -0.1, 0.45], face: [0.45, 0, 0.8] },
  },
  diagonal: {
    cock: 0.55,
    windup: { pos: [0.1, 0.2, 0.08], dir: [0.6, 0.75, 0.2], face: [-0.5, 0.2, -0.85] },
    contact: { pos: [-0.16, 0.16, -0.18], dir: [-0.45, 0.72, -0.5], face: [-0.3, -0.3, -0.9] },
    follow: { pos: [-0.34, -0.06, -0.08], dir: [-0.85, 0.1, -0.3], face: [-0.3, -0.7, 0.6] },
  },
  overhead: {
    cock: 0.55,
    windup: { pos: [0.02, 0.2, 0.04], dir: [0.1, 0.8, 0.6], face: [0, 0.6, -0.8] },
    contact: { pos: [-0.08, -0.02, -0.16], dir: [-0.25, 0.55, -0.8], face: [0, -0.5, -0.85] },
    follow: { pos: [-0.1, -0.16, -0.12], dir: [-0.2, 0.05, -0.98], face: [0, -1, 0] },
  },
  heavyOverhead: {
    cock: 0.6,
    windup: { pos: [-0.04, 0.24, 0.18], dir: [0.05, 0.7, 0.7], face: [0, 0.7, -0.7] },
    contact: { pos: [-0.14, 0.02, -0.1], dir: [-0.12, 0.42, -0.9], face: [0, -0.4, -0.9] },
    follow: { pos: [-0.14, -0.14, -0.06], dir: [-0.1, 0, -1], face: [0, -1, 0] },
  },
  hook: {
    cock: 0.55,
    windup: { pos: [0.06, 0.18, 0.06], dir: [0.25, 0.8, 0.55], face: [0, 0.55, -0.8] },
    contact: { pos: [-0.1, 0, -0.16], dir: [-0.3, 0.5, -0.8], face: [0, -0.5, -0.85] },
    follow: { pos: [-0.18, -0.14, -0.1], dir: [-0.3, 0, -0.95], face: [-0.1, -1, 0] },
  },
  jab: {
    cock: 0.55,
    windup: { pos: [0.08, 0.14, 0.06], dir: [0.45, 0.75, 0.45], face: [-0.4, 0.3, -0.85] },
    contact: { pos: [-0.06, 0, -0.16], dir: [-0.35, 0.5, -0.78], face: [-0.6, -0.6, -0.4] },
    follow: { pos: [-0.22, -0.14, -0.08], dir: [-0.6, -0.1, -0.8], face: [-0.5, -0.8, 0.3] },
  },
};

/** A key resolved for one tool: hand offset + holder rotation. */
type Pose = { pos: Vector3; rot: Quaternion };

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeIn = (t: number): number => t * t * t;
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

const v = (a: Vec3): Vector3 => new Vector3(...a).normalize();

/** Reflects a rotation across the camera's YZ plane (right hand → left hand). */
function mirrorQuat(q: Quaternion): Quaternion {
  return q.set(q.x, -q.y, -q.z, q.w);
}

/** Orthonormal basis with `y` along `dir` and `x` along `face` (made perpendicular). */
function basis(dir: Vector3, face: Vector3): Matrix4 {
  const y = dir.clone().normalize();
  const x = face.clone().addScaledVector(y, -face.dot(y)).normalize();
  const z = new Vector3().crossVectors(x, y);
  return new Matrix4().makeBasis(x, y, z);
}

/**
 * First-person tool rendering. Drawn in its own pass after the world with the depth buffer
 * cleared, so a bat never clips into a wall, and lit to match the world.
 */
export class Viewmodel {
  readonly scene = new Scene();
  private readonly pivot = new Group();
  private readonly holder = new Group();
  private readonly offhand = new Group();
  /** Left glove (fists only): a mirror image of the right hand that takes every other punch. */
  private readonly leftHolder = new Group();
  private leftTurn = true;
  private current: string | null = null;
  private tool: ToolDefinition | null = null;
  /** Hand position at rest (camera space). */
  private readonly hand = new Vector3();
  private readonly rest: Pose = { pos: new Vector3(), rot: new Quaternion() };
  private keys: { windup: Pose; contact: Pose; follow: Pose } | null = null;
  private cock = 0.6;
  /** Pose shown last frame, and the pose a stage started from (so stage changes never pop). */
  private readonly shown: Pose = { pos: new Vector3(), rot: new Quaternion() };
  private readonly from: Pose = { pos: new Vector3(), rot: new Quaternion() };
  private lastStage = "idle";
  private readonly mirrored: Pose = { pos: new Vector3(), rot: new Quaternion() };
  private bobTime = 0;
  /** 0 = ready, 1 = lowered out of the way (outside a break session, or hands full). */
  private lower = 0;
  private lowerTarget = 0;
  private readonly lowerQuat = new Quaternion();
  private swayX = 0;
  private swayY = 0;
  private loadToken = 0;
  /** Kick boot: hidden until a kick plays. `bootInner` holds the model-space correction. */
  private readonly boot = new Group();
  readonly bootInner = new Group();

  constructor(
    private readonly assets: Assets,
    environment: Texture | null,
  ) {
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.5;
    this.scene.add(new HemisphereLight(0xe9ecf2, 0x4a443e, 1.2));
    const key = new DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);
    this.pivot.add(this.holder);
    this.offhand.add(this.leftHolder);
    this.boot.add(this.bootInner);
    this.boot.visible = false;
    this.scene.add(this.pivot, this.offhand, this.boot);
    void this.loadBoot();
  }

  private async loadBoot(): Promise<void> {
    try {
      const model = await this.assets.model("boot");
      for (const part of model.parts) {
        const mesh = new Mesh(part.geometry, part.material);
        mesh.frustumCulled = false;
        // Pivot the boot at the ankle so it swings like a leg.
        mesh.position.y = -model.size.y * 0.85;
        this.bootInner.add(mesh);
      }
      // Sole towards the target, toe up, shaft back towards the knee: a front kick seen from the eyes.
      this.bootInner.rotation.set(MathUtils.degToRad(80), 0, 0);
    } catch (err) {
      console.warn("sTressT: kick boot failed to load (kicks still work)", err);
    }
  }

  /** Kick pose: from below the view, out along the view, and back. */
  updateKick(camera: PerspectiveCamera, stage: "idle" | "windup" | "active" | "recovery", phase: number): void {
    this.boot.visible = stage !== "idle";
    if (!this.boot.visible) return;
    const hidden = [0.13, -1.05, -0.28];
    const chambered = [0.12, -0.8, -0.42];
    const extended = [0.05, -0.46, -0.78];
    const lerp = (a: number[], b: number[], t: number): number[] => a.map((v, i) => v + ((b[i] as number) - v) * t);
    const p = stage === "windup" ? lerp(hidden, chambered, easeOut(phase)) : stage === "active" ? lerp(chambered, extended, easeOut(phase)) : lerp(extended, hidden, easeInOut(phase));
    this.boot.position.copy(camera.position);
    this.boot.quaternion.copy(camera.quaternion);
    this.boot.translateX(p[0] as number);
    this.boot.translateY(p[1] as number);
    this.boot.translateZ(p[2] as number);
  }

  /** Lowers the tool out of view (arrange/clean-up modes, carrying something). */
  setLowered(lowered: boolean): void {
    this.lowerTarget = lowered ? 1 : 0;
  }

  /** Forces the next setTool to rebuild (dev tuning). */
  reset(): void {
    this.current = null;
  }

  async setTool(toolId: string, tool: ToolDefinition): Promise<void> {
    if (this.current === toolId) return;
    this.current = toolId;
    this.tool = tool;
    const token = ++this.loadToken;
    const model = await this.assets.model(tool.model);
    if (token !== this.loadToken) return;
    this.holder.clear();
    this.leftHolder.clear();
    const vm = tool.viewmodel;
    const restRot = new Quaternion().setFromEuler(new Euler(MathUtils.degToRad(vm.rotation[0]), MathUtils.degToRad(vm.rotation[1]), MathUtils.degToRad(vm.rotation[2])));
    const make = (): Group => {
      const g = new Group();
      for (const part of model.parts) {
        const mesh = new Mesh(part.geometry, part.material);
        mesh.frustumCulled = false;
        g.add(mesh);
      }
      // The model sits relative to the hand, so every swing pivots in the grip.
      g.position.set(...(vm.offset ?? [0, 0, 0]));
      g.quaternion.copy(restRot);
      g.scale.setScalar(vm.scale);
      return g;
    };
    this.holder.add(make());
    this.hand.set(...vm.position);
    this.keys = this.resolveMotion(MOTIONS[tool.animation], restRot, v(vm.long ?? [0, 1, 0]), v(vm.face ?? [1, 0, 0]));
    this.cock = MOTIONS[tool.animation].cock;
    this.lastStage = "idle";
    this.shown.pos.set(0, 0, 0);
    this.shown.rot.identity();
    // The first punch is the right hand (the toggle runs at each windup).
    this.leftTurn = true;
    // Fists show both gloves; the left is a true mirror image (mesh and grip) and alternates.
    this.leftHolder.visible = tool.animation === "punch";
    if (tool.animation === "punch") {
      const left = make();
      left.position.x = -left.position.x;
      mirrorQuat(left.quaternion);
      left.scale.x = -left.scale.x;
      this.leftHolder.add(left);
    }
  }

  /**
   * Turns camera-space keys into holder rotations for this tool: the rotation that carries the
   * resting grip onto the key's direction/face, so authored motions work for any model.
   */
  private resolveMotion(motion: Motion, restRot: Quaternion, long: Vector3, face: Vector3): { windup: Pose; contact: Pose; follow: Pose } {
    const restDir = long.clone().applyQuaternion(restRot);
    const restFace = face.clone().applyQuaternion(restRot);
    const model = basis(long, face);
    const modelInv = model.clone().invert();
    const restInv = restRot.clone().invert();
    const resolve = (key: Key): Pose => {
      const dir = v(key.dir);
      const f = key.face ? v(key.face) : restFace.clone().applyQuaternion(new Quaternion().setFromUnitVectors(restDir, dir));
      // Absolute model orientation for the key, then relative to the resting grip.
      const target = new Quaternion().setFromRotationMatrix(basis(dir, f).multiply(modelInv));
      return { pos: new Vector3(...key.pos), rot: target.multiply(restInv) };
    };
    return { windup: resolve(motion.windup), contact: resolve(motion.contact), follow: resolve(motion.follow) };
  }

  private blend(a: Pose, b: Pose, t: number): void {
    this.shown.pos.lerpVectors(a.pos, b.pos, t);
    this.shown.rot.slerpQuaternions(a.rot, b.rot, t);
  }

  /**
   * phase: 0..1 progress within the stage; `stage` = idle | windup | active | recovery.
   * `impact` > 0 right after a hit: the follow-through bites and the tool kicks back.
   */
  update(camera: PerspectiveCamera, stage: "idle" | "windup" | "active" | "recovery", phase: number, impact: number, moveSpeed: number, look: { x: number; y: number }, dt: number): void {
    // Follow the camera exactly (this scene is rendered with the same camera).
    this.pivot.position.copy(camera.position);
    this.pivot.quaternion.copy(camera.quaternion);
    this.offhand.position.copy(camera.position);
    this.offhand.quaternion.copy(camera.quaternion);
    if (!this.tool || !this.keys) return;

    if (stage !== this.lastStage) {
      this.from.pos.copy(this.shown.pos);
      this.from.rot.copy(this.shown.rot);
      // Fists alternate hands; the fresh hand starts from its guard.
      if (stage === "windup" && this.leftHolder.visible) {
        this.leftTurn = !this.leftTurn;
        this.from.pos.set(0, 0, 0);
        this.from.rot.identity();
      }
      this.lastStage = stage;
    }
    const k = this.keys;
    if (stage === "idle") this.blend(this.rest, this.rest, 0);
    else if (stage === "windup") {
      if (phase < this.cock) this.blend(this.from, k.windup, easeOut(phase / this.cock));
      else this.blend(k.windup, k.contact, easeIn((phase - this.cock) / (1 - this.cock)));
    } else if (stage === "active") this.blend(k.contact, k.follow, easeOut(phase) * (1 - 0.5 * impact));
    else this.blend(this.from, this.rest, easeInOut(phase));

    // Idle sway and walk bob keep the tool alive without moving it much.
    this.bobTime += dt * (1 + moveSpeed * 1.6);
    this.swayX = MathUtils.damp(this.swayX, MathUtils.clamp(-look.x * 0.0004, -0.03, 0.03), 10, dt);
    this.swayY = MathUtils.damp(this.swayY, MathUtils.clamp(look.y * 0.0004, -0.03, 0.03), 10, dt);
    const bob = Math.min(1, moveSpeed / 3.4);
    const bx = Math.sin(this.bobTime * 4.2) * 0.006 * bob + this.swayX;
    const by = Math.abs(Math.sin(this.bobTime * 4.2)) * 0.008 * bob + Math.sin(this.bobTime * 1.3) * 0.0025 + this.swayY;
    const recoil = impact * 0.03;
    this.lower = MathUtils.damp(this.lower, this.lowerTarget, 9, dt);
    const ly = -this.lower * 0.36;
    const lz = this.lower * 0.08;
    this.lowerQuat.setFromEuler(new Euler(-this.lower * 0.55, 0, 0));
    this.pivot.visible = this.lower < 0.98;
    this.offhand.visible = this.lower < 0.98;

    // Only fists take turns: every other tool swings in the right hand every time.
    const leftSwings = this.leftHolder.visible && this.leftTurn;
    const right = leftSwings ? this.rest : this.shown;
    this.holder.position.set(this.hand.x + right.pos.x + bx, this.hand.y + right.pos.y + by + ly, this.hand.z + right.pos.z + lz + (leftSwings ? 0 : recoil));
    this.holder.quaternion.copy(this.lowerQuat).multiply(right.rot);
    if (this.leftHolder.visible) {
      const left = this.mirrored;
      if (leftSwings) {
        left.pos.set(-this.shown.pos.x, this.shown.pos.y, this.shown.pos.z);
        mirrorQuat(left.rot.copy(this.shown.rot));
      } else {
        left.pos.set(0, 0, 0);
        left.rot.identity();
      }
      this.leftHolder.position.set(-this.hand.x + left.pos.x - bx, this.hand.y + left.pos.y + by * 0.7 + ly, this.hand.z + left.pos.z + lz + (this.leftTurn ? recoil : 0));
      this.leftHolder.quaternion.copy(this.lowerQuat).multiply(left.rot);
    }
  }
}
