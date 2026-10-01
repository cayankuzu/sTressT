import { MATERIAL_TYPES, type MaterialType, type ObjectOrigin } from "../data/types";
import { OBJECTS, ROOM, STARTER_TOOL_ID, TOOLS } from "../data/catalog";
import { cloneProgress, defaultProgress, EMPTY_STATS, type ProgressState, type ReturningObject, type Statistics } from "../economy/state";
import { roomToWorld } from "../world/layout";

/**
 * Save format v3: one complete snapshot of a game (economy + the physical world). Everything the
 * player did is in it: what they own, what stands where, what is broken (down to the dented
 * geometry), which debris still lies around. Typed arrays are stored as-is (IndexedDB clones them).
 */
export const SCHEMA_VERSION = 3;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type Mode = "arrange" | "break" | "cleanup";

export type SoupData = { pos: Float32Array; nrm: Float32Array; uv: Float32Array; slot: Uint8Array; mat: Uint8Array };

/** One structural part of an object. `soup` null = the template's untouched geometry. */
export type PartRecord = { seed: number; mat: MaterialType; hp: number; maxHp: number; soup: SoupData | null };

export type DecalKind = "crack" | "glass" | "scuff";

/** A crack or scuff mark, in the object's local space (re-projected on load). */
export type DecalRecord = { point: Vec3; normal: Vec3; size: number; spin: number; variant: number; kind: DecalKind };

export type ObjectStage = "intact" | "damaged" | "broken";

export type ObjectRecord = {
  id: string;
  definitionId: string;
  origin: ObjectOrigin;
  foundItemId?: string;
  position: Vec3;
  rotation: Quat;
  stage: ObjectStage;
  health: number;
  deformUsed: number;
  /** Number of debris pieces this object has shed so far (keeps piece ids unique across reloads). */
  debrisSeq: number;
  /** null = never changed shape: rebuilt from the template. */
  parts: PartRecord[] | null;
  decals: DecalRecord[];
};

export type PieceSlot = { slot: number; pos: Float32Array; nrm: Float32Array; uv: Float32Array };

/** A major (collectible) piece of debris with its exact geometry. */
export type DebrisRecord = {
  id: string;
  parentId: string;
  definitionId: string;
  material: MaterialType;
  mass: number;
  hp: number;
  maxHp: number;
  depth: number;
  cleanupValue: number;
  position: Vec3;
  rotation: Quat;
  radius: number;
  area: number;
  min: Vec3;
  max: Vec3;
  hull: Float32Array;
  mat: number;
  slots: PieceSlot[];
};

export type SaveData = {
  schemaVersion: typeof SCHEMA_VERSION;
  saveId: string;
  profileId: string;
  slot: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  playtimeSeconds: number;
  mode: Mode;
  progress: ProgressState;
  objects: ObjectRecord[];
  debris: DebrisRecord[];
  /**
   * Objects from an older save with no place in the world yet (the former storage, or a v1/v2
   * object inventory). The game delivers them to the street drop zone on load; a save written
   * afterwards has them in `objects`.
   */
  returning?: ReturningObject[];
};

/** Small listing data shown on save cards (stored next to the save, read without loading it). */
export type SlotSummary = {
  slot: number;
  name: string;
  credits: number;
  tools: number;
  objects: number;
  playtimeSeconds: number;
  updatedAt: number;
};

export function summarize(save: SaveData): SlotSummary {
  return {
    slot: save.slot,
    name: save.name,
    credits: save.progress.credits,
    tools: save.progress.ownedTools.length + save.progress.toolDeliveries.length,
    objects: save.objects.length + (save.returning?.length ?? 0),
    playtimeSeconds: Math.floor(save.playtimeSeconds),
    updatedAt: save.updatedAt,
  };
}

