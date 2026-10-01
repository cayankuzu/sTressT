import RAPIER, { type Collider, type RigidBody, type World } from "@dimforge/rapier3d";
import { BatchedMesh, BufferAttribute, BufferGeometry, Matrix4, type MeshStandardMaterial, Quaternion, type Scene, Vector3 } from "three";
import { GAME, GROUPS } from "../config/gameConfig";
import { MATERIALS } from "../data/catalog";
import type { MaterialType } from "../data/types";
import type { DebrisRecord } from "../save/schema";
import { canTransition, type DebrisKind, type DebrisState } from "./debrisRules";
import type { PreparedPiece } from "./geometry/prepare";
import { materialAt } from "./Template";
import { fragmentMaterial } from "./materials";

const D = GAME.destruction;
const MAX_STATIC_FRAGMENTS = 700;

/** One BatchedMesh per source material: every piece of every tea cup is a single draw call. */
class FragmentBatch {
  mesh: BatchedMesh;
  private maxVertices: number;
  private maxInstances: number;

  constructor(
    scene: Scene,
    material: MeshStandardMaterial,
    initialVertices: number,
  ) {
    this.maxVertices = Math.max(4096, initialVertices);
    this.maxInstances = 64;
    this.mesh = new BatchedMesh(this.maxInstances, this.maxVertices, this.maxVertices, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.sortObjects = material.transparent;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  add(geometry: BufferGeometry): { geometryId: number; instanceId: number } {
    const vertices = geometry.getAttribute("position").count;
    let geometryId: number;
    try {
      geometryId = this.mesh.addGeometry(geometry);
    } catch {
      this.mesh.optimize();
      try {
        geometryId = this.mesh.addGeometry(geometry);
      } catch {
        this.maxVertices = Math.max(this.maxVertices * 2, this.maxVertices + vertices * 2);
        this.mesh.setGeometrySize(this.maxVertices, this.maxVertices);
        geometryId = this.mesh.addGeometry(geometry);
      }
    }
    if (this.mesh.instanceCount >= this.maxInstances) {
      this.maxInstances *= 2;
      this.mesh.setInstanceCount(this.maxInstances);
    }
    return { geometryId, instanceId: this.mesh.addInstance(geometryId) };
  }

  remove(geometryId: number, instanceId: number): void {
    this.mesh.deleteInstance(instanceId);
    this.mesh.deleteGeometry(geometryId);
  }

  dispose(scene: Scene): void {
    scene.remove(this.mesh);
    this.mesh.dispose();
  }
}

/** A piece whose centre is below floor level by this much is mostly inside the floor (m). */
const UNDER_FLOOR = -0.012;

export type Fragment = {
  /** Major pieces: `<object>.d<n>[.<k>]` (saved, never reused). Others: runtime-only. */
  id: string;
  kind: DebrisKind;
  state: DebrisState;
  parentId: string;
  definitionId: string;
  body: RigidBody | null;
  collider: Collider | null;
  parts: { batch: FragmentBatch; geometryId: number; instanceId: number }[];
  radius: number;
  mass: number;
  material: MaterialType;
  hp: number;
  maxHp: number;
  /** 1 = piece of an object, 2 = piece of a piece... */
  depth: number;
  /** Credits paid when this piece is disposed of (major pieces only). */
  cleanupValue: number;
  /** Prepared geometry, kept for major pieces (saving, breaking again). */
  piece: PreparedPiece | null;
  generation: number;
  age: number;
  moving: boolean;
  /** Seconds left of a shrink-out (-1 = not fading). */
  fade: number;
  fadeTotal: number;
  /** Seconds spent settled inside the street container. */
  insideTime: number;
  /** Seconds spent barely moving while awake (a piece creeping on a pile). */
  restTime: number;
  /** Next child index when this piece breaks again. */
  childSeq: number;
  prevPos: Vector3;
  currPos: Vector3;
  prevQuat: Quaternion;
  currQuat: Quaternion;
};

export type FragmentSpawn = {
  id: string;
  kind: DebrisKind;
  parentId: string;
  definitionId: string;
  /** Prepared piece (centroid in the parent's local space, geometry re-centred on it). */
  piece: PreparedPiece;
  parentPosition: Vector3;
  parentQuaternion: Quaternion;
  materials: MeshStandardMaterial[];
  mass: number;
  hp: number;
  depth: number;
  cleanupValue: number;
  /** Parent body velocity at a world point (so pieces keep the object's momentum). */
  velocityAt: (p: Vector3) => Vector3;
  impactPoint: Vector3;
  impactDir: Vector3;
  /** Kinetic energy budget for this piece (J). */
  kickEnergy: number;
  generation: number;
};

const tmpMatrix = new Matrix4();
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const unit = new Vector3(1, 1, 1);
const scaled = new Vector3();

/** Collision groups by size: small pieces skip colliding with each other. */
function groupFor(radius: number): number {
  return radius < 0.07 ? GROUPS.debrisSmall : GROUPS.debris;
}

export class Debris {
  private batches = new Map<string, FragmentBatch>();
  private fragments: Fragment[] = [];
  private byHandle = new Map<number, Fragment>();
  private nextRuntimeId = 1;

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
  ) {}

  get count(): number {
    return this.fragments.length;
  }

  get activeCount(): number {
    let n = 0;
    for (const f of this.fragments) if (f.body) n++;
    return n;
  }

  get anyMoving(): boolean {
    return this.fragments.some((f) => f.moving || f.fade >= 0);
  }

  /** Major pieces still in the world (held or lying around). */
  majors(): Fragment[] {
    return this.fragments.filter((f) => f.kind === "major" && f.fade < 0 && (f.state === "active" || f.state === "held" || f.state === "thrown"));
  }

  byCollider(handle: number): Fragment | undefined {
    return this.byHandle.get(handle);
  }

  all(): readonly Fragment[] {
    return this.fragments;
  }

  runtimeId(): string {
    return `m${this.nextRuntimeId++}`;
  }

  spawn(req: FragmentSpawn): Fragment | null {
    const piece = req.piece;
    if (piece.slots.length === 0 || !(piece.radius > 0.002)) return null;
    const material = materialAt(piece.mat);
    const mat = MATERIALS[material];

    const worldPos = new Vector3(...piece.centroid).applyQuaternion(req.parentQuaternion).add(req.parentPosition);
    const quat = req.parentQuaternion.clone();
    const mass = Math.max(0.01, req.mass);
    const micro = req.kind === "micro";

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(worldPos.x, worldPos.y, worldPos.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
        .setLinearDamping(0.08)
        .setAngularDamping(micro ? 0.6 : 0.2),
    );
    const collider = this.createCollider(piece, micro, mass, material, body);

    // Pieces keep the parent's motion plus a kick along the impact, stronger near the impact point.
    const v = req.velocityAt(worldPos).clone();
    const toPiece = worldPos.clone().sub(req.impactPoint);
    const dist = toPiece.length();
    const radial = dist > 1e-4 ? toPiece.divideScalar(dist) : new Vector3(0, 1, 0);
    const proximity = Math.exp(-(dist * dist) / 0.08);
    const speed = Math.min(7, Math.sqrt((2 * Math.max(0, req.kickEnergy) * (0.35 + proximity)) / mass));
    const kick = req.impactDir.clone().multiplyScalar(0.75).addScaledVector(radial, 0.35).add(new Vector3(0, 0.15, 0)).normalize();
    v.addScaledVector(kick, speed);
    // No CCD on pieces: on thin hulls Rapier's CCD lets them through the floor more often, not less
    // (measured: 2-4 of 16 alarm clock shards with it, 0-1 without). The floor rescue below
    // catches the rare one that still slips in.
    body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    const spin = (speed * 2.5) / (1 + piece.radius * 12);
    body.setAngvel({ x: (Math.random() - 0.5) * spin, y: (Math.random() - 0.5) * spin, z: (Math.random() - 0.5) * spin }, true);

    return this.register(req, body, collider, worldPos, quat, mass, material, mat.interiorColor);
  }

  /** Re-creates a saved major piece where it was left, at rest. */
  restore(rec: DebrisRecord, materials: MeshStandardMaterial[]): Fragment | null {
    const piece: PreparedPiece = { centroid: [0, 0, 0], radius: rec.radius, area: rec.area, min: rec.min, max: rec.max, hull: rec.hull, mat: rec.mat, slots: rec.slots };
    const pos = new Vector3(...rec.position);
    const quat = new Quaternion(...rec.rotation);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w })
        .setLinearDamping(0.08)
        .setAngularDamping(0.2),
    );
    const collider = this.createCollider(piece, false, rec.mass, rec.material, body);
    const req: FragmentSpawn = {
      id: rec.id,
      kind: "major",
      parentId: rec.parentId,
      definitionId: rec.definitionId,
      piece,
      parentPosition: pos,
      parentQuaternion: quat,
      materials,
      mass: rec.mass,
      hp: rec.hp,
      depth: rec.depth,
      cleanupValue: rec.cleanupValue,
      velocityAt: () => new Vector3(),
      impactPoint: pos,
      impactDir: new Vector3(0, -1, 0),
      kickEnergy: 0,
      generation: 99,
    };
    const f = this.register(req, body, collider, pos, quat, rec.mass, rec.material, MATERIALS[rec.material].interiorColor);
    f.maxHp = rec.maxHp;
    f.moving = false;
    return f;
  }

  private register(req: FragmentSpawn, body: RigidBody, collider: Collider, worldPos: Vector3, quat: Quaternion, mass: number, material: MaterialType, interiorColor: string): Fragment {
    const parts: Fragment["parts"] = [];
    for (const slot of req.piece.slots) {
      const source = req.materials[slot.slot];
      if (!source) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(slot.pos, 3));
      geometry.setAttribute("normal", new BufferAttribute(slot.nrm, 3));
      geometry.setAttribute("uv", new BufferAttribute(slot.uv, 2));
      geometry.boundingSphere = null;
      geometry.computeBoundingSphere();
      const batch = this.batchFor(fragmentMaterial(source, interiorColor), slot.pos.length / 3);
      const { geometryId, instanceId } = batch.add(geometry);
      geometry.dispose();
      batch.mesh.setMatrixAt(instanceId, tmpMatrix.compose(worldPos, quat, unit));
      parts.push({ batch, geometryId, instanceId });
    }
    const fragment: Fragment = {
      id: req.id,
      kind: req.kind,
      state: "active",
      parentId: req.parentId,
      definitionId: req.definitionId,
      body,
      collider,
      parts,
      radius: req.piece.radius,
      mass,
      material,
      hp: req.hp,
      maxHp: req.hp,
      depth: req.depth,
      cleanupValue: req.kind === "major" ? req.cleanupValue : 0,
      piece: req.kind === "major" ? req.piece : null,
      generation: req.generation,
      age: 0,
      moving: true,
      fade: -1,
      fadeTotal: 1,
      insideTime: 0,
      restTime: 0,
      childSeq: 0,
      prevPos: worldPos.clone(),
      currPos: worldPos.clone(),
      prevQuat: quat.clone(),
      currQuat: quat.clone(),
    };
    this.fragments.push(fragment);
    this.byHandle.set(collider.handle, fragment);
    return fragment;
  }

  /**
   * The piece's collider. Rapier only computes a hull when the collider is created, and throws
   * there if the points are degenerate (a paper-thin shard): such a piece gets a thin box instead.
   */
  private createCollider(piece: PreparedPiece, micro: boolean, mass: number, material: MaterialType, body: RAPIER.RigidBody): RAPIER.Collider {
    const shape = micro ? RAPIER.ColliderDesc.ball(Math.max(0.006, piece.radius * 0.7)) : RAPIER.ColliderDesc.convexHull(piece.hull);
    if (shape) {
      try {
        return this.world.createCollider(this.finishDesc(shape, piece, mass, material), body);
      } catch {
        // falls through to the box
      }
    }
    const { min, max } = piece;
    const box = RAPIER.ColliderDesc.cuboid(
      Math.max(0.004, (max[0] - min[0]) / 2),
      Math.max(0.004, (max[1] - min[1]) / 2),
      Math.max(0.004, (max[2] - min[2]) / 2),
    ).setTranslation((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    return this.world.createCollider(this.finishDesc(box, piece, mass, material), body);
  }

  private finishDesc(desc: RAPIER.ColliderDesc, piece: PreparedPiece, mass: number, material: MaterialType): RAPIER.ColliderDesc {
    const m = MATERIALS[material];
    return desc
      .setMass(mass)
      .setFriction(m.friction)
      .setRestitution(m.restitution)
      .setCollisionGroups(groupFor(piece.radius))
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(mass * 9.81 * 6 + 1.5);
  }

  private batchFor(material: MeshStandardMaterial, vertexHint: number): FragmentBatch {
    let batch = this.batches.get(material.uuid);
    if (!batch) {
      // Generous first allocation: growing a batch reallocates and re-uploads its whole buffer.
      batch = new FragmentBatch(this.scene, material, Math.max(16384, vertexHint * 8));
      this.batches.set(material.uuid, batch);
    }
    return batch;
  }

  /** Validated state change (illegal moves such as disposed -> held are refused). */
  setState(f: Fragment, to: DebrisState): boolean {
    if (f.state === to) return true;
    if (!canTransition(f.state, to)) return false;
    f.state = to;
    if (to === "held") f.collider?.setCollisionGroups(GROUPS.held);
    else if (to === "active" || to === "thrown") f.collider?.setCollisionGroups(groupFor(f.radius));
    return true;
  }

  /** After each physics step: record transforms, age pieces, enforce budgets. */
  /**
   * Where a piece may never be (set by the game from the world layout): returns the place to put
   * it back, or null when it is fine. Clutter found there is removed; a collectible piece is put
   * back (it is the player's money). A safety net like the floor rescue: whatever slipped through.
   */
  confine: ((x: number, y: number, z: number, margin: number) => [number, number, number] | null) | null = null;

  afterStep(dt: number): void {
    const maxV = GAME.physics.maxLinearSpeed;
    for (const f of this.fragments) {
      f.age += dt;
      const body = f.body;
      if (!body) continue;
      const sleeping = body.isSleeping();
      if (sleeping && !f.moving) continue;
      f.prevPos.copy(f.currPos);
      f.prevQuat.copy(f.currQuat);
      const t = body.translation();
      if (t.y < UNDER_FLOOR && t.y > GAME.debris.lostBelowY) {
        // Every floor in the game is at y = 0: put it back on top, at rest.
        body.setTranslation({ x: t.x, y: Math.max(0.02, f.radius * 0.5), z: t.z }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        t.y = Math.max(0.02, f.radius * 0.5);
      }
      const back = f.state === "held" || !this.confine ? null : this.confine(t.x, t.y, t.z, Math.max(0.05, f.radius));
      if (back) {
        if (f.kind !== "major") {
          this.fadeOut(f, 0.05);
          continue;
        }
        body.setTranslation({ x: back[0], y: back[1], z: back[2] }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        t.x = back[0];
        t.y = back[1];
        t.z = back[2];
      }
      const r = body.rotation();
      f.currPos.set(t.x, t.y, t.z);
      f.currQuat.set(r.x, r.y, r.z, r.w);
      // Last write happens on the step the body falls asleep, so the final pose is exact.
      f.moving = !sleeping;
      if (sleeping && f.state === "thrown") this.setState(f, "active");
      const lv = body.linvel();
      const speed = Math.hypot(lv.x, lv.y, lv.z);
      if (speed > maxV) body.setLinvel({ x: (lv.x / speed) * maxV, y: (lv.y / speed) * maxV, z: (lv.z / speed) * maxV }, true);
    }

    for (let i = this.fragments.length - 1; i >= 0; i--) {
      const f = this.fragments[i] as Fragment;
      if (f.fade >= 0) {
        f.fade -= dt;
        if (f.fade <= 0) this.remove(f, i);
        continue;
      }
      // Crumbs live a few seconds; anything non-major that falls out of the world just goes.
      if ((f.kind === "micro" && f.age > D.microFragmentLifetime) || (f.kind !== "major" && f.currPos.y < GAME.debris.lostBelowY)) this.remove(f, i);
    }

    // Only clutter is ever frozen or culled: collectible pieces stay fully physical.
    let active = this.activeCount;
    if (active > D.maxActiveFragments) {
      const candidates = this.fragments.filter((f) => f.body && f.kind !== "major").sort((a, b) => Number(a.moving) - Number(b.moving) || b.age - a.age);
      for (const f of candidates) {
        if (active <= D.maxActiveFragments) break;
        this.freeze(f);
        active--;
      }
    }
    if (this.fragments.length > MAX_STATIC_FRAGMENTS) {
      for (let i = 0; i < this.fragments.length && this.fragments.length > MAX_STATIC_FRAGMENTS; i++) {
        const f = this.fragments[i] as Fragment;
        if (!f.body && f.kind !== "major") this.remove(f, i--);
      }
    }
  }

  /** Writes interpolated transforms of moving (and shrinking) pieces into their batches. */
  render(alpha: number): void {
    for (const f of this.fragments) {
      if (f.fade >= 0) {
        const s = Math.max(0.001, f.fade / f.fadeTotal);
        tmpMatrix.compose(f.currPos, f.currQuat, scaled.set(s, s, s));
        for (const p of f.parts) p.batch.mesh.setMatrixAt(p.instanceId, tmpMatrix);
        continue;
      }
      if (!f.body || (!f.moving && f.prevPos.equals(f.currPos))) continue;
      tmpPos.lerpVectors(f.prevPos, f.currPos, alpha);
      tmpQuat.slerpQuaternions(f.prevQuat, f.currQuat, alpha);
      tmpMatrix.compose(tmpPos, tmpQuat, unit);
      for (const p of f.parts) p.batch.mesh.setMatrixAt(p.instanceId, tmpMatrix);
      if (!f.moving) f.prevPos.copy(f.currPos);
    }
  }

  private freeze(f: Fragment): void {
    if (!f.body) return;
    tmpMatrix.compose(f.currPos, f.currQuat, unit);
    for (const p of f.parts) p.batch.mesh.setMatrixAt(p.instanceId, tmpMatrix);
    this.dropBody(f);
  }

  private dropBody(f: Fragment): void {
    if (f.collider) this.byHandle.delete(f.collider.handle);
    if (f.body) this.world.removeRigidBody(f.body);
    f.body = null;
    f.collider = null;
    f.moving = false;
  }

  /** Shrinks the piece out of existence over `seconds` (its physics stops at once). */
  fadeOut(f: Fragment, seconds: number): void {
    if (f.fade >= 0) return;
    this.dropBody(f);
    f.fade = f.fadeTotal = Math.max(0.05, seconds);
  }

  /** End of a break session: every non-collectible piece clears itself. */
  fadeClutter(seconds: number): void {
    for (const f of this.fragments) if (f.kind !== "major") this.fadeOut(f, seconds * (0.7 + Math.random() * 0.6));
  }

  remove(f: Fragment, index = this.fragments.indexOf(f)): void {
    this.dropBody(f);
    for (const p of f.parts) p.batch.remove(p.geometryId, p.instanceId);
    f.parts = [];
    if (index >= 0) this.fragments.splice(index, 1);
  }

  /** Snapshot of a major piece for the save. */
  serialize(f: Fragment): DebrisRecord | null {
    const piece = f.piece;
    if (f.kind !== "major" || !piece || f.fade >= 0 || f.state === "disposed" || f.state === "lost") return null;
    return {
      id: f.id,
      parentId: f.parentId,
      definitionId: f.definitionId,
      material: f.material,
      mass: f.mass,
      hp: Math.max(0, f.hp),
      maxHp: f.maxHp,
      depth: f.depth,
      cleanupValue: f.cleanupValue,
      position: [f.currPos.x, f.currPos.y, f.currPos.z],
      rotation: [f.currQuat.x, f.currQuat.y, f.currQuat.z, f.currQuat.w],
      radius: piece.radius,
      area: piece.area,
      min: piece.min,
      max: piece.max,
      hull: piece.hull,
      mat: piece.mat,
      slots: piece.slots,
    };
  }

  /** Removes every fragment and releases all GPU buffers (loading another game). */
  clear(): void {
    for (const f of this.fragments) if (f.body) this.world.removeRigidBody(f.body);
    this.fragments = [];
    this.byHandle.clear();
    for (const batch of this.batches.values()) batch.dispose(this.scene);
    this.batches.clear();
  }
}
