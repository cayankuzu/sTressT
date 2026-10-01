import RAPIER, { type Collider, type RigidBody, type World } from "@dimforge/rapier3d";
import { type BufferGeometry, Euler, Group, Matrix4, Mesh, Quaternion, type Scene, Vector3 } from "three";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GAME, GROUPS } from "../config/gameConfig";
import { hashSeed, Rng } from "../core/rng";
import { MATERIALS } from "../data/catalog";
import type { MaterialType, ObjectOrigin } from "../data/types";
import type { DecalKind, DecalRecord, ObjectRecord, PartRecord, SoupData } from "../save/schema";
import { computeDamage, type Impact } from "./damage";
import type { FractureJobs } from "./FractureJobs";
import { type PreparedPiece, preparePiece } from "./geometry/prepare";
import { dentSoup } from "./deform";
import { chipSoup, fractureSoup } from "./geometry/fracture";
import { hullPoints, mergeSoups, type Soup, type SoupStats, soupStats, soupToGeometries, type Vec3 } from "./geometry/soup";
import { decalMaterial } from "./materials";
import { advanceTo, applyDamage, createState, type DestructionState, type Stage } from "./stages";
import type { Template } from "./Template";

/** Generation marker for bodies at rest (anything that hits them counts as a new cascade step). */
export const RESTING = 99;
const MAX_PIECES_PER_BREAK = 18;

export type Part = {
  /** Index of the template part this came from (-1 once it is no longer one). */
  seed: number;
  soup: Soup;
  /** True while `soup` is still the template's shared copy (copy-on-write). */
  shared: boolean;
  mat: MaterialType;
  stats: SoupStats;
  area: number;
  hp: number;
  maxHp: number;
  collider: Collider | null;
};

export type HitResult = {
  damage: number;
  transitions: Stage[];
  material: MaterialType;
  /** Something came off (part detached or chip knocked out). */
  structural: boolean;
};

const NO_HIT: HitResult = { damage: 0, transitions: [], material: "plastic", structural: false };

/** How the pieces of one break event came to be (decides how many may be collectible). */
export type BreakKind = "detach" | "chip" | "shatter";

type Registry = {
  register(handle: number, obj: Destructible, part: Part): void;
  unregister(handle: number): void;
  jobs: FractureJobs;
  /** Runs spawn work under a per-frame time budget. */
  schedule(task: () => void): void;
  /** Turns prepared pieces into debris (classification, ids, velocities). */
  spawnDebris(parent: Destructible, pieces: PreparedPiece[], impact: Impact, kick: number, kind: BreakKind): void;
  /** The object finished shattering and is gone. */
  destroyed(obj: Destructible): void;
};

export type DestructibleOptions = {
  origin: ObjectOrigin;
  foundItemId?: string;
  /** Restores a saved (possibly damaged) object exactly as it was. */
  record?: ObjectRecord;
};

const tmpV = new Vector3();
const tmpQ = new Quaternion();

function soupFromData(d: SoupData): Soup {
  return { pos: d.pos, nrm: d.nrm, uv: d.uv, slot: d.slot, mat: d.mat, count: d.slot.length };
}

/**
 * One breakable object in the world: render meshes, compound physics body (one convex hull per
 * structural part), health, dents, marks, and the logic that turns impacts into damage, detached
 * parts, chips and finally a full fracture. Everything about it can be saved and restored.
 */
export class Destructible {
  readonly root = new Group();
  body: RigidBody | null = null;
  parts: Part[] = [];
  readonly state: DestructionState;
  readonly origin: ObjectOrigin;
  readonly foundItemId: string | undefined;
  generation = RESTING;
  held = false;
  moving = false;
  /** Seconds since the last hit (drives the health bar visibility). */
  sinceHit = Infinity;
  readonly prevPos = new Vector3();
  readonly currPos = new Vector3();
  readonly prevQuat = new Quaternion();
  readonly currQuat = new Quaternion();
  /** Pieces shed so far: every piece id is `<object>.d<n>`, unique forever. */
  debrisSeq = 0;
  /** Cleanup value of breaks that left no collectible piece; paid to the next ones. */
  pendingCleanup = 0;
  /** While being re-placed in arrange mode, saves use its last committed pose. */
  savePose: { pos: Vector3; quat: Quaternion } | null = null;
  /** Taken out of storage but not placed yet: not part of the world for saving. */
  transient = false;
  private meshes: Mesh[] = [];
  private ownsGeometry = false;
  private decals: { geometry: BufferGeometry | null; center: Vector3; record: DecalRecord }[] = [];
  private decalMeshes: Mesh[] = [];
  private deformUsed = 0;
  private lastAttackId = -1;
  private hits = 0;
  /** A full fracture is being computed in the background; the object ignores further hits. */
  private breaking = false;

