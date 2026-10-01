import type { Collider, World } from "@dimforge/rapier3d";
import { type PerspectiveCamera, Vector3 } from "three";
import type { EventBus } from "../core/events";
import { getTool } from "../data/catalog";
import type { ToolDefinition } from "../data/types";
import { impactLevel, type Impact, kineticEnergy } from "../destruction/damage";
import type { DestructionSystem } from "../destruction/DestructionSystem";
import { findStrikeTarget } from "./strike";

export type AttackStage = "idle" | "windup" | "active" | "recovery";

export type HitReport = { hit: boolean; energy: number; level: "light" | "medium" | "heavy" };
/** Last contact, for the debug overlay. */
export type HitInfo = { point: Vector3; speed: number; energy: number; targets: number };

const HIT_STOP_BASE = 0.035;
const QUEUE_WINDOW = 0.5;

const forward = new Vector3();
const right = new Vector3();
const up = new Vector3();

/**
 * Melee attacks as a timeline: wind-up, contact window, recovery. Damage is resolved at the
 * contact moment with a physics query from the eye along the view (ray, then a swept sphere as
 * wide as the tool), never at button-down and never by distance alone.
 */
export class ToolSystem {
  toolId = "fists";
  tool: ToolDefinition = getTool("fists");
  stage: AttackStage = "idle";
  /** 0..1 progress in the current stage. */
  phase = 0;
  /** Contact feedback strength (decays), drives hit-stop and recoil. */
  impact = 0;
  private stageTime = 0;
  private queued = false;
  private resolved = false;
  private hitStop = 0;
  private nextAttackId = 1;
  onHit: (report: HitReport) => void = () => undefined;
  lastHit: HitInfo | null = null;
  /** Player velocity at the swing (running into a hit adds to it). */
  playerVelocity: () => Vector3 = () => new Vector3();
  /** Lets the game veto attacks (holding an object, arrange mode...). */
  canAttack: () => boolean = () => true;

  constructor(
    private readonly world: World,
    private readonly camera: PerspectiveCamera,
    private readonly destruction: DestructionSystem,
    private readonly events: EventBus,
    private readonly playerCollider: Collider,
  ) {}

  /** Objects and loose pieces: what a swing should connect with when it passes close by. */
  private readonly breakable = (c: Collider): boolean => this.destruction.ownerOf(c) !== undefined || this.destruction.debris.byCollider(c.handle) !== undefined;

  equip(toolId: string): void {
    this.toolId = toolId;
    this.tool = getTool(toolId);
    this.stage = "idle";
    this.phase = 0;
    this.queued = false;
  }

  /** `attackPressed` is the edge for this frame. */
  update(dt: number, attackPressed: boolean): void {
    if (attackPressed && this.canAttack()) {
      if (this.stage === "idle") this.begin();
      else if (this.stage === "recovery" && this.phase > 1 - QUEUE_WINDOW) this.queued = true;
    }
    this.impact = Math.max(0, this.impact - dt * 6);
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      return;
    }
    if (this.stage === "idle") return;

    this.stageTime += dt;
    const duration = this.stage === "windup" ? this.tool.windup : this.stage === "active" ? this.tool.active : this.tool.recovery;
    this.phase = Math.min(1, this.stageTime / duration);

    if (this.stage === "active" && !this.resolved) {
      this.resolved = true;
      this.resolve();
    }
    if (this.phase < 1) return;
    this.stageTime = 0;
    this.phase = 0;
    if (this.stage === "windup") this.stage = "active";
    else if (this.stage === "active") this.stage = "recovery";
    else if (this.queued && this.canAttack()) this.begin();
    else this.stage = "idle";
  }

  private begin(): void {
    this.stage = "windup";
    this.stageTime = 0;
    this.phase = 0;
    this.queued = false;
    this.resolved = false;
    this.events.emit("ATTACK_STARTED", { toolId: this.toolId, attackId: this.nextAttackId });
  }

  /** The contact moment: find what the tool actually strikes and hit it. */
  private resolve(): void {
    const tool = this.tool;
    const attackId = this.nextAttackId++;
    this.camera.getWorldDirection(forward);
    right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    const origin = this.camera.position;
    const reach = tool.reach;

    const target = findStrikeTarget(this.world, origin, forward, reach, tool.contactRadius + 0.06, this.playerCollider, this.breakable);
    if (!target) {
      this.onHit({ hit: false, energy: 0, level: "light" });
      return;
    }
    const { collider, point, normal } = target;

    // Force direction: mostly into the view, bent by the swing (a bat sweeps sideways, a hammer comes down).
    const dir = forward
      .clone()
      .addScaledVector(right, tool.sweep[0] * 0.45)
      .addScaledVector(up, tool.sweep[1] * 0.45)
      .normalize();
    // Relative speed: the swing plus whatever the body brings into it (never subtracts).
    const speed = tool.swingSpeed + Math.min(3, Math.max(0, this.playerVelocity().dot(dir)));
    const energy = kineticEnergy(tool.effectiveMass, speed);
    const impact: Impact = {
      point: [point.x, point.y, point.z],
      normal: [normal.x, normal.y, normal.z],
      dir: [dir.x, dir.y, dir.z],
      energy,
      // Most of the energy goes into breaking; only a share becomes push.
      impulse: tool.effectiveMass * speed * 0.28,
      contactRadius: tool.contactRadius,
      affinity: 1,
      affinityMap: tool.affinity,
      source: "tool",
      generation: 0,
      attackId,
      toolId: this.toolId,
    };
    this.destruction.applyHit(collider, impact);
    const targets = 1 + this.sweepArc(origin, forward, dir, reach, collider, impact);
    this.lastHit = { point: point.clone(), speed, energy, targets };
    const level = impactLevel(energy);
    this.impact = 1;
    this.hitStop = HIT_STOP_BASE * (level === "heavy" ? 2 : level === "medium" ? 1.4 : 1);
    this.onHit({ hit: true, energy, level });
  }

  /**
   * Wide swings (bat, pan, wrench) can catch a second thing along their arc: rays across the
   * swing plane, each distinct body struck once, with the energy left after the first contact.
   */
  private sweepArc(origin: Vector3, forward: Vector3, dir: Vector3, reach: number, primary: Collider, impact: Impact): number {
    const width = Math.abs(this.tool.sweep[0]);
    if (width < 0.4) return 0;
    const primaryBody = primary.parent()?.handle;
    const struck = new Set<number>(primaryBody !== undefined ? [primaryBody] : []);
    let extra = 0;
    for (const side of [1, -1]) {
      const sample = forward.clone().addScaledVector(right, side * 0.32 * width).normalize();
      const target = findStrikeTarget(this.world, origin, sample, reach * 0.92, this.tool.contactRadius, this.playerCollider);
      const body = target?.collider.parent()?.handle;
      if (!target || body === undefined || struck.has(body) || !this.destruction.ownerOf(target.collider)) continue;
      struck.add(body);
      this.destruction.applyHit(target.collider, {
        ...impact,
        point: [target.point.x, target.point.y, target.point.z],
        normal: [target.normal.x, target.normal.y, target.normal.z],
        dir: [dir.x, dir.y, dir.z],
        energy: impact.energy * 0.55,
        impulse: impact.impulse * 0.55,
      });
      if (++extra >= 2) break;
    }
    return extra;
  }
}
