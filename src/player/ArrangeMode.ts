import RAPIER, { type Shape, type World } from "@dimforge/rapier3d";
import { Box3, BoxGeometry, EdgesGeometry, Euler, LineBasicMaterial, LineSegments, type PerspectiveCamera, Quaternion, type Scene, Vector3 } from "three";
import { COLLISION, groups } from "../config/gameConfig";
import type { Input } from "../core/input";
import type { Destructible } from "../destruction/Destructible";
import type { DestructionSystem } from "../destruction/DestructionSystem";
import { ROOM, ROOM_DOOR, STREET, isInRoom } from "../world/layout";

const REACH = 6;
const ROTATE_STEP = 15;
const FREE_ROTATE_SPEED = 90;
/** How far below/above the aimed surface the magnet looks for the real support. */
const MAGNET = 0.25;
/** Objects must stay this far inside the room walls. */
const WALL_MARGIN = 0.02;
/** Floor area in front of the door that must stay walkable. */
const DOOR_CLEAR = { halfWidth: 0.85, depth: 1.1 };

/** The doorway zone as a box (debug view). */
export function doorClearance(): Box3 {
  const doorX = ROOM.origin[0] + ROOM_DOOR.x;
  const front = STREET.northFacadeZ - STREET.facadeThickness;
  return new Box3(new Vector3(doorX - DOOR_CLEAR.halfWidth, 0, front - DOOR_CLEAR.depth), new Vector3(doorX + DOOR_CLEAR.halfWidth, 0.4, front));
}

/** Everything solid (props, debris, walls) plus the player: a ghost may not end up inside any of it. */
const PLACEMENT_FILTER = groups(0xffff, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS | COLLISION.DEBRIS_SMALL | COLLISION.PLAYER);
const SURFACE_FILTER = groups(0xffff, COLLISION.WORLD | COLLISION.PROP);

export type PlacementProblem = "blocked" | "support" | "outside" | "door" | "player" | "full";

/** One collider of a ghost, relative to its body: placement is tested with the real shapes. */
type GhostShape = { shape: Shape; offset: Vector3; rotation: Quaternion };

/** Something standing on the picked object: it travels with it, keeping its place on top. */
type Passenger = {
  obj: Destructible;
  localPos: Vector3;
  localQuat: Quaternion;
  startPos: Vector3;
  startQuat: Quaternion;
  shapes: GhostShape[];
  pos: Vector3;
  quat: Quaternion;
};

type Placing = {
  obj: Destructible;
  /** Came out of storage (cancel puts it back there) rather than being moved in the room. */
  fromStorage: boolean;
  startPos: Vector3;
  startQuat: Quaternion;
  shapes: GhostShape[];
  passengers: Passenger[];
  yaw: number;
  pos: Vector3;
  hasTarget: boolean;
  problem: PlacementProblem | null;
};

/** The overlap test lifts the ghost this much, so resting on its support is not an overlap. */
const SUPPORT_CLEARANCE = 0.012;
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();

function ghostShapes(obj: Destructible): GhostShape[] {
  const shapes: GhostShape[] = [];
  for (const part of obj.parts) {
    const c = part.collider;
    if (!c) continue;
    const t = c.translationWrtParent();
    const r = c.rotationWrtParent();
    shapes.push({ shape: c.shape, offset: new Vector3(t?.x ?? 0, t?.y ?? 0, t?.z ?? 0), rotation: new Quaternion(r?.x ?? 0, r?.y ?? 0, r?.z ?? 0, r?.w ?? 1) });
  }
  return shapes;
}

export type ArrangeState = { hovered: Destructible | null; placing: Destructible | null; problem: PlacementProblem | null };

const COLORS = { hover: 0xf2ede4, valid: 0xe0b03a, invalid: 0xb85a50 };
const forward = new Vector3();
const down = { x: 0, y: -1, z: 0 };