const yawQuat = (deg: number): Quat => {
  const half = (deg * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
};

/** Objects of a brand-new game: the starter room, plus the one-time finds lying on the street. */
export function starterObjects(): ObjectRecord[] {
  const found: ObjectRecord[] = ROOM.foundItems.map((f): ObjectRecord => ({
    id: f.id,
    definitionId: f.definitionId,
    origin: "found",
    foundItemId: f.id,
    position: [f.position[0], f.position[1], f.position[2]],
    rotation: yawQuat(f.rotationY),
    stage: "intact",
    health: OBJECTS[f.definitionId]?.health ?? 1,
    deformUsed: 0,
    debrisSeq: 0,
    parts: null,
    decals: [],
  }));
  return [...found, ...ROOM.starterLayout.map((p): ObjectRecord => ({
    id: p.instanceId,
    definitionId: p.definitionId,
    origin: "starter",
    position: roomToWorld(p.position),
    rotation: yawQuat(p.rotationY),
    stage: "intact",
    health: OBJECTS[p.definitionId]?.health ?? 1,
    deformUsed: 0,
    debrisSeq: 0,
    parts: null,
    decals: [],
  }))];
}

export function newSave(profileId: string, slot: number, name: string, saveId: string): SaveData {
  const now = Date.now();
  return {
    schemaVersion: SCHEMA_VERSION,
    saveId,
    profileId,
    slot,
    name,
    createdAt: now,
    updatedAt: now,
    playtimeSeconds: 0,
    mode: "arrange",
    progress: defaultProgress(),
    objects: starterObjects(),
    debris: [],
  };
}

// ---------------------------------------------------------------- validation

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const finiteOr = (v: unknown, fallback: number): number => (finite(v) ? v : fallback);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const count = (v: unknown): number => Math.max(0, Math.floor(finiteOr(v, 0)));
const ID = /^[\w.:-]{1,80}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID.test(v);

function vec3(v: unknown, lo = -1000, hi = 1000): Vec3 | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(finite)) return null;
  const [x, y, z] = v as [number, number, number];
  return [clamp(x, lo, hi), clamp(y, lo, hi), clamp(z, lo, hi)];
}

function quat(v: unknown): Quat | null {
  if (!Array.isArray(v) || v.length !== 4 || !v.every(finite)) return null;
  const [x, y, z, w] = v as [number, number, number, number];
  const len = Math.hypot(x, y, z, w);
  if (!(len > 1e-6)) return null;
  return [x / len, y / len, z / len, w / len];
}

function allFinite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i] as number)) return false;
  return true;
}

function soupData(v: unknown): SoupData | null {
  if (!isRecord(v)) return null;
  const { pos, nrm, uv, slot, mat } = v;
  if (!(pos instanceof Float32Array && nrm instanceof Float32Array && uv instanceof Float32Array && slot instanceof Uint8Array && mat instanceof Uint8Array)) return null;
  const n = slot.length;
  if (n === 0 || mat.length !== n || pos.length !== n * 9 || nrm.length !== n * 9 || uv.length !== n * 6) return null;
  if (!allFinite(pos) || !allFinite(nrm) || !allFinite(uv)) return null;
  for (let i = 0; i < n; i++) if ((mat[i] as number) >= MATERIAL_TYPES.length) return null;
  return { pos, nrm, uv, slot, mat };
}

const isMaterial = (v: unknown): v is MaterialType => typeof v === "string" && (MATERIAL_TYPES as readonly string[]).includes(v);

function partRecord(v: unknown): PartRecord | null {
  if (!isRecord(v) || !isMaterial(v.mat)) return null;
  const seed = Math.floor(finiteOr(v.seed, -1));
  const soup = v.soup === null || v.soup === undefined ? null : soupData(v.soup);
  if (v.soup && !soup) return null;
  if (seed < 0 && !soup) return null;
  const maxHp = v.maxHp === null || v.maxHp === Infinity ? Infinity : finiteOr(v.maxHp, 1);
  const hp = v.hp === Infinity || v.hp === null ? Infinity : finiteOr(v.hp, maxHp);
  return { seed, mat: v.mat, hp, maxHp, soup };
}

function decalRecord(v: unknown): DecalRecord | null {
  if (!isRecord(v)) return null;
  const point = vec3(v.point, -10, 10);
  const normal = vec3(v.normal, -1, 1);
  if (!point || !normal) return null;
  const kind = v.kind === "glass" || v.kind === "scuff" ? v.kind : "crack";
  return { point, normal, size: clamp(finiteOr(v.size, 0.08), 0.01, 0.6), spin: finiteOr(v.spin, 0), variant: clamp(Math.floor(finiteOr(v.variant, 0)), 0, 3), kind };
}

