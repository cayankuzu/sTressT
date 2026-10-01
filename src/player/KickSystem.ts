import type { Collider, World } from "@dimforge/rapier3d";
import { type PerspectiveCamera, Vector3 } from "three";
import { GAME } from "../config/gameConfig";
import { type Impact, kineticEnergy } from "../destruction/damage";
import type { DestructionSystem } from "../destruction/DestructionSystem";
import type { AttackStage } from "./ToolSystem";
import { findStrikeTarget } from "./strike";

const K = GAME.kick;
/** Kick attack ids live in their own range so they never collide with tool swing ids. */
const KICK_ID_BASE = 1_000_000;

const forward = new Vector3();
const origin = new Vector3();

/**
 * Front kick on its own timeline (right mouse / V). Launches loose objects and debris, tips
 * furniture over, barely scratches anything tough: the chaos button.
 */
export class KickSystem {
  stage: AttackStage = "idle";
  phase = 0;
  impact = 0;
  private stageTime = 0;
  private resolved = false;
  private nextId = KICK_ID_BASE;
  canKick: () => boolean = () => true;
  onKick: (hit: boolean, energy: number) => void = () => undefined;
  onStart: () => void = () => undefined;

  constructor(
    private readonly world: World,
    private readonly camera: PerspectiveCamera,
    private readonly destruction: DestructionSystem,
    private readonly playerCollider: Collider,
  ) {}

  update(dt: number, pressed: boolean): void {
    this.impact = Math.max(0, this.impact - dt * 5);
    if (pressed && this.stage === "idle" && this.canKick()) {
      this.stage = "windup";
      this.stageTime = 0;
      this.phase = 0;
      this.resolved = false;
      this.onStart();
    }
    if (this.stage === "idle") return;
    this.stageTime += dt;
    const duration = this.stage === "windup" ? K.windup : this.stage === "active" ? K.active : K.recovery;
    this.phase = Math.min(1, this.stageTime / duration);
    if (this.stage === "active" && !this.resolved) {
      this.resolved = true;
      this.resolve();
    }
    if (this.phase < 1) return;
    this.stageTime = 0;
    this.phase = 0;
    this.stage = this.stage === "windup" ? "active" : this.stage === "active" ? "recovery" : "idle";
  }

  private resolve(): void {
    this.camera.getWorldDirection(forward);
    // Kicks travel from the hip, angled a little lower than the view.
    forward.y = Math.min(forward.y, 0.35) - 0.12;
    forward.normalize();
    origin.copy(this.camera.position);
    origin.y -= K.hipDrop;
    const target = findStrikeTarget(this.world, origin, forward, K.reach, K.radius, this.playerCollider, (c) => this.destruction.ownerOf(c) !== undefined || this.destruction.debris.byCollider(c.handle) !== undefined);
    const energy = kineticEnergy(K.effectiveMass, K.speed);
    if (!target) {
      this.onKick(false, 0);
      return;
    }
    const impact: Impact = {
      point: [target.point.x, target.point.y, target.point.z],
      normal: [target.normal.x, target.normal.y, target.normal.z],
      dir: [forward.x, forward.y + 0.15, forward.z],
      energy,
      impulse: K.impulse,
      maxDeltaV: K.maxDeltaV,
      contactRadius: K.contactRadius,
      affinity: 1,
      affinityMap: K.affinity,
      source: "tool",
      generation: 0,
      attackId: this.nextId++,
    };
    this.destruction.applyHit(target.collider, impact);
    this.impact = 1;
    this.onKick(true, energy);
  }
}