/**
 * Arrange mode (DÜZENLE). Pick an object (LMB): it becomes a ghost, removed from the physics
 * simulation, so it can never push or be pushed by anything while it moves. It follows the
 * crosshair over upward surfaces and a magnet seats it exactly on the real support underneath
 * (floor, table top, cabinet top) when the support is wide enough. LMB commits (only where it
 * fits, rests on something and keeps the door clear), RMB/Esc cancels and puts it back. Committed
 * objects return to physics already at rest: nothing jumps, nothing nearby moves.
 */
export class ArrangeMode {
  private readonly outline: LineSegments;
  private readonly outlineMaterial = new LineBasicMaterial({ color: COLORS.hover, transparent: true, opacity: 0.85, depthTest: true });
  private hovered: Destructible | null = null;
  private placing: Placing | null = null;
  /** Whether the room has space for one more object (set by the game). */
  roomHasSpace: () => boolean = () => true;
  onCommit: (obj: Destructible, fromStorage: boolean) => void = () => undefined;
  onCancelStorage: (obj: Destructible) => void = () => undefined;
  onStore: (obj: Destructible) => void = () => undefined;

  constructor(
    scene: Scene,
    private readonly world: World,
    private readonly camera: PerspectiveCamera,
    private readonly destruction: DestructionSystem,
    private readonly playerCollider: RAPIER.Collider,
  ) {
    this.outline = new LineSegments(new EdgesGeometry(new BoxGeometry(1, 1, 1)), this.outlineMaterial);
    this.outline.visible = false;
    this.outline.renderOrder = 3;
    scene.add(this.outline);
  }

  get busy(): boolean {
    return this.placing !== null;
  }

  get state(): ArrangeState {
    return { hovered: this.hovered, placing: this.placing?.obj ?? null, problem: this.placing?.problem ?? null };
  }

  /** Starts placing an object (picked in the room, carried in, or taken from storage). */
  begin(obj: Destructible, fromStorage: boolean): void {
    if (this.placing || !obj.alive) return;
    const euler = new Euler().setFromQuaternion(obj.currQuat, "YXZ");
    // Whatever stands on it comes along (a cup on a table); anything else touching it is woken so
    // it reacts to the table leaving instead of hanging in the air.
    const passengers = fromStorage ? [] : this.passengersOf(obj);
    this.destruction.wakeTouching(obj, passengers);
    for (const other of passengers) this.destruction.wakeTouching(other, [obj, ...passengers]);
    const inv = obj.currQuat.clone().invert();
    const riders: Passenger[] = passengers.map((other) => ({
      obj: other,
      localPos: other.currPos.clone().sub(obj.currPos).applyQuaternion(inv),
      localQuat: inv.clone().multiply(other.currQuat),
      startPos: other.currPos.clone(),
      startQuat: other.currQuat.clone(),
      shapes: ghostShapes(other),
      pos: other.currPos.clone(),
      quat: other.currQuat.clone(),
    }));
    const shapes = ghostShapes(obj);
    obj.setGhost(true);
    // Until it is committed, a save sees it where it was (or not at all, if it came from storage).
    obj.savePose = fromStorage ? null : { pos: obj.currPos.clone(), quat: obj.currQuat.clone() };
    obj.transient = fromStorage;
    for (const r of riders) {
      r.obj.setGhost(true);
      r.obj.savePose = { pos: r.startPos.clone(), quat: r.startQuat.clone() };
    }
    this.placing = {
      obj,
      fromStorage,
      startPos: obj.currPos.clone(),
      startQuat: obj.currQuat.clone(),
      shapes,
      passengers: riders,
      yaw: (euler.y * 180) / Math.PI,
      pos: obj.currPos.clone(),
      hasTarget: false,
      problem: "support",
    };
  }