const STAGES = new Set(["intact", "damaged", "broken"]);
const ORIGINS = new Set(["starter", "found", "purchased"]);

function objectRecord(v: unknown): ObjectRecord | null {
  if (!isRecord(v) || !isId(v.id) || typeof v.definitionId !== "string") return null;
  const def = OBJECTS[v.definitionId];
  const position = vec3(v.position, -60, 60);
  const rotation = quat(v.rotation);
  if (!def || !position || !rotation) return null;
  let parts: PartRecord[] | null = null;
  if (Array.isArray(v.parts)) {
    parts = v.parts.map(partRecord).filter((p): p is PartRecord => p !== null);
    if (parts.length === 0) return null; // an object with no parts left cannot exist
  }
  return {
    id: v.id,
    definitionId: v.definitionId,
    origin: ORIGINS.has(v.origin as string) ? (v.origin as ObjectOrigin) : "purchased",
    ...(isId(v.foundItemId) ? { foundItemId: v.foundItemId } : {}),
    position,
    rotation,
    stage: STAGES.has(v.stage as string) ? (v.stage as ObjectStage) : "intact",
    health: clamp(finiteOr(v.health, def.health), 0, def.health),
    deformUsed: Math.max(0, finiteOr(v.deformUsed, 0)),
    debrisSeq: count(v.debrisSeq),
    parts,
    decals: Array.isArray(v.decals) ? v.decals.map(decalRecord).filter((d): d is DecalRecord => d !== null).slice(0, 16) : [],
  };
}

function debrisRecord(v: unknown): DebrisRecord | null {
  if (!isRecord(v) || !isId(v.id) || !isId(v.parentId) || typeof v.definitionId !== "string" || !OBJECTS[v.definitionId] || !isMaterial(v.material)) return null;
  const position = vec3(v.position, -60, 60);
  const rotation = quat(v.rotation);
  const min = vec3(v.min, -5, 5);
  const max = vec3(v.max, -5, 5);
  if (!position || !rotation || !min || !max || !(v.hull instanceof Float32Array) || v.hull.length % 3 !== 0 || !allFinite(v.hull)) return null;
  if (!Array.isArray(v.slots) || v.slots.length === 0) return null;
  const slots: PieceSlot[] = [];
  for (const s of v.slots) {
    if (!isRecord(s) || !(s.pos instanceof Float32Array) || !(s.nrm instanceof Float32Array) || !(s.uv instanceof Float32Array)) return null;
    const tris = s.pos.length / 9;
    if (!Number.isInteger(tris) || tris === 0 || s.nrm.length !== s.pos.length || s.uv.length !== tris * 6 || !allFinite(s.pos)) return null;
    slots.push({ slot: clamp(Math.floor(finiteOr(s.slot, 0)), 0, 255), pos: s.pos, nrm: s.nrm, uv: s.uv });
  }
  const maxHp = Math.max(1, finiteOr(v.maxHp, 10));
  return {
    id: v.id,
    parentId: v.parentId,
    definitionId: v.definitionId,
    material: v.material,
    mass: clamp(finiteOr(v.mass, 0.1), 0.01, 100),
    hp: clamp(finiteOr(v.hp, maxHp), 0, maxHp),
    maxHp,
    depth: clamp(Math.floor(finiteOr(v.depth, 1)), 1, 8),
    cleanupValue: Math.max(0, finiteOr(v.cleanupValue, 0)),
    position,
    rotation,
    radius: clamp(finiteOr(v.radius, 0.05), 0.002, 5),
    area: Math.max(0, finiteOr(v.area, 0)),
    min,
    max,
    hull: v.hull,
    mat: clamp(Math.floor(finiteOr(v.mat, 0)), 0, MATERIAL_TYPES.length - 1),
    slots,
  };
}

