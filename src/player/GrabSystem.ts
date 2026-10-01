import RAPIER, { type RigidBody, type World } from "@dimforge/rapier3d";
import { type PerspectiveCamera, Vector3 } from "three";
import { COLLISION, GAME, groups } from "../config/gameConfig";
import type { DestructionSystem } from "../destruction/DestructionSystem";
import type { Destructible } from "../destruction/Destructible";
import type { Fragment } from "../destruction/Debris";

const G = GAME.interaction;
/** Further than this from the hold point for longer than STUCK_SECONDS = snagged: it is dropped. */
const BREAK_DISTANCE = 1.2;
const STUCK_SECONDS = 0.5;
const THROW_CCD_SECONDS = 2;
/** What the grab ray can see: solid things only, never the player. */
const LOOK_FILTER = groups(0xffff, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS | COLLISION.DEBRIS_SMALL);

export type GrabTarget = { kind: "object"; obj: Destructible } | { kind: "fragment"; frag: Fragment };
/** `blocked`: why it cannot be taken ("heavy" pieces can be broken smaller first). */
export type LookResult = { target: GrabTarget; mass: number; grabbable: boolean; blocked: "heavy" | "heavyPiece" | "fixed" | null; distance: number };

const forward = new Vector3();
const holdPoint = new Vector3();
const tmp = new Vector3();

/**
 * Physics grab: the held body stays fully simulated and is pulled towards a point in front of the
 * camera by a clamped velocity spring (never parented, never teleported). It collides with the
 * world while carried, can be swung into things, and is thrown with a real impulse. One thing at
 * a time.
 */
export class GrabSystem {
  private held: GrabTarget | null = null;
  private body: RigidBody | null = null;
  private ccdTimers = new Map<RigidBody, number>();
  private stuck = 0;
  private holdExtra = 0;
  onThrow: (target: GrabTarget, mass: number) => void = () => undefined;
  onGrab: (target: GrabTarget) => void = () => undefined;
  /** True outside break mode: a carried object must not knock the room over. */
  gentle: () => boolean = () => false;

  constructor(
    private readonly world: World,
    private readonly camera: PerspectiveCamera,
    private readonly destruction: DestructionSystem,
    private readonly playerCollider: RAPIER.Collider,
  ) {}

  get holding(): boolean {
    return this.held !== null;
  }

  get target(): GrabTarget | null {
    return this.held;
  }

  get heldMass(): number {
    if (!this.held) return 0;
    return this.held.kind === "object" ? this.held.obj.mass : this.held.frag.mass;
  }

  /** What the crosshair is on, for prompts ("E TOPLA", "ÇOK AĞIR"). Clutter is not offered. */
  look(): LookResult | null {
    this.camera.getWorldDirection(forward);
    const hit = this.world.castRay(new RAPIER.Ray(this.camera.position, forward), G.grabReach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, LOOK_FILTER, this.playerCollider);
    if (!hit) return null;
    const owner = this.destruction.ownerOf(hit.collider);
    if (owner?.kind === "object") {
      const def = owner.obj.template.def;
      const heavy = def.mass > G.maxCarryMass;
      const grabbable = def.capabilities.grabbable && !heavy && owner.obj.alive;
      return { target: { kind: "object", obj: owner.obj }, mass: def.mass, grabbable, blocked: grabbable ? null : heavy ? "heavy" : "fixed", distance: hit.timeOfImpact };
    }
    const frag = this.destruction.debris.byCollider(hit.collider.handle);
    if (!frag || frag.kind !== "major" || !frag.body || frag.state === "disposed" || frag.state === "lost") return null;
    const heavy = frag.mass > G.maxGrabMass;
    return { target: { kind: "fragment", frag }, mass: frag.mass, grabbable: !heavy, blocked: heavy ? "heavyPiece" : null, distance: hit.timeOfImpact };
  }

  grab(target: GrabTarget): boolean {
    if (this.held) return false;
    const body = target.kind === "object" ? target.obj.body : target.frag.body;
    if (!body || !body.isEnabled()) return false;
    if (target.kind === "fragment" && !this.destruction.debris.setState(target.frag, "held")) return false;
    this.held = target;
    this.body = body;
    if (target.kind === "object") {
      target.obj.setHeld(true);
      // Big furniture is carried further out so it does not fill the screen.
      const [sx, sy, sz] = target.obj.template.size;
      this.holdExtra = Math.max(0, Math.max(sx, sy, sz) * 0.55 - 0.25);
    } else this.holdExtra = 0;
    body.wakeUp();
    body.setAngularDamping(4);
    // Arranging and cleaning up: what you carry bumps into things but cannot shove them away
    // (lower dominance: the others act as immovable to it). While breaking, it hits for real.
    body.setDominanceGroup(this.gentle() ? -1 : 0);
    this.stuck = 0;
    this.onGrab(target);
    return true;
  }

