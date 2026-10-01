import type { Collider, EventQueue, RigidBody, World } from "@dimforge/rapier3d";
import { BatchedMesh, Box3, BufferAttribute, BufferGeometry, type Camera, Matrix4, Mesh, type Object3D, Quaternion, type Scene, Vector3, type WebGLRenderer } from "three";
import { GAME } from "../config/gameConfig";
import type { Assets } from "../core/assets";
import type { EventBus } from "../core/events";
import { MATERIALS } from "../data/catalog";
import type { MaterialType, ObjectOrigin } from "../data/types";
import { cleanupPool } from "../economy/economy";
import type { DebrisRecord, ObjectRecord } from "../save/schema";
import { collisionEnergy, computeDamage, type Impact } from "./damage";
import { Debris, type Fragment } from "./Debris";
import { canRefracture, classifyPieces, isHeavyPiece, majorPieceCount, pieceHealth } from "./debrisRules";
import { type BreakKind, Destructible, type HitResult, type Part, RESTING } from "./Destructible";
import { FractureJobs } from "./FractureJobs";
import { type PreparedPiece, pieceToSoup } from "./geometry/prepare";
import { decalMaterial, fragmentMaterial } from "./materials";
import type { Stage } from "./stages";
import { buildTemplate, materialAt, type Template } from "./Template";

type Owner = { kind: "object"; obj: Destructible; part: Part } | { kind: "fragment"; frag: Fragment };

/** `oneHit`: this single impact took the object from intact to destroyed. */
export type StageEvent = { obj: Destructible; stage: Stage; impact: Impact; oneHit: boolean };
export type ImpactFeedback = {
  material: MaterialType;
  energy: number;
  point: Vector3;
  /** Outward surface normal at the impact (for particles), when known. */
  normal?: Vector3;
  source: "tool" | "collision";
  broke: boolean;
  /** Tool that struck (undefined for kicks and collisions). */
  toolId?: string;
};

/** Main-thread time allowed per frame for turning finished fractures into physics pieces. */
const SPAWN_BUDGET_MS = 3;

/** Hard world surfaces act as the start of any cascade (a knocked-over vase breaking on the floor). */
const WORLD_GENERATION = -1;
const SOUND_COOLDOWN = 0.07;
const WORLD_BOX = new Box3(new Vector3(-21, -50, -15), new Vector3(21, 30, 9));
/**
 * Settling of bodies put down at rest: gravity is held for `holdSteps` (contacts form first), then
 * the body is damped (no start-up rocking) until it sleeps or `maxSteps` pass.
 */
const SETTLE = { holdSteps: 3, maxSteps: 50, linearDamping: 0.6, angularDamping: 4, touch: 0.0015 };
/** A collectible piece slower than this for this long is helped to sleep (no endless creeping). */
const REST = { speed: 0.15, spin: 0.6, seconds: 2.5, linear: 4, angular: 8, wake: 0.6, normalLinear: 0.08, normalAngular: 0.2 };
type Settling = { body: () => RigidBody | null; steps: number; linear: number; angular: number };

export type SpawnSpec = { id: string; definitionId: string; origin: ObjectOrigin; foundItemId?: string; position: Vector3; rotation: Quaternion; record?: ObjectRecord };

/**
 * Owns every breakable object and every piece of debris in the world: spawning and restoring
 * them, tool hits, collision damage (throws, falls, flying debris), chain-reaction limits,
 * breaking pieces again, the street container, lost pieces, and save snapshots.
 */
export class DestructionSystem {
  readonly debris: Debris;
  private templates = new Map<string, Promise<Template>>();
  private objects = new Map<string, Destructible>();
  private owners = new Map<number, Owner>();
  private soundCooldown = new Map<number, number>();
  private time = 0;
  /** Only the break session (door locked) can damage anything. */
  damageEnabled = false;
  /** Interior of the street container: pieces that settle inside are disposed of. */
  disposalVolume: Box3 | null = null;
  onStage: (event: StageEvent) => void = () => undefined;
  onFeedback: (event: ImpactFeedback) => void = () => undefined;
  /** New debris landed in the world (`majors` collectible pieces among them). */
  onDebris: (majors: number, total: number) => void = () => undefined;
  onDisposed: (frag: Fragment) => void = () => undefined;
  onLost: (frag: Fragment) => void = () => undefined;
  /** An object fell out of the world (it is put back by the game, never silently deleted). */
  onObjectLost: (obj: Destructible) => void = () => undefined;
  onObjectGone: (obj: Destructible) => void = () => undefined;