function statistics(v: unknown): Statistics {
  const stats = { ...EMPTY_STATS };
  if (isRecord(v)) for (const key of Object.keys(stats) as (keyof Statistics)[]) stats[key] = count(v[key]);
  return stats;
}

function progress(v: unknown): ProgressState {
  const base = defaultProgress();
  if (!isRecord(v)) return base;
  const ownedTools = Array.isArray(v.ownedTools) ? [...new Set(v.ownedTools.filter((t): t is string => typeof t === "string" && !!TOOLS[t]))] : [];
  if (!ownedTools.includes(STARTER_TOOL_ID)) ownedTools.unshift(STARTER_TOOL_ID);
  const equipped = typeof v.equippedToolId === "string" && ownedTools.includes(v.equippedToolId) ? v.equippedToolId : STARTER_TOOL_ID;
  const deliveries: ProgressState["toolDeliveries"] = [];
  if (Array.isArray(v.toolDeliveries)) {
    for (const d of v.toolDeliveries) {
      if (!isRecord(d) || !isId(d.id) || typeof d.toolId !== "string" || !TOOLS[d.toolId]) continue;
      if (ownedTools.includes(d.toolId) || deliveries.some((x) => x.toolId === d.toolId || x.id === d.id)) continue;
      deliveries.push({ id: d.id, toolId: d.toolId });
    }
  }
  const strings = (a: unknown): string[] => (Array.isArray(a) ? [...new Set(a.filter((x): x is string => typeof x === "string" && x.length < 120))] : []);
  const counters = isRecord(v.counters) ? v.counters : {};
  const flags: Record<string, boolean> = {};
  if (isRecord(v.tutorialFlags)) for (const [k, f] of Object.entries(v.tutorialFlags)) if (typeof f === "boolean" && k.length < 40) flags[k] = f;
  return {
    credits: Math.min(count(v.credits), 1_000_000_000),
    ownedTools,
    equippedToolId: equipped,
    toolDeliveries: deliveries,
    claimedFoundItems: strings(v.claimedFoundItems).filter((id) => ROOM.foundItems.some((f) => f.id === id)),
    rewardLedger: strings(v.rewardLedger),
    counters: { object: count(counters.object), delivery: count(counters.delivery), session: count(counters.session) },
    statistics: statistics(v.statistics),
    tutorialFlags: flags,
  };
}

/**
 * Turns anything read from storage into a valid SaveData, or null when it is not a v3 save.
 * Never throws. Invalid records are dropped one by one; nothing is trusted blindly.
 */
export function validateSaveData(input: unknown): SaveData | null {
  if (!isRecord(input) || input.schemaVersion !== SCHEMA_VERSION) return null;
  if (!isId(input.saveId) || !isId(input.profileId)) return null;
  const objects: ObjectRecord[] = [];
  const ids = new Set<string>();
  if (Array.isArray(input.objects)) {
    for (const o of input.objects.map(objectRecord)) {
      if (!o || ids.has(o.id)) continue;
      ids.add(o.id);
      objects.push(o);
    }
  }
  const debris: DebrisRecord[] = [];
  if (Array.isArray(input.debris)) {
    for (const d of input.debris.map(debrisRecord)) {
      if (!d || ids.has(d.id)) continue;
      ids.add(d.id);
      debris.push(d);
    }
  }
  // A piece id is "<object>.d<n>[.<k>...]": the object's counter must be past every n in use.
  for (const o of objects) {
    for (const d of debris) {
      const m = d.id.startsWith(`${o.id}.d`) ? /^.d(d+)/.exec(d.id.slice(o.id.length)) : null;
      if (m) o.debrisSeq = Math.max(o.debrisSeq, Number(m[1]));
    }
  }
  const p = progress(input.progress);
  // Nothing may exist twice: an object already standing in the world is not delivered again.
  const returning = returningObjects([input.returning, isRecord(input.progress) ? input.progress.storage : undefined], ids);
  // Counters must stay ahead of every id already handed out, or a new purchase could reuse one.
  for (const id of [...ids, ...returning.map((s) => s.id)]) {
    const m = /^obj_(\d+)/.exec(id);
    if (m) p.counters.object = Math.max(p.counters.object, Number(m[1]));
  }
  const mode = input.mode === "arrange" || input.mode === "break" || input.mode === "cleanup" ? input.mode : "arrange";
  return {
    schemaVersion: SCHEMA_VERSION,
    saveId: input.saveId,
    profileId: input.profileId,
    slot: clamp(Math.floor(finiteOr(input.slot, 0)), 0, 2),
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 32) : "sTressT",
    createdAt: finiteOr(input.createdAt, Date.now()),
    updatedAt: finiteOr(input.updatedAt, Date.now()),
    playtimeSeconds: Math.max(0, finiteOr(input.playtimeSeconds, 0)),
    // A break session never survives a reload: the door opens and the player cleans up.
    mode: mode === "break" ? "cleanup" : mode,
    progress: p,
    objects,
    debris,
    ...(returning.length > 0 ? { returning } : {}),
  };
}