  /** Objects resting on top of `base`, and on top of those (contact normal pointing up). */
  private passengersOf(base: Destructible): Destructible[] {
    const found: Destructible[] = [];
    const seen = new Set<Destructible>([base]);
    const queue = [base];
    while (queue.length > 0) {
      const below = queue.shift() as Destructible;
      for (const part of below.parts) {
        const collider = part.collider;
        if (!collider) continue;
        this.world.contactPairsWith(collider, (other) => {
          const owner = this.destruction.ownerOf(other);
          if (owner?.kind !== "object" || seen.has(owner.obj) || !owner.obj.alive || owner.obj.held) return;
          let onTop = false;
          this.world.contactPair(collider, other, (manifold, flipped) => {
            // The normal points from the first collider to the second: up = it rests on us.
            if (manifold.numContacts() > 0 && manifold.normal().y * (flipped ? -1 : 1) > 0.5) onTop = true;
          });
          if (!onTop) return;
          seen.add(owner.obj);
          found.push(owner.obj);
          queue.push(owner.obj);
        });
      }
    }
    return found;
  }

  /** Cancels placement: a moved object goes back where it was, a stored one back to storage. */
  cancel(): void {
    const p = this.placing;
    if (!p) return;
    this.placing = null;
    this.outline.visible = false;
    if (p.fromStorage) {
      this.release(p.obj);
      this.onCancelStorage(p.obj);
      return;
    }
    this.release(p.obj);
    p.obj.placeAt(p.startPos, p.startQuat);
    p.obj.setGhost(false);
    this.destruction.settle(() => p.obj.body);
    this.dropPassengers(p, true);
  }

  /** Puts the riders back down: where they started (cancel) or on the placed object (commit). */
  private dropPassengers(p: Placing, atStart: boolean): void {
    for (const r of p.passengers) {
      this.release(r.obj);
      if (!r.obj.body) continue;
      r.obj.placeAt(atStart ? r.startPos : r.pos, atStart ? r.startQuat : r.quat);
      r.obj.setGhost(false);
      this.destruction.settle(() => r.obj.body);
    }
  }

  private release(obj: Destructible): void {
    obj.savePose = null;
    obj.transient = false;
  }

  hide(): void {
    this.outline.visible = false;
    this.hovered = null;
  }

  update(dt: number, input: Input): ArrangeState {
    if (this.placing) {
      this.updatePlacing(dt, input);
      return this.state;
    }
    this.hovered = this.pick();
    if (!this.hovered) {
      this.outline.visible = false;
      return this.state;
    }
    this.showOutline(this.hovered, this.hovered.currPos, this.hovered.currQuat, COLORS.hover);
    if (input.pressed("remove")) {
      this.onStore(this.hovered);
      return this.state;
    }
    if (input.pressed("attack")) this.begin(this.hovered, false);
    return this.state;
  }

  private pick(): Destructible | null {
    this.camera.getWorldDirection(forward);
    const hit = this.world.castRay(new RAPIER.Ray(this.camera.position, forward), REACH, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, SURFACE_FILTER, this.playerCollider);
    const owner = hit ? this.destruction.ownerOf(hit.collider) : undefined;
    return owner?.kind === "object" && owner.obj.alive && isInRoom(owner.obj.currPos.x, owner.obj.currPos.z) ? owner.obj : null;
  }