  constructor(
    readonly instanceId: string,
    readonly template: Template,
    private readonly scene: Scene,
    private readonly world: World,
    private readonly registry: Registry,
    position: Vector3,
    rotation: Quaternion,
    options: DestructibleOptions,
  ) {
    this.origin = options.origin;
    this.foundItemId = options.foundItemId;
    const def = template.def;
    const record = options.record;
    this.state = createState(def.health);

    if (record?.parts) {
      this.parts = record.parts.map((r) => this.partFromRecord(r));
    } else {
      this.parts = template.parts.map((seed, i) => {
        const share = seed.stats.area / template.totalArea;
        const fragile = seed.mat === "glass" ? 0.45 : 1;
        // Assembled furniture fails part by part; a simple object's core holds until the end.
        const maxHp = i === 0 && def.structure === "simple" ? Infinity : def.health * Math.min(1, Math.max(0.22, Math.sqrt(share) * 1.15)) * fragile;
        return { seed: i, soup: seed.soup, shared: true, mat: seed.mat, stats: seed.stats, area: seed.stats.area, hp: maxHp, maxHp, collider: null };
      });
    }
    if (record) {
      this.state.health = Math.min(def.health, Math.max(0.001, record.health));
      this.state.stage = record.stage;
      this.deformUsed = record.deformUsed;
      this.debrisSeq = record.debrisSeq;
    }

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w })
        .setLinearDamping(0.05)
        .setAngularDamping(0.12),
    );
    // Created awake on purpose: a body born asleep has no contact pairs yet, so whatever wakes it
    // first lets it drop through its support for a few steps and then shoves it out sideways
    // (cups jump off tables, vases tip over). Awake, it finds its support on the very first step,
    // stays exactly where it was put, and falls asleep by itself a moment later.
    this.currPos.copy(position);
    this.prevPos.copy(position);
    this.currQuat.copy(rotation);
    this.prevQuat.copy(rotation);
    this.buildColliders();
    this.buildMeshes();
    this.root.position.copy(position);
    this.root.quaternion.copy(rotation);
    scene.add(this.root);
    for (const d of record?.decals ?? []) this.addDecal(d);
  }

  private partFromRecord(r: PartRecord): Part {
    const seed = r.seed >= 0 ? this.template.parts[r.seed] : undefined;
    const soup = r.soup ? soupFromData(r.soup) : (seed?.soup as Soup);
    const shared = !r.soup;
    const stats = shared && seed ? seed.stats : soupStats(soup);
    return { seed: r.seed, soup, shared, mat: r.mat, stats, area: stats.area, hp: r.hp, maxHp: r.maxHp, collider: null };
  }

  get definitionId(): string {
    return this.template.id;
  }

  get alive(): boolean {
    return this.body !== null && !this.breaking;
  }

  get mass(): number {
    return this.template.def.mass;
  }

  get healthRatio(): number {
    return this.state.health / this.state.maxHealth;
  }

  /** Still exactly as bought (only those can go back into storage). */
  get pristine(): boolean {
    return this.state.stage === "intact" && this.state.health >= this.state.maxHealth && this.decals.length === 0 && this.deformUsed === 0 && this.isTemplateShape();
  }

  private isTemplateShape(): boolean {
    return this.parts.length === this.template.parts.length && this.parts.every((p) => p.shared);
  }

  // ------------------------------------------------------------------ setup

  /**
   * Mass follows surface area, except that parts standing on the ground (feet, bases, bottom
   * shelves) weigh more, as real ones do: the centre of mass sits low and a desk lamp with its
   * arm stretched out stays on its foot. The whole object always weighs exactly its mass.
   */
  private partMass(part: Part): number {
    return Math.max(0.02, (this.template.def.mass * partWeight(part.area, part.stats.min[1])) / templateWeight(this.template));
  }

  private buildColliders(): void {
    if (!this.body) return;
    for (const part of this.parts) {
      if (part.collider) {
        this.registry.unregister(part.collider.handle);
        this.world.removeCollider(part.collider, true);
        part.collider = null;
      }
      const m = MATERIALS[part.mat];
      const finish = (desc: RAPIER.ColliderDesc): RAPIER.ColliderDesc =>
        desc
          .setMass(this.partMass(part))
          .setFriction(m.friction)
          .setRestitution(m.restitution)
          .setCollisionGroups(this.held ? GROUPS.held : GROUPS.prop)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(this.template.def.mass * 9.81 * 4 + 2);
      const hull = RAPIER.ColliderDesc.convexHull(hullPoints(part.soup, 64));
      let collider: RAPIER.Collider | null = null;
      try {
        // Rapier builds the hull here and throws on degenerate points (a paper-thin part).
        if (hull) collider = this.world.createCollider(finish(hull), this.body);
      } catch {
        collider = null;
      }
      if (!collider) {
        const { min, max } = part.stats;
        const box = RAPIER.ColliderDesc.cuboid(
          Math.max(0.005, (max[0] - min[0]) / 2),
          Math.max(0.005, (max[1] - min[1]) / 2),
          Math.max(0.005, (max[2] - min[2]) / 2),
        ).setTranslation((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
        collider = this.world.createCollider(finish(box), this.body);
      }
      part.collider = collider;
      this.registry.register(part.collider.handle, this, part);
    }
  }

  private buildMeshes(): void {
    for (const mesh of this.meshes) {
      this.root.remove(mesh);
      if (this.ownsGeometry) mesh.geometry.dispose();
    }
    this.meshes = [];
    const unchanged = this.isTemplateShape();
    const geometries = unchanged ? sharedGeometries(this.template) : soupToGeometries(mergeSoups(this.parts.map((p) => p.soup)), this.template.materials.length);
    this.ownsGeometry = !unchanged;
    geometries.forEach((geometry, slot) => {
      const material = this.template.materials[slot];
      if (!geometry || !material) return;
      const mesh = new Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.meshes.push(mesh);
    });
  }

  /** Switches collision groups while the player holds the object (it must not push the player). */
  setHeld(held: boolean): void {
    this.held = held;
    for (const part of this.parts) part.collider?.setCollisionGroups(held ? GROUPS.held : GROUPS.prop);
  }

  /**
   * Arrange-mode ghost: the body leaves the simulation entirely (it can neither push nor be
   * pushed) while the player positions it, then comes back exactly where it was put.
   */
  setGhost(ghost: boolean): void {
    this.body?.setEnabled(!ghost);
  }

  /** Teleports the object (arrange commit) and lets it rest there without any impulse. */
  placeAt(position: Vector3, rotation: Quaternion): void {
    const body = this.body;
    if (!body) return;
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, false);
    body.setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w }, false);
    body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    this.currPos.copy(position);
    this.prevPos.copy(position);
    this.currQuat.copy(rotation);
    this.prevQuat.copy(rotation);
    this.root.position.copy(position);
    this.root.quaternion.copy(rotation);
    this.generation = RESTING;
  }

  // ------------------------------------------------------------------ per step / frame

  afterStep(): void {
    const body = this.body;
    if (!body || !body.isEnabled()) return;
    const sleeping = body.isSleeping();
    if (sleeping && !this.moving) return;
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    const t = body.translation();
    const r = body.rotation();
    this.currPos.set(t.x, t.y, t.z);
    this.currQuat.set(r.x, r.y, r.z, r.w);
    this.moving = !sleeping;
    if (sleeping) this.generation = RESTING;
    const lv = body.linvel();
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    const max = GAME.physics.maxLinearSpeed;
    if (speed > max) body.setLinvel({ x: (lv.x / speed) * max, y: (lv.y / speed) * max, z: (lv.z / speed) * max }, true);
  }

  render(alpha: number, dt: number): void {
    this.sinceHit += dt;
    if (!this.body || !this.body.isEnabled()) return;
    this.root.position.lerpVectors(this.prevPos, this.currPos, alpha);
    this.root.quaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
  }

  /** World-space position of the body (not interpolated). */
  bodyPosition(out: Vector3): Vector3 {
    const t = this.body?.translation();
    return t ? out.set(t.x, t.y, t.z) : out.copy(this.currPos);
  }

  // ------------------------------------------------------------------ impacts

  toLocalPoint(p: Vec3): Vec3 {
    tmpQ.copy(this.currQuat).invert();
    tmpV.set(p[0] - this.currPos.x, p[1] - this.currPos.y, p[2] - this.currPos.z).applyQuaternion(tmpQ);
    return [tmpV.x, tmpV.y, tmpV.z];
  }

  private toLocalDir(d: Vec3): Vec3 {
    tmpQ.copy(this.currQuat).invert();
    tmpV.set(d[0], d[1], d[2]).applyQuaternion(tmpQ);
    return [tmpV.x, tmpV.y, tmpV.z];
  }

  private nearestPart(local: Vec3): Part | undefined {
    let best: Part | undefined;
    let bestD = Infinity;
    for (const p of this.parts) {
      const d = boxDistance(local, p.stats);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /**
   * Applies one impact. `part` is the struck part when known (from the collider that was hit).
   * Returns the damage dealt and the destruction stages crossed.
   */
  applyImpact(impact: Impact, part: Part | undefined): HitResult {
    const body = this.body;
    if (!body || this.breaking || !body.isEnabled()) return NO_HIT;
    if (impact.attackId !== undefined) {
      if (impact.attackId === this.lastAttackId) return NO_HIT;
      this.lastAttackId = impact.attackId;
    }
    this.generation = Math.min(this.generation, impact.generation);
    const localPoint = this.toLocalPoint(impact.point);
    const localDir = this.toLocalDir(impact.dir);
    const localNormal = this.toLocalDir(impact.normal);
    const struck = part && this.parts.includes(part) ? part : this.nearestPart(localPoint);
    if (!struck) return NO_HIT;
    const material = MATERIALS[struck.mat];

    // Physical reaction. Collisions already got theirs from the solver.
    if (impact.source === "tool" && impact.impulse > 0) {
      // Cap the velocity change so a punch topples a vase instead of launching it.
      const j = Math.min(impact.impulse, (impact.maxDeltaV ?? 2.5) * this.mass);
      body.applyImpulseAtPoint(
        { x: impact.dir[0] * j, y: impact.dir[1] * j, z: impact.dir[2] * j },
        { x: impact.point[0], y: impact.point[1], z: impact.point[2] },
        true,
      );
    }

    const damage = this.template.def.capabilities.destructible ? computeDamage(impact, material, struck.mat) : 0;
    const dentOnly = !this.template.def.capabilities.destructible ? computeDamage({ ...impact, generation: 0 }, material, struck.mat) : damage;
    const rng = new Rng(hashSeed(this.instanceId, this.debrisSeq, ++this.hits, Math.round(impact.energy * 10)));

    let visualChanged = false;
    if (material.deform > 0 && dentOnly > 2 && this.deformUsed < material.maxDeform) {
      const depth = Math.min(material.maxDeform - this.deformUsed, dentOnly * material.deform);
      const radius = impact.contactRadius + material.damageSpread * Math.sqrt(dentOnly) * 0.8;
      this.ownPart(struck);
      if (dentSoup(struck.soup, localPoint, localDir, radius, depth)) {
        this.deformUsed += depth;
        visualChanged = true;
      }
    }
    if (damage < 0.5) {
      if (visualChanged) this.buildMeshes();
      return { damage: 0, transitions: [], material: struck.mat, structural: false };
    }
    this.sinceHit = 0;
    const transitions = applyDamage(this.state, damage);
    // Every real hit leaves a mark where it landed (unless the object is about to shatter).
    if (this.state.stage !== "destroyed" && struck.mat !== "rubber") {
      const kind: DecalKind = struck.mat === "glass" ? "glass" : material.cracks ? "crack" : "scuff";
      const size = Math.min(0.34, Math.max(0.05, 0.035 + Math.sqrt(damage) * (kind === "scuff" ? 0.01 : 0.014))) * (kind === "glass" ? 1.4 : 1);
      this.addDecal({ point: localPoint, normal: localNormal, size, spin: rng.range(0, Math.PI * 2), variant: rng.int(0, 3), kind }, impact);
    }
    const spread = impact.contactRadius + material.damageSpread * Math.sqrt(damage);
    for (const p of this.parts) {
      if (p === struck) p.hp -= damage;
      else {
        const d = boxDistance(localPoint, p.stats);
        p.hp -= damage * 0.5 * Math.exp(-(d * d) / (spread * spread));
      }
    }

    if (this.state.stage === "destroyed") {
      this.shatter(localPoint, localDir, impact, damage, rng);
      return { damage, transitions, material: struck.mat, structural: true };
    }

    let structural = false;
    for (const p of this.parts.slice()) {
      if (p.hp > 0 || this.parts.length <= 1) continue;
      this.detach(p, localPoint, localDir, impact, damage, rng);
      structural = true;
    }
    if (!structural && material.chipEnergy > 0 && damage >= material.chipEnergy && struck.stats.radius > 0.07 && this.parts.includes(struck)) {
      const depth = Math.min(struck.stats.radius * 0.45, 0.025 + 0.03 * Math.sqrt(damage / material.chipEnergy));
      structural = this.chip(struck, localPoint, localNormal, localDir, depth, impact, rng);
    }

    if (structural) {
      transitions.push(...advanceTo(this.state, "broken"));
      const remaining = this.parts.reduce((sum, p) => sum + p.area, 0);
      if (remaining < this.template.totalArea * 0.3 || this.parts.length === 0) {
        transitions.push(...advanceTo(this.state, "destroyed"));
        this.state.health = 0;
        this.shatter(localPoint, localDir, impact, damage, rng);
        return { damage, transitions, material: struck.mat, structural };
      }
      this.buildColliders();
      this.pruneDecals();
      visualChanged = true;
    }
    if (visualChanged) this.buildMeshes();
    return { damage, transitions, material: struck.mat, structural };
  }

  private ownPart(part: Part): void {
    if (!part.shared) return;
    part.soup = { pos: part.soup.pos.slice(), nrm: part.soup.nrm.slice(), uv: part.soup.uv.slice(), slot: part.soup.slot.slice(), mat: part.soup.mat.slice(), count: part.soup.count };
    part.shared = false;
  }

  private removePart(part: Part): void {
    if (part.collider) {
      this.registry.unregister(part.collider.handle);
      this.world.removeCollider(part.collider, true);
      part.collider = null;
    }
    this.parts = this.parts.filter((p) => p !== part);
  }

  /** A structural part (leg, door, screen...) gives way: it comes off whole or in a few pieces. */
  private detach(part: Part, point: Vec3, dir: Vec3, impact: Impact, damage: number, rng: Rng): void {
    const material = MATERIALS[part.mat];
    const overflow = -part.hp / part.maxHp;
    const pieces =
      part.mat === "glass"
        ? rng.int(material.fragments[0], material.fragments[1])
        : overflow > 0.6
          ? rng.int(2, Math.max(2, Math.ceil(material.fragments[1] / 2)))
          : 1;
    this.removePart(part);
    const soups = pieces > 1 ? fractureSoup({ soup: part.soup, point, dir, pattern: material.pattern, pieces, rng }) : [part.soup];
    this.registry.spawnDebris(this, soups.filter((s) => s.count > 0).map(preparePiece), impact, damage, "detach");
  }

  private chip(part: Part, point: Vec3, normal: Vec3, dir: Vec3, depth: number, impact: Impact, rng: Rng): boolean {
    const surface: Vec3 = Math.hypot(...normal) > 0.1 ? normal : [-dir[0], -dir[1], -dir[2]];
    const result = chipSoup(part.soup, point, surface, depth, rng);
    if (!result || result.remain.count === 0) return false;
    part.soup = result.remain;
    part.shared = false;
    part.seed = -1;
    part.stats = soupStats(part.soup);
    part.area = part.stats.area;
    this.registry.spawnDebris(this, result.chips.map(preparePiece), impact, impact.energy, "chip");
    return true;
  }

  /** Full destruction: every remaining part fractures from the impact point. */
  private shatter(point: Vec3, dir: Vec3, impact: Impact, damage: number, rng: Rng): void {
    const total = this.parts.reduce((sum, p) => sum + p.area, 0) || 1;
    const energyScale = Math.min(1, damage / Math.max(1, this.template.def.health * 0.5));
    // The whole object gets one piece budget (more energy = more pieces), shared by area, so a
    // chair breaks into ~a dozen believable bits instead of every leg exploding separately.
    const [lo, hi] = MATERIALS[this.template.def.material].fragments;
    const budget = Math.min(MAX_PIECES_PER_BREAK, Math.round(lo + (hi - lo) * energyScale) + Math.ceil(this.parts.length / 2));
    const jobs = this.parts.map((part) => {
      const material = MATERIALS[part.mat];
      const share = part.area / total;
      const target = Math.max(1, Math.round(budget * share), part.mat === "glass" ? material.fragments[0] : 1);
      const pieces = part.stats.radius < 0.05 ? Math.min(2, target) : target;
      return this.registry.jobs.run({ soup: part.soup, point, dir, pattern: material.pattern, pieces, seed: rng.int(1, 2_000_000_000) });
    });
    // The intact object stays (and keeps moving) until the pieces are ready, usually next frame.
    this.breaking = true;
    const kick = damage + impact.energy * 0.3;
    void Promise.all(jobs).then((results) => {
      this.registry.schedule(() => {
        if (!this.body) return; // removed while computing
        this.registry.spawnDebris(this, results.flat(), impact, kick, "shatter");
        this.dispose();
        this.registry.destroyed(this);
      });
    });
  }

  // ------------------------------------------------------------------ marks

  /** Projects a mark onto the current meshes (also used to restore saved marks). */
  private addDecal(record: DecalRecord, impact?: Impact): void {
    // Keep the newest marks; the oldest disappears beyond the cap.
    if (this.decals.length >= GAME.destruction.maxDecalsPerObject) {
      this.decals.shift()?.geometry?.dispose();
    }
    this.root.position.copy(this.currPos);
    this.root.quaternion.copy(this.currQuat);
    this.root.updateMatrixWorld(true);
    const worldPoint = impact ? new Vector3(...impact.point) : new Vector3(...record.point).applyMatrix4(this.root.matrixWorld);
    const worldNormal = impact ? new Vector3(...impact.normal) : new Vector3(...record.normal).applyQuaternion(this.currQuat).normalize();
    const orientation = new Euler().setFromRotationMatrix(new Matrix4().lookAt(worldPoint, worldPoint.clone().sub(worldNormal), new Vector3(0, 1, 0)));
    orientation.z = record.spin;
    const inverse = this.root.matrixWorld.clone().invert();
    const pieces: BufferGeometry[] = [];
    const s = record.size;
    for (const mesh of this.meshes) {
      const decal = new DecalGeometry(mesh, worldPoint, orientation, new Vector3(s, s, s * 1.2));
      if (decal.getAttribute("position").count === 0) {
        decal.dispose();
        continue;
      }
      decal.applyMatrix4(inverse);
      const uv = decal.getAttribute("uv");
      const v = record.variant;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5 + (v % 2) * 0.5, uv.getY(i) * 0.5 + Math.floor(v / 2) * 0.5);
      pieces.push(decal);
    }
    const merged = pieces.length === 0 ? null : pieces.length === 1 ? (pieces[0] as BufferGeometry) : mergeGeometries(pieces);
    if (pieces.length > 1) for (const p of pieces) p.dispose();
    this.decals.push({ geometry: merged, center: new Vector3(...record.point), record });
    this.rebuildDecalMesh();
  }

  private rebuildDecalMesh(): void {
    for (const m of this.decalMeshes) {
      this.root.remove(m);
      m.geometry.dispose();
    }
    this.decalMeshes = [];
    for (const kind of ["crack", "glass", "scuff"] as const) {
      const geos = this.decals.filter((d) => d.record.kind === kind && d.geometry).map((d) => d.geometry as BufferGeometry);
      if (geos.length === 0) continue;
      const merged = geos.length === 1 ? (geos[0] as BufferGeometry).clone() : mergeGeometries(geos);
      if (!merged) continue;
      const mesh = new Mesh(merged, decalMaterial(kind));
      mesh.renderOrder = 2;
      this.root.add(mesh);
      this.decalMeshes.push(mesh);
    }
  }

  /** Drops marks that were sitting on geometry that has since come off. */
  private pruneDecals(): void {
    const before = this.decals.length;
    this.decals = this.decals.filter((d) => {
      const keep = this.parts.some((p) => boxDistance([d.center.x, d.center.y, d.center.z], p.stats) < 0.02);
      if (!keep) d.geometry?.dispose();
      return keep;
    });
    if (this.decals.length !== before) this.rebuildDecalMesh();
  }

  // ------------------------------------------------------------------ persistence

  /** Snapshot for the save (null while it is shattering: its pieces are saved instead). */
  serialize(): ObjectRecord | null {
    if (!this.body || this.breaking || this.transient) return null;
    const p = this.savePose?.pos ?? this.currPos;
    const q = this.savePose?.quat ?? this.currQuat;
    const untouched = this.isTemplateShape() && this.parts.every((x) => x.hp === x.maxHp);
    const copy = (s: Soup): SoupData => ({ pos: s.pos.slice(), nrm: s.nrm.slice(), uv: s.uv.slice(), slot: s.slot.slice(), mat: s.mat.slice() });
    const stage = this.state.stage === "destroyed" ? "broken" : this.state.stage;
    return {
      id: this.instanceId,
      definitionId: this.definitionId,
      origin: this.origin,
      ...(this.foundItemId ? { foundItemId: this.foundItemId } : {}),
      position: [p.x, p.y, p.z],
      rotation: [q.x, q.y, q.z, q.w],
      stage,
      health: this.state.health,
      deformUsed: this.deformUsed,
      debrisSeq: this.debrisSeq,
      parts: untouched ? null : this.parts.map((part) => ({ seed: part.seed, mat: part.mat, hp: part.hp, maxHp: part.maxHp, soup: part.shared ? null : copy(part.soup) })),
      decals: this.decals.map((d) => ({ ...d.record })),
    };
  }

  // ------------------------------------------------------------------ lifecycle

  /** Removes the body, colliders and all instance-owned render resources. */
  dispose(): void {
    for (const part of this.parts) {
      if (part.collider) this.registry.unregister(part.collider.handle);
    }
    if (this.body) {
      this.world.removeRigidBody(this.body);
      this.body = null;
    }
    for (const part of this.parts) part.collider = null;
    this.parts = [];
    for (const mesh of this.meshes) if (this.ownsGeometry) mesh.geometry.dispose();
    this.meshes = [];
    for (const d of this.decals) d.geometry?.dispose();
    this.decals = [];
    for (const m of this.decalMeshes) m.geometry.dispose();
    this.decalMeshes = [];
    this.scene.remove(this.root);
    this.root.clear();
    this.moving = false;
  }
}

/** Parts touching the floor count this many times their area towards mass. */
const GROUNDED_WEIGHT = 3;

function partWeight(area: number, minY: number): number {
  return area * (minY < 0.02 ? GROUNDED_WEIGHT : 1);
}

const weightCache = new WeakMap<Template, number>();

function templateWeight(template: Template): number {
  let w = weightCache.get(template);
  if (w === undefined) {
    w = template.parts.reduce((sum, p) => sum + partWeight(p.stats.area, p.stats.min[1]), 0) || 1;
    weightCache.set(template, w);
  }
  return w;
}

const sharedCache = new WeakMap<Template, (BufferGeometry | null)[]>();

/** Intact instances of the same object share one set of GPU buffers. */
function sharedGeometries(template: Template): (BufferGeometry | null)[] {
  let geometries = sharedCache.get(template);
  if (!geometries) {
    geometries = soupToGeometries(template.soup, template.materials.length);
    sharedCache.set(template, geometries);
  }
  return geometries;
}

function boxDistance(p: Vec3, stats: SoupStats): number {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i] as number;
    const lo = stats.min[i] as number;
    const hi = stats.max[i] as number;
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    d2 += d * d;
  }
  return Math.sqrt(d2);
}