  /**
   * Bodies just placed at rest (new game, load, delivery, arrange commit). They are created awake so
   * their contacts form on the first step, held without gravity until then, and damped for a
   * moment so the solver's start-up transient cannot rock a bottle off a table. They sleep at once
   * when that is safe, otherwise as soon as the simulation lets them.
   */
  private settling: Settling[] = [];

  private readonly jobs = new FractureJobs();
  private readonly spawnQueue: (() => void)[] = [];
  private readonly warmed = new Set<string>();
  private readonly registry = {
    schedule: (task: () => void) => this.spawnQueue.push(task),
    register: (handle: number, obj: Destructible, part: Part) => this.owners.set(handle, { kind: "object", obj, part }),
    unregister: (handle: number) => this.owners.delete(handle),
    jobs: this.jobs,
    spawnDebris: (parent: Destructible, pieces: PreparedPiece[], impact: Impact, kick: number, kind: BreakKind) => this.spawnObjectDebris(parent, pieces, impact, kick, kind),
    destroyed: (obj: Destructible) => {
      this.objects.delete(obj.instanceId);
      this.onObjectGone(obj);
    },
  };

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
    private readonly assets: Assets,
    private readonly events: EventBus,
  ) {
    this.debris = new Debris(scene, world);
  }

  template(definitionId: string): Promise<Template> {
    let promise = this.templates.get(definitionId);
    if (!promise) {
      promise = buildTemplate(definitionId, this.assets);
      this.templates.set(definitionId, promise);
      promise.catch(() => this.templates.delete(definitionId));
    }
    return promise;
  }

  get(instanceId: string): Destructible | undefined {
    return this.objects.get(instanceId);
  }

  all(): IterableIterator<Destructible> {
    return this.objects.values();
  }

  get anyMoving(): boolean {
    for (const obj of this.objects.values()) if (obj.moving) return true;
    return this.debris.anyMoving;
  }

  ownerOf(collider: Collider | number): Owner | undefined {
    return this.owners.get(typeof collider === "number" ? collider : collider.handle);
  }

  // ------------------------------------------------------------------ objects

  /** Spawns one object (new, or restored from a save record). A broken record falls back to intact. */
  async spawn(spec: SpawnSpec): Promise<Destructible> {
    const template = await this.template(spec.definitionId);
    this.despawn(spec.id);
    let obj: Destructible;
    try {
      obj = new Destructible(spec.id, template, this.scene, this.world, this.registry, spec.position, spec.rotation, { origin: spec.origin, foundItemId: spec.foundItemId, record: spec.record });
    } catch (err) {
      console.error(`sTressT: saved state of ${spec.id} could not be rebuilt, restoring it whole`, err);
      obj = new Destructible(spec.id, template, this.scene, this.world, this.registry, spec.position, spec.rotation, { origin: spec.origin, foundItemId: spec.foundItemId });
    }
    this.objects.set(spec.id, obj);
    this.settle(() => obj.body);
    return obj;
  }

  /**
   * Queues a body (getter, it may be replaced) that was just put down at rest. Gravity waits until
   * its contacts exist (a freshly created or re-enabled body has none for its first step, and
   * would sink into its support), then it is put to sleep once it has settled.
   */
  settle(body: () => RigidBody | null): void {
    const b = body();
    if (!b) return;
    const existing = this.settling.find((s) => s.body() === b);
    if (existing) {
      existing.steps = 0;
      b.setGravityScale(0, false);
      return;
    }
    this.settling.push({ body, steps: 0, linear: b.linearDamping(), angular: b.angularDamping() });
    b.setGravityScale(0, false);
    b.setLinearDamping(SETTLE.linearDamping);
    b.setAngularDamping(SETTLE.angularDamping);
  }

  /**
   * Wakes every body resting on or leaning against `obj` before it leaves the simulation (storage,
   * ghost placement, removal): otherwise a sleeping cup would stay floating where the table was.
   * `except` are bodies that travel with it.
   */
  wakeTouching(obj: Destructible, except: readonly Destructible[] = []): void {
    const skip = new Set(except.map((o) => o.body));
    for (const part of obj.parts) {
      if (!part.collider) continue;
      this.world.contactPairsWith(part.collider, (other) => {
        const body = other.parent();
        if (body && body !== obj.body && !skip.has(body) && body.isDynamic()) body.wakeUp();
      });
    }
  }

  despawn(instanceId: string): void {
    const obj = this.objects.get(instanceId);
    if (!obj) return;
    this.wakeTouching(obj);
    obj.dispose();
    this.objects.delete(instanceId);
  }

  /** Rebuilds a saved world: objects as they were (dents and all), then their debris. */
  async load(objects: ObjectRecord[], debris: DebrisRecord[]): Promise<void> {
    await Promise.all(
      objects.map((r) =>
        this.spawn({
          id: r.id,
          definitionId: r.definitionId,
          origin: r.origin,
          foundItemId: r.foundItemId,
          position: new Vector3(...r.position),
          rotation: new Quaternion(...r.rotation),
          record: r,
        }).catch((err) => console.error(`sTressT: could not restore ${r.id}`, err)),
      ),
    );
    for (const rec of debris) {
      try {
        const template = await this.template(rec.definitionId);
        const f = this.debris.restore(rec, template.materials);
        if (f) this.settle(() => f.body);
      } catch (err) {
        console.error(`sTressT: could not restore piece ${rec.id}`, err);
      }
    }
  }

  /** Removes everything (objects, debris, pending work) before another game is loaded. */
  clearWorld(): void {
    this.spawnQueue.length = 0;
    this.settling = [];
    this.debris.clear();
    for (const id of Array.from(this.objects.keys())) this.despawn(id);
    this.soundCooldown.clear();
  }

  /** Save snapshot of every object and collectible piece. */
  serialize(): { objects: ObjectRecord[]; debris: DebrisRecord[] } {
    const objects: ObjectRecord[] = [];
    for (const obj of this.objects.values()) {
      const r = obj.serialize();
      if (r) objects.push(r);
    }
    const debris: DebrisRecord[] = [];
    for (const f of this.debris.all()) {
      const r = this.debris.serialize(f);
      if (r) debris.push(r);
    }
    return { objects, debris };
  }

  /**
   * Compiles every shader a break of these objects will need (broken-piece materials in their
   * batched form) up front, so the first time something shatters there is no compile hitch.
   */
  warmup(renderer: WebGLRenderer, scene: Scene, camera: Camera): void {
    const temp: Object3D[] = [];
    // Warm-up objects must really be drawn (inside the view, never culled): some drivers (ANGLE on
    // D3D11) finish compiling a program only at its first draw call.
    camera.updateMatrixWorld();
    const inFront = new Vector3(0, 0, -0.5).applyMatrix4(camera.matrixWorld);
    const matrix = new Matrix4().compose(inFront, camera.quaternion, new Vector3(1, 1, 1));
    const triangle = new BufferGeometry();
    triangle.setAttribute("position", new BufferAttribute(new Float32Array([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0]), 3));
    triangle.setAttribute("normal", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    triangle.setAttribute("uv", new BufferAttribute(new Float32Array(6), 2));
    for (const obj of this.objects.values()) {
      const t = obj.template;
      if (this.warmed.has(t.id)) continue;
      this.warmed.add(t.id);
      const mats = new Set(t.parts.map((p) => p.mat));
      for (let i = 0; i < t.soup.count; i++) mats.add(materialAt(t.soup.mat[i] as number));
      for (const source of t.materials) {
        for (const m of mats) {
          const batch = new BatchedMesh(1, 3, 3, fragmentMaterial(source, MATERIALS[m].interiorColor));
          batch.setMatrixAt(batch.addInstance(batch.addGeometry(triangle)), matrix);
          batch.castShadow = true;
          batch.frustumCulled = false;
          batch.perObjectFrustumCulled = false;
          scene.add(batch);
          temp.push(batch);
        }
      }
    }
    if (temp.length > 0) {
      for (const kind of ["crack", "glass", "scuff"] as const) {
        const mark = new Mesh(triangle, decalMaterial(kind));
        mark.position.copy(inFront);
        mark.frustumCulled = false;
        scene.add(mark);
        temp.push(mark);
      }
      renderer.compile(scene, camera);
      // Shadow depth programs are only built when the shadow map renders: do one real frame.
      renderer.shadowMap.needsUpdate = true;
      renderer.render(scene, camera);
    }
    for (const o of temp) {
      scene.remove(o);
      if (o instanceof BatchedMesh) o.dispose();
    }
    triangle.dispose();
  }

  // ------------------------------------------------------------------ debris

  /** Pieces of an object: classified (collectible or clutter), given ids, value and a kick. */
  private spawnObjectDebris(parent: Destructible, pieces: PreparedPiece[], impact: Impact, kick: number, kind: BreakKind): void {
    if (pieces.length === 0) return;
    const def = parent.template.def;
    // One budget of collectible pieces per object (debrisSeq counts the ones already made, and is
    // saved). Chips are splinters, never collectible; a detached part always leaves a slot for the
    // final shatter.
    const left = Math.max(0, majorPieceCount(def) - parent.debrisSeq);
    const budget = kind === "shatter" ? left : kind === "detach" ? Math.min(2, left - 1) : 0;
    const room = GAME.debris.majorWorldCap - this.debris.majors().length;
    const kinds = classifyPieces(
      pieces.map((p) => p.radius),
      budget,
      room,
    );
    const total = parent.template.totalArea || 1;
    const pool = cleanupPool(def);
    const velocityAt = this.velocityField(parent.body?.linvel(), parent.body?.angvel(), parent.currPos);
    const impactPoint = new Vector3(...impact.point);
    const impactDir = new Vector3(...impact.dir);
    const partArea = pieces.reduce((s, p) => s + p.area, 0) || 1;
    // This event's share of the cleanup pool goes entirely to its collectible pieces (crumbs are
    // not worth carrying, so they carry no value): cleaning up everything pays the whole pool.
    let eventPool = pool * Math.min(1, partArea / total);
    const majorArea = pieces.reduce((s, p, i) => s + (kinds[i] === "major" ? p.area : 0), 0) || 1;
    if (!kinds.includes("major")) {
      // No collectible piece this time: the value waits for the object's next one.
      parent.pendingCleanup += eventPool;
      eventPool = 0;
    } else {
      eventPool += parent.pendingCleanup;
      parent.pendingCleanup = 0;
    }
    let majors = 0;
    pieces.forEach((piece, i) => {
      const k = kinds[i] ?? "minor";
      const share = piece.area / total;
      const major = k === "major";
      if (major) majors++;
      this.debris.spawn({
        id: major ? `${parent.instanceId}.d${++parent.debrisSeq}` : this.debris.runtimeId(),
        kind: k,
        parentId: parent.instanceId,
        definitionId: parent.definitionId,
        piece,
        parentPosition: parent.currPos,
        parentQuaternion: parent.currQuat,
        materials: parent.template.materials,
        mass: def.mass * share,
        hp: pieceHealth(def.health, share),
        depth: 1,
        cleanupValue: major ? (eventPool * piece.area) / majorArea : 0,
        velocityAt,
        impactPoint,
        impactDir,
        // Each structural part spreads its own kick over its pieces (as when parts broke one by one).
        kickEnergy: kick * 0.16 * (piece.area / partArea) * (kind === "shatter" ? Math.max(1, parent.parts.length) : 1),
        generation: impact.generation + 1,
      });
    });
    this.onDebris(majors, pieces.length);
  }

  private velocityField(lin: { x: number; y: number; z: number } | undefined, ang: { x: number; y: number; z: number } | undefined, center: Vector3): (p: Vector3) => Vector3 {
    const l = lin ?? { x: 0, y: 0, z: 0 };
    const a = ang ?? { x: 0, y: 0, z: 0 };
    const c = center.clone();
    return (p: Vector3) => {
      const r = p.clone().sub(c);
      return new Vector3(l.x + a.y * r.z - a.z * r.y, l.y + a.z * r.x - a.x * r.z, l.z + a.x * r.y - a.y * r.x);
    };
  }

  /** A collectible piece took enough damage: it breaks into smaller pieces (no extra reward). */
  private refracture(frag: Fragment, impact: Impact): void {
    const piece = frag.piece;
    if (!piece || !frag.body) return;
    const inv = frag.currQuat.clone().invert();
    const local = new Vector3(...impact.point).sub(frag.currPos).applyQuaternion(inv);
    const dir = new Vector3(...impact.dir).applyQuaternion(inv);
    const material = MATERIALS[frag.material];
    // Heavy pieces split into more parts so their biggest child is clearly lighter.
    const count = frag.material === "glass" || isHeavyPiece(frag.mass) ? 4 : frag.radius > 0.15 ? 3 : 2;
    const lin = frag.body.linvel();
    const ang = frag.body.angvel();
    const pos = frag.currPos.clone();
    const quat = frag.currQuat.clone();
    const seed = Math.floor(Math.random() * 2_000_000_000);
    // The piece is gone from the world at once; its parts arrive with the next spawn budget.
    this.debris.remove(frag);
    void this.jobs.run({ soup: pieceToSoup(piece), point: [local.x, local.y, local.z], dir: [dir.x, dir.y, dir.z], pattern: material.pattern, pieces: count, seed }).then((children) => {
      this.registry.schedule(() => {
        void this.template(frag.definitionId).then((template) => {
          const radii = children.map((c) => c.radius);
          const kinds = classifyPieces(radii, GAME.debris.refractureMajors, GAME.debris.majorWorldCap - this.debris.majors().length);
          const area = children.reduce((s, c) => s + c.area, 0) || 1;
          const majorArea = children.reduce((s, c, i) => s + (kinds[i] === "major" ? c.area : 0), 0) || 1;
          const velocityAt = this.velocityField(lin, ang, pos);
          let majors = 0;
          children.forEach((child, i) => {
            const major = kinds[i] === "major";
            if (major) majors++;
            const share = child.area / area;
            this.debris.spawn({
              id: major ? `${frag.id}.${++frag.childSeq}` : this.debris.runtimeId(),
              kind: kinds[i] ?? "minor",
              parentId: frag.parentId,
              definitionId: frag.definitionId,
              piece: child,
              parentPosition: pos,
              parentQuaternion: quat,
              materials: template.materials,
              mass: frag.mass * share,
              hp: Math.max(8, frag.maxHp * share),
              depth: frag.depth + 1,
              cleanupValue: major ? (frag.cleanupValue * child.area) / majorArea : 0,
              velocityAt,
              impactPoint: new Vector3(...impact.point),
              impactDir: new Vector3(...impact.dir),
              kickEnergy: impact.energy * 0.1 * share,
              generation: impact.generation + 1,
            });
          });
          this.onDebris(majors, children.length);
        });
      });
    });
  }

  /** Damage to a collectible piece (tool or collision); it may break into smaller ones. */
  private hitFragment(frag: Fragment, impact: Impact): boolean {
    if (!this.damageEnabled || frag.kind !== "major" || frag.state === "held" || !canRefracture(frag.radius, frag.depth, frag.mass)) return false;
    const damage = computeDamage(impact, MATERIALS[frag.material], frag.material);
    if (damage < 0.5) return false;
    frag.hp -= damage;
    if (frag.hp > 0) return false;
    this.refracture(frag, impact);
    return true;
  }

  // ------------------------------------------------------------------ impacts

  /** A tool (or kick) strikes a collider. */
  applyHit(collider: Collider, impact: Impact): HitResult | null {
    const owner = this.ownerOf(collider) ?? this.fragmentOwner(collider.handle);
    if (!owner) {
      this.onFeedback({ material: "stone", energy: impact.energy, point: new Vector3(...impact.point), normal: new Vector3(...impact.normal), source: "tool", broke: false, toolId: impact.toolId });
      return null;
    }
    if (owner.kind === "fragment") {
      const frag = owner.frag;
      const body = frag.body;
      if (body) {
        const j = Math.min(impact.impulse, (impact.maxDeltaV ?? 5) * frag.mass);
        body.applyImpulseAtPoint({ x: impact.dir[0] * j, y: impact.dir[1] * j, z: impact.dir[2] * j }, { x: impact.point[0], y: impact.point[1], z: impact.point[2] }, true);
      }
      const broke = this.hitFragment(frag, impact);
      this.onFeedback({ material: frag.material, energy: impact.energy * (broke ? 1 : 0.5), point: new Vector3(...impact.point), normal: new Vector3(...impact.normal), source: "tool", broke, toolId: impact.toolId });
      return null;
    }
    return this.hitObject(owner.obj, owner.part, impact, "tool");
  }

  private hitObject(obj: Destructible, part: Part, impact: Impact, source: "tool" | "collision"): HitResult {
    const result = obj.applyImpact(this.damageEnabled ? impact : { ...impact, energy: 0 }, part);
    const point = new Vector3(...impact.point);
    this.onFeedback({ material: result.material, energy: impact.energy, point, normal: new Vector3(...impact.normal), source, broke: result.structural, toolId: impact.toolId });
    if (result.damage > 0) {
      this.events.emit("OBJECT_DAMAGED", { instanceId: obj.instanceId, health: obj.state.health, maxHealth: obj.state.maxHealth });
    }
    const oneHit = result.transitions.includes("damaged") && result.transitions.includes("destroyed");
    for (const stage of result.transitions) {
      if (stage === "broken") this.events.emit("OBJECT_FRACTURED", { instanceId: obj.instanceId });
      if (stage === "destroyed") this.events.emit("OBJECT_DESTROYED", { instanceId: obj.instanceId, definitionId: obj.definitionId });
      this.onStage({ obj, stage, impact, oneHit });
    }
    return result;
  }

  // ------------------------------------------------------------------ physics step

  afterStep(dt: number, events: EventQueue): void {
    this.time += dt;
    // Finished fractures become pieces a few objects per frame, never a long frame.
    const start = performance.now();
    while (this.spawnQueue.length > 0) {
      this.spawnQueue.shift()?.();
      if (performance.now() - start > SPAWN_BUDGET_MS) break;
    }
    for (const obj of this.objects.values()) {
      obj.afterStep();
      // Something fell out of the world: the game puts it back (it is still the player's).
      if (obj.alive && (obj.currPos.y < GAME.debris.lostBelowY || !WORLD_BOX.containsPoint(obj.currPos))) this.onObjectLost(obj);
    }
    events.drainContactForceEvents((event) => {
      this.handleContact(event.collider1(), event.collider2(), event.totalForceMagnitude() * dt);
    });
    this.debris.afterStep(dt);
    this.checkMajors(dt);
    this.settleStep();
  }

  /** True when one of the body's colliders has a real contact with something below it. */
  private supported(body: RigidBody): boolean {
    for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i);
      let found = false;
      this.world.contactPairsWith(collider, (other) => {
        if (found) return;
        this.world.contactPair(collider, other, (manifold, flipped) => {
          // The normal points from the first collider to the second: support pushes up on us.
          if (manifold.normal().y * (flipped ? -1 : 1) >= -0.5) return;
          // Predicted contacts count only when actually touching: a body hovering a centimetre
          // above the floor is not resting on it.
          for (let k = 0; k < manifold.numContacts(); k++) if (manifold.contactDist(k) < SETTLE.touch) found = true;
        });
      });
      if (found) return true;
    }
    return false;
  }

  private settleStep(): void {
    if (this.settling.length === 0) return;
    const ready: RigidBody[] = [];
    this.settling = this.settling.filter((s) => {
      const body = s.body();
      if (!body) return false;
      s.steps++;
      if (!body.isEnabled()) {
        // Picked up again (arrange ghost) before it settled.
        this.endSettle(body, s);
        return false;
      }
      if (s.steps < SETTLE.holdSteps) return true;
      if (s.steps === SETTLE.holdSteps) {
        body.setGravityScale(1, true);
        const v = body.linvel();
        const a = body.angvel();
        // Barely moving and actually resting on something: may sleep right away (if safe, below).
        if (Math.hypot(v.x, v.y, v.z) < 0.3 && Math.hypot(a.x, a.y, a.z) < 1 && this.supported(body)) ready.push(body);
        return true;
      }
      if (body.isSleeping() || s.steps >= SETTLE.maxSteps) {
        this.endSettle(body, s);
        return false;
      }
      return true;
    });
    if (ready.length === 0) return;
    // Rapier only handles sleep consistently per contact group: a body forced asleep while a
    // neighbour is awake keeps falling through it, and the solver then flings both apart. Bodies
    // whose every moving neighbour is going to sleep with them sleep now; the rest stay damped
    // until they sleep by themselves.
    const group = new Set(ready.map((b) => b.handle));
    for (const body of ready) {
      if (!this.quietNeighbours(body, group)) continue;
      body.sleep();
      const s = this.settling.find((x) => x.body() === body);
      if (s) {
        this.endSettle(body, s);
        this.settling = this.settling.filter((x) => x !== s);
      }
    }
  }

  private endSettle(body: RigidBody, s: Settling): void {
    body.setGravityScale(1, false);
    body.setLinearDamping(s.linear);
    body.setAngularDamping(s.angular);
  }

  /** No dynamic body touching `body` is awake, except those in `group` (sleeping together). */
  private quietNeighbours(body: RigidBody, group: ReadonlySet<number>): boolean {
    let quiet = true;
    for (let i = 0; i < body.numColliders() && quiet; i++) {
      this.world.contactPairsWith(body.collider(i), (other) => {
        const neighbour = other.parent();
        if (!neighbour || neighbour === body || !neighbour.isDynamic() || neighbour.isSleeping()) return;
        if (!group.has(neighbour.handle)) quiet = false;
      });
    }
    return quiet;
  }

  /** Street container disposal and lost-piece protection for collectible pieces. */
  private checkMajors(dt: number): void {
    const volume = this.disposalVolume;
    const settle = GAME.disposal;
    for (const f of this.debris.all()) {
      if (f.kind !== "major" || f.fade >= 0 || !f.body) continue;
      this.restAssist(f, dt);
      if (f.currPos.y < GAME.debris.lostBelowY || !WORLD_BOX.containsPoint(f.currPos)) {
        if (this.debris.setState(f, "lost")) {
          this.debris.fadeOut(f, 0.05);
          this.onLost(f);
        }
        continue;
      }
      if (!volume || f.state === "held") {
        f.insideTime = 0;
        continue;
      }
      // Only a piece that came to rest inside counts: a bounce off the rim does not.
      if (volume.containsPoint(f.currPos)) {
        const v = f.body.linvel();
        if (Math.hypot(v.x, v.y, v.z) < settle.settleSpeed) f.insideTime += dt;
        if (f.insideTime >= settle.settleSeconds && this.debris.setState(f, "disposed")) {
          this.debris.fadeOut(f, settle.fadeSeconds);
          this.onDisposed(f);
        }
      } else f.insideTime = 0;
    }
  }

  /**
   * A collectible piece that has only crept along for a while (jittering on a pile) is damped
   * hard until Rapier puts it to sleep by itself; a real push takes the damping off again.
   * Never a forced sleep: Rapier keeps integrating a body forced asleep beside an awake one.
   */
  private restAssist(f: Fragment, dt: number): void {
    const body = f.body;
    if (!body) return;
    const v = body.linvel();
    const w = body.angvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const slow = speed < REST.speed && Math.hypot(w.x, w.y, w.z) < REST.spin;
    if (f.state === "held" || body.isSleeping() || !slow) {
      if (f.restTime > REST.seconds && (f.state === "held" || speed > REST.wake)) {
        body.setLinearDamping(REST.normalLinear);
        body.setAngularDamping(REST.normalAngular);
      }
      if (!slow || f.state === "held") f.restTime = 0;
      return;
    }
    f.restTime += dt;
    if (f.restTime > REST.seconds && f.restTime - dt <= REST.seconds) {
      body.setLinearDamping(REST.linear);
      body.setAngularDamping(REST.angular);
    }
  }

  private generationOf(owner: Owner | undefined): number {
    if (!owner) return WORLD_GENERATION;
    return owner.kind === "object" ? owner.obj.generation : owner.frag.generation;
  }

  private massOf(owner: Owner | undefined): number {
    if (!owner) return Infinity;
    return owner.kind === "object" ? (owner.obj.held ? owner.obj.mass * 3 : owner.obj.mass) : owner.frag.mass;
  }

  private handleContact(h1: number, h2: number, impulse: number): void {
    const o1 = this.owners.get(h1) ?? this.fragmentOwner(h1);
    const o2 = this.owners.get(h2) ?? this.fragmentOwner(h2);
    if (!o1 && !o2) return;
    const energy = collisionEnergy(impulse, this.massOf(o1), this.massOf(o2));
    if (energy < 0.6) return;

    // Earlier events this step may have removed a collider and a new piece reused its slot
    // (Rapier's JS lookup ignores the handle generation): only trust exact handle matches.
    const c1 = this.world.getCollider(h1);
    const c2 = this.world.getCollider(h2);
    if (!c1 || !c2 || c1.handle !== h1 || c2.handle !== h2) return;
    let point: Vector3 | null = null;
    const normal = new Vector3(0, 1, 0);
    this.world.contactPair(c1, c2, (manifold, flipped) => {
      if (point || manifold.numSolverContacts() === 0) return;
      const p = manifold.solverContactPoint(0);
      const n = manifold.normal();
      if (!p) return;
      point = new Vector3(p.x, p.y, p.z);
      normal.set(n.x, n.y, n.z);
      if (flipped) normal.negate();
    });
    if (!point) return;

    const g1 = this.generationOf(o1);
    const g2 = this.generationOf(o2);
    // normal points from collider 1 towards collider 2.
    this.collisionSide(o1, o2, point, normal.clone().negate(), energy, Math.min(g1, g2 + 1));
    this.collisionSide(o2, o1, point, normal, energy, Math.min(g2, g1 + 1));
  }

  private fragmentOwner(handle: number): Owner | undefined {
    const frag = this.debris.byCollider(handle);
    return frag ? { kind: "fragment", frag } : undefined;
  }

  /** Damage/sound for `self` being hit by `other`. `inward` is the force direction into self. */
  private collisionSide(self: Owner | undefined, other: Owner | undefined, point: Vector3, inward: Vector3, energy: number, generation: number): void {
    if (!self) return;
    const handle = self.kind === "object" ? (self.part.collider?.handle ?? -1) : (self.frag.collider?.handle ?? -1);
    const last = this.soundCooldown.get(handle) ?? -Infinity;
    const material = self.kind === "object" ? self.part.mat : self.frag.material;
    const hardness = !other ? 1.25 : other.kind === "object" ? 1 : 0.85;
    const impact: Impact = {
      point: [point.x, point.y, point.z],
      normal: [-inward.x, -inward.y, -inward.z],
      dir: [inward.x, inward.y, inward.z],
      energy,
      impulse: 0,
      contactRadius: 0.02,
      affinity: hardness,
      source: "collision",
      generation: Math.max(0, generation),
    };
    const damaging = energy >= GAME.destruction.minCollisionEnergy && generation <= GAME.destruction.maxCascadeGeneration;

    if (self.kind === "fragment") {
      const broke = damaging && energy > GAME.destruction.minCollisionEnergy * 3 && this.hitFragment(self.frag, impact);
      if ((energy > 1.2 && this.time - last > SOUND_COOLDOWN) || broke) {
        this.soundCooldown.set(handle, this.time);
        this.onFeedback({ material, energy, point, source: "collision", broke });
      }
      return;
    }
    if (!damaging) {
      if (energy > 1.2 && this.time - last > SOUND_COOLDOWN) {
        this.soundCooldown.set(handle, this.time);
        this.onFeedback({ material, energy, point, source: "collision", broke: false });
      }
      return;
    }
    this.soundCooldown.set(handle, this.time);
    this.hitObject(self.obj, self.part, impact, "collision");
  }

  render(alpha: number, dt: number): void {
    for (const obj of this.objects.values()) obj.render(alpha, dt);
    this.debris.render(alpha);
  }

  /** Objects currently resting count as untouched for cascade purposes. */
  static readonly RESTING = RESTING;
}