  private updatePlacing(dt: number, input: Input): void {
    const p = this.placing as Placing;
    if (!p.obj.body) {
      this.placing = null;
      this.outline.visible = false;
      return;
    }
    // Rotation: Q / E in 15° steps, or free while Shift is held.
    if (input.isDown("run")) {
      if (input.isDown("rotateLeft")) p.yaw += FREE_ROTATE_SPEED * dt;
      if (input.isDown("rotateRight") || input.isDown("interact")) p.yaw -= FREE_ROTATE_SPEED * dt;
    } else {
      if (input.pressed("rotateLeft")) p.yaw = Math.round(p.yaw / ROTATE_STEP) * ROTATE_STEP + ROTATE_STEP;
      if (input.pressed("rotateRight") || input.pressed("interact")) p.yaw = Math.round(p.yaw / ROTATE_STEP) * ROTATE_STEP - ROTATE_STEP;
    }
    const quat = new Quaternion().setFromEuler(new Euler(0, (p.yaw * Math.PI) / 180, 0));

    // Follow the crosshair over upward-facing surfaces; the ghost itself is out of the physics
    // world, so the ray passes through it.
    this.camera.getWorldDirection(forward);
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray(this.camera.position, forward), REACH, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, SURFACE_FILTER, this.playerCollider);
    if (hit && hit.normal.y > 0.6) {
      p.pos.copy(this.camera.position).addScaledVector(forward, hit.timeOfImpact);
      p.hasTarget = true;
    }
    p.problem = p.hasTarget ? this.settle(p.obj, p.pos, quat) : "support";
    for (const r of p.passengers) {
      r.pos.copy(r.localPos).applyQuaternion(quat).add(p.pos);
      r.quat.copy(quat).multiply(r.localQuat);
      if (!p.problem) p.problem = this.ridesClear(r);
    }
    if (!p.problem && p.fromStorage && !this.roomHasSpace()) p.problem = "full";

    // The objects themselves are the preview.
    showAt(p.obj, p.pos, quat);
    for (const r of p.passengers) showAt(r.obj, r.pos, r.quat);
    this.showOutline(p.obj, p.pos, quat, p.problem ? COLORS.invalid : COLORS.valid);