/** Objects waiting for delivery, from any of `lists` (the legacy `progress.storage` included). */
function returningObjects(lists: unknown[], taken: ReadonlySet<string>): ReturningObject[] {
  const out: ReturningObject[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (!isRecord(s) || !isId(s.id) || typeof s.definitionId !== "string" || !OBJECTS[s.definitionId]) continue;
      if (taken.has(s.id) || out.some((x) => x.id === s.id)) continue;
      out.push({ id: s.id, definitionId: s.definitionId, origin: ORIGINS.has(s.origin as string) ? (s.origin as ObjectOrigin) : "purchased" });
    }
  }
  return out;
}

/**
 * Imports a v1/v2 single-save document (the old localStorage format) as a v3 save: money, tools
 * and statistics carry over, the old room layout becomes intact objects, the old inventory is
 * delivered to the street drop zone.
 */
export function migrateLegacy(raw: unknown, profileId: string, slot: number, saveId: string, name: string): SaveData | null {
  if (!isRecord(raw)) return null;
  const save = newSave(profileId, slot, name, saveId);
  const p = cloneProgress(save.progress);
  p.credits = Math.min(count(raw.credits), 1_000_000_000);
  if (Array.isArray(raw.ownedTools)) {
    for (const t of raw.ownedTools) if (typeof t === "string" && TOOLS[t] && !p.ownedTools.includes(t)) p.ownedTools.push(t);
  }
  if (typeof raw.equippedToolId === "string" && p.ownedTools.includes(raw.equippedToolId)) p.equippedToolId = raw.equippedToolId;
  p.statistics = statistics(raw.statistics);
  if (Array.isArray(raw.roomLayout)) {
    const objects: ObjectRecord[] = [];
    for (const v of raw.roomLayout) {
      if (!isRecord(v) || typeof v.definitionId !== "string" || !OBJECTS[v.definitionId]) continue;
      const local = vec3(v.position, -5, 5);
      if (!local) continue;
      const starter = typeof v.instanceId === "string" && v.instanceId.startsWith("starter_");
      p.counters.object += 1;
      objects.push({
        id: starter && isId(v.instanceId) && !objects.some((o) => o.id === v.instanceId) ? (v.instanceId as string) : `obj_${String(p.counters.object).padStart(6, "0")}`,
        definitionId: v.definitionId,
        origin: starter ? "starter" : "purchased",
        position: roomToWorld(local),
        rotation: yawQuat(finiteOr(v.rotationY, 0)),
        stage: "intact",
        health: OBJECTS[v.definitionId]?.health ?? 1,
        deformUsed: 0,
        debrisSeq: 0,
        parts: null,
        decals: [],
      });
    }
    save.objects = objects;
  }
  if (isRecord(raw.objectInventory)) {
    const returning: ReturningObject[] = [];
    for (const [id, n] of Object.entries(raw.objectInventory)) {
      if (!OBJECTS[id]) continue;
      for (let i = 0; i < Math.min(count(n), 20); i++) {
        p.counters.object += 1;
        returning.push({ id: `obj_${String(p.counters.object).padStart(6, "0")}`, definitionId: id, origin: "purchased" });
      }
    }
    save.returning = returning;
  }
  save.progress = p;
  return validateSaveData(save);
}