  /** Lets go without throwing (the object keeps its current motion). */
  release(): void {
    const held = this.held;
    const body = this.body;
    this.held = null;
    this.body = null;
    if (!held) return;
    if (held.kind === "object") {
      if (held.obj.body) held.obj.setHeld(false);
    } else this.destruction.debris.setState(held.frag, "active");
    if (body && this.bodyAlive(body)) {
      body.setAngularDamping(held.kind === "object" ? 0.12 : 0.2);
      body.setDominanceGroup(0);
    }
  }

  /** Throws along the view, adding the player's own velocity. Returns the throw speed. */
  throw(playerVelocity: Vector3): number {
    const body = this.body;
    const held = this.held;
    if (!body || !held) return 0;
    const mass = this.heldMass;
    this.release();
    if (!this.bodyAlive(body)) return 0;
    this.camera.getWorldDirection(forward);
    // A fixed impulse budget: light things fly fast, heavy things barely leave the hands.
    const speed = Math.min(G.throwSpeedMax, G.throwImpulse / Math.max(0.05, mass));
    body.setLinvel(
      { x: forward.x * speed + playerVelocity.x, y: forward.y * speed + Math.max(0, playerVelocity.y) + 0.8, z: forward.z * speed + playerVelocity.z },
      true,
    );
    body.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 }, true);
    // A thrown object is player-caused (full damage) and gets CCD so it can't tunnel through walls.
    if (held.kind === "object") held.obj.generation = 0;
    else {
      held.frag.generation = 0;
      this.destruction.debris.setState(held.frag, "thrown");
    }
    body.enableCcd(true);
    this.ccdTimers.set(body, THROW_CCD_SECONDS);
    this.onThrow(held, mass);
    return speed;
  }

  /**
   * Identity check, not `bodies.contains`: Rapier's JS set looks handles up by index only, so a
   * removed body's handle "exists" again once a new body reuses the slot, and touching it panics.
   */
  private bodyAlive(body: RigidBody): boolean {
    return this.world.bodies.get(body.handle) === body;
  }

  /** Physics step: pull the held body towards the hold point. */
  fixedUpdate(dt: number): void {
    for (const [body, t] of this.ccdTimers) {
      const left = t - dt;
      if (left <= 0 || !this.bodyAlive(body)) {
        if (this.bodyAlive(body)) body.enableCcd(false);
        this.ccdTimers.delete(body);
      } else this.ccdTimers.set(body, left);
    }
    const body = this.body;
    const held = this.held;
    if (!body || !held) return;
    const alive = held.kind === "object" ? held.obj.alive : held.frag.body !== null && held.frag.state === "held";
    if (!alive || !this.bodyAlive(body)) {
      // It broke (or was disposed of) in our hands.
      this.held = null;
      this.body = null;
      return;
    }
    this.camera.getWorldDirection(forward);
    const heavy = Math.min(1, this.heldMass / G.maxCarryMass);
    holdPoint
      .copy(this.camera.position)
      .addScaledVector(forward, G.holdDistance + this.holdExtra)
      .add(tmp.set(0, -0.15 - heavy * 0.35 - this.holdExtra * 0.4, 0));
    const t = body.translation();
    tmp.set(holdPoint.x - t.x, holdPoint.y - t.y, holdPoint.z - t.z);
    const dist = tmp.length();
    this.stuck = dist > BREAK_DISTANCE + this.holdExtra ? this.stuck + dt : 0;
    if (this.stuck > STUCK_SECONDS) {
      this.release();
      return;
    }
    // Heavier objects lag more behind the hand.
    const stiffness = G.holdStiffness / (1 + this.heldMass * 0.08);
    tmp.multiplyScalar(stiffness);
    const speed = tmp.length();
    const maxSpeed = G.maxHoldSpeed * (1 - heavy * 0.55);
    if (speed > maxSpeed) tmp.multiplyScalar(maxSpeed / speed);
    body.setLinvel({ x: tmp.x, y: tmp.y, z: tmp.z }, true);
    const av = body.angvel();
    const damp = held.kind === "object" ? 0.7 : 0.85;
    body.setAngvel({ x: av.x * damp, y: av.y * damp, z: av.z * damp }, true);
  }
}