    if (input.pressed("kick") || input.pressed("remove")) {
      if (input.pressed("remove") && !p.fromStorage && p.obj.pristine) {
        // Delete while placing: straight into storage. What stood on it is put back where it was
        // and falls to the floor once the object is gone.
        this.placing = null;
        this.outline.visible = false;
        this.release(p.obj);
        p.obj.placeAt(p.startPos, p.startQuat);
        p.obj.setGhost(false);
        this.dropPassengers(p, true);
        this.onStore(p.obj);
        return;
      }
      this.cancel();
      return;
    }
    if (input.pressed("attack") && !p.problem) {
      this.placing = null;
      this.outline.visible = false;
      this.release(p.obj);
      p.obj.placeAt(p.pos, quat);
      p.obj.setGhost(false);
      // Placed at rest on its support: let it settle and sleep instead of rocking.
      this.destruction.settle(() => p.obj.body);
      this.dropPassengers(p, false);
      this.onCommit(p.obj, p.fromStorage);
    }
  }

  /** A rider must fit at its new place too: under the ceiling and inside nothing solid. */
  private ridesClear(r: Passenger): PlacementProblem | null {
    if (r.pos.y + r.obj.template.size[1] > ROOM.height - 0.05) return "outside";
    return this.overlaps(r.shapes, r.pos, r.quat, 0.004);
  }

  /**
   * Overlap test with the ghost's real collider shapes (not a box): neighbours may stand as close
   * as they like, but never inside it, or the solver would push them apart when it lands.
   */
  private overlaps(shapes: readonly GhostShape[], pos: Vector3, quat: Quaternion, lift: number): PlacementProblem | null {
    let problem: PlacementProblem | null = null;
    for (const g of shapes) {
      tmpPos.copy(g.offset).applyQuaternion(quat).add(pos);
      tmpPos.y += lift;
      tmpQuat.copy(quat).multiply(g.rotation);
      this.world.intersectionsWithShape(
        { x: tmpPos.x, y: tmpPos.y, z: tmpPos.z },
        { x: tmpQuat.x, y: tmpQuat.y, z: tmpQuat.z, w: tmpQuat.w },
        g.shape,
        (collider) => {
          problem = collider.handle === this.playerCollider.handle ? "player" : "blocked";
          return false;
        },
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        PLACEMENT_FILTER,
      );
      if (problem) return problem;
    }
    return null;
  }

  /**
   * Magnet + validation. Moves `pos.y` onto the real support under the footprint (the highest
   * surface within reach of the aimed one) and returns what is wrong with the spot, if anything.
   */
  private settle(obj: Destructible, pos: Vector3, quat: Quaternion): PlacementProblem | null {
    const [sx, sy, sz] = obj.template.size;
    const yaw = new Euler().setFromQuaternion(quat, "YXZ").y;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const hx = sx / 2 - 0.03;
    const hz = sz / 2 - 0.03;
    const samples: [number, number][] = [
      [0, 0],
      [hx, hz],
      [-hx, hz],
      [hx, -hz],
      [-hx, -hz],
    ];
    // Probe straight down from above the footprint: corners and centre.
    const heights: (number | null)[] = samples.map(([lx, lz]) => {
      const x = pos.x + lx * cos + lz * sin;
      const z = pos.z - lx * sin + lz * cos;
      const from = { x, y: pos.y + MAGNET + 0.02, z };
      const hit = this.world.castRay(new RAPIER.Ray(from, down), MAGNET * 2 + 0.05, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, SURFACE_FILTER, this.playerCollider);
      return hit ? from.y - hit.timeOfImpact : null;
    });
    const top = Math.max(...heights.map((v) => (v === null ? -Infinity : v)));
    if (!Number.isFinite(top)) return "support";
    // Seat it: the last few centimetres snap so the base touches the support exactly.
    pos.y = top;
    const supported = heights.filter((v) => v !== null && Math.abs(v - top) < 0.025).length;
    const centreOk = heights[0] !== null && Math.abs((heights[0] as number) - top) < 0.025;
    if (supported < 3 && !(centreOk && supported >= 2)) return "support";

    // Inside the room, under the ceiling, away from the doorway.
    const ex = Math.abs(sx / 2 * cos) + Math.abs(sz / 2 * sin);
    const ez = Math.abs(sx / 2 * sin) + Math.abs(sz / 2 * cos);
    const [ox, , oz] = ROOM.origin;
    if (pos.x - ex < ox - ROOM.width / 2 + WALL_MARGIN || pos.x + ex > ox + ROOM.width / 2 - WALL_MARGIN) return "outside";
    const front = STREET.northFacadeZ - STREET.facadeThickness;
    if (pos.z - ez < oz - ROOM.depth / 2 + WALL_MARGIN || pos.z + ez > front - WALL_MARGIN) return "outside";
    if (pos.y + sy > ROOM.height - 0.05) return "outside";
    const doorX = ox + ROOM_DOOR.x;
    if (Math.abs(pos.x - doorX) < DOOR_CLEAR.halfWidth + ex && pos.z + ez > front - DOOR_CLEAR.depth && pos.y < 0.4) return "door";

    // No overlap with anything solid (lifted a little: resting on the support is fine).
    const shapes = this.placing?.obj === obj ? this.placing.shapes : ghostShapes(obj);
    return this.overlaps(shapes, pos, quat, SUPPORT_CLEARANCE);
  }

  private showOutline(obj: Destructible, pos: Vector3, quat: Quaternion, color: number): void {
    const [sx, sy, sz] = obj.template.size;
    this.outline.visible = true;
    // The box follows the object's own frame: on a chair lying on its side it still fits.
    this.outline.position.set(...obj.template.center).applyQuaternion(quat).add(pos);
    this.outline.quaternion.copy(quat);
    this.outline.scale.set(sx + 0.02, sy + 0.02, sz + 0.02);
    this.outlineMaterial.color.setHex(color);
  }
}

/** Moves a ghost's visible model (its body is out of the simulation while placing). */
function showAt(obj: Destructible, pos: Vector3, quat: Quaternion): void {
  obj.root.position.copy(pos);
  obj.root.quaternion.copy(quat);
  obj.currPos.copy(pos);
  obj.prevPos.copy(pos);
  obj.currQuat.copy(quat);
  obj.prevQuat.copy(quat);
}
