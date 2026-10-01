import { GAME } from "../config/gameConfig";
import assetIndexJson from "./generated/assetIndex.json";
import soundIndexJson from "./generated/soundIndex.json";
import materialsJson from "./materials.json";
import objectsJson from "./objects.json";
import roomJson from "./room.json";
import toolsJson from "./tools.json";
import {
  MATERIAL_TYPES,
  type MaterialDefinition,
  type MaterialType,
  type ObjectDefinition,
  type RoomDefinition,
  type ToolDefinition,
} from "./types";

export type ModelEntry = {
  file: string;
  role: string;
  triangles: number;
  size: [number, number, number];
  materials: string[];
  bytes: number;
};

export type TextureEntry = { base: string; bytes: number };

// JSON imports are typed structurally by TypeScript; `validateCatalog` checks the semantic rules.
export const MATERIALS = materialsJson as Record<MaterialType, MaterialDefinition>;
export const TOOLS = toolsJson as unknown as Record<string, ToolDefinition>;
export const OBJECTS = objectsJson as unknown as Record<string, ObjectDefinition>;
export const ROOM = roomJson as unknown as RoomDefinition;
export const MODELS = assetIndexJson.models as unknown as Record<string, ModelEntry>;
export const TEXTURES = assetIndexJson.textures as Record<string, TextureEntry>;
export const SOUNDS = soundIndexJson as Record<string, number>;

export const STARTER_TOOL_ID = "fists";

/** Tool ids in shop / quick-select order. */
export const TOOL_IDS: readonly string[] = Object.keys(TOOLS).sort((a, b) => (TOOLS[a]?.tier ?? 0) - (TOOLS[b]?.tier ?? 0));

/** Progression levels: each tool opens one, and the last one breaks everything. */
export const MAX_TIER = 7;

/** Whether a tool of level `toolTier` can damage `def` (indestructible props never break). */
export function canBreak(toolTier: number, def: ObjectDefinition): boolean {
  return def.capabilities.destructible && toolTier >= def.tier;
}

/** Highest level among these tools (fists = 1, unknown ids ignored). */
export function bestTier(toolIds: Iterable<string>): number {
  let best = 1;
  for (const id of toolIds) best = Math.max(best, TOOLS[id]?.tier ?? 1);
  return best;
}

/** The tool that opens `tier`. */
export function toolForTier(tier: number): string {
  return TOOL_IDS.find((id) => TOOLS[id]?.tier === tier) ?? TOOL_IDS[TOOL_IDS.length - 1] ?? STARTER_TOOL_ID;
}

/** Breakable objects that need exactly this level (what a tool of that level newly opens). */
export function objectsOfTier(tier: number): string[] {
  return Object.keys(OBJECTS).filter((id) => OBJECTS[id]?.capabilities.destructible && OBJECTS[id]?.tier === tier);
}

/** Every breakable object type: the collection to complete. */
export const COLLECTIBLE_IDS: readonly string[] = Object.keys(OBJECTS).filter((id) => OBJECTS[id]?.capabilities.destructible);

export function getTool(id: string): ToolDefinition {
  const tool = TOOLS[id];
  if (!tool) throw new Error(`Unknown tool "${id}"`);
  return tool;
}

export function getObject(id: string): ObjectDefinition {
  const def = OBJECTS[id];
  if (!def) throw new Error(`Unknown object "${id}"`);
  return def;
}

export function getModel(id: string): ModelEntry {
  const model = MODELS[id];
  if (!model) throw new Error(`Unknown model "${id}"`);
  return model;
}

const isPositive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const isNonNegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Returns human-readable problems with the game data; empty when everything is consistent. */
export function validateCatalog(): string[] {
  const errors: string[] = [];
  const materialSet = new Set<string>(MATERIAL_TYPES);

  for (const type of MATERIAL_TYPES) {
    const m = MATERIALS[type];
    if (!m) {
      errors.push(`material "${type}" is missing`);
      continue;
    }
    if (m.fragments[0] < 1 || m.fragments[1] < m.fragments[0]) errors.push(`material "${type}": bad fragment range`);
    for (const level of ["light", "medium", "heavy"] as const) {
      if (!SOUNDS[m.sounds[level]]) errors.push(`material "${type}": unknown sound "${m.sounds[level]}"`);
    }
  }

  for (const [id, tool] of Object.entries(TOOLS)) {
    if (!MODELS[tool.model]) errors.push(`tool "${id}": unknown model "${tool.model}"`);
    if (!isNonNegative(tool.price)) errors.push(`tool "${id}": invalid price`);
    for (const key of ["effectiveMass", "swingSpeed", "reach", "contactRadius", "windup", "active", "recovery"] as const) {
      if (!isPositive(tool[key])) errors.push(`tool "${id}": ${key} must be > 0`);
    }
    for (const mat of Object.keys(tool.affinity)) if (!materialSet.has(mat)) errors.push(`tool "${id}": unknown affinity material "${mat}"`);
    if (!SOUNDS[tool.sound]) errors.push(`tool "${id}": unknown sound "${tool.sound}"`);
  }
  if (!TOOLS[STARTER_TOOL_ID] || TOOLS[STARTER_TOOL_ID]?.price !== 0) errors.push("starter tool must exist and be free");
  const tiers = Object.values(TOOLS).map((tl) => tl.tier).sort((a, b) => a - b);
  if (tiers.join() !== Array.from({ length: MAX_TIER }, (_, i) => i + 1).join()) errors.push(`tools must have levels 1..${MAX_TIER}, one each`);
  if (TOOLS[STARTER_TOOL_ID]?.tier !== 1) errors.push("the starter tool must be level 1");

  for (const [id, def] of Object.entries(OBJECTS)) {
    if (!MODELS[def.model]) errors.push(`object "${id}": unknown model "${def.model}"`);
    if (!materialSet.has(def.material)) errors.push(`object "${id}": unknown material "${def.material}"`);
    for (const zone of def.zones ?? []) if (!materialSet.has(zone.material)) errors.push(`object "${id}": unknown zone material`);
    for (const key of ["mass", "health"] as const) if (!isPositive(def[key])) errors.push(`object "${id}": ${key} must be > 0`);
    for (const key of ["value", "price", "stress"] as const) if (!isNonNegative(def[key])) errors.push(`object "${id}": ${key} must be >= 0`);
    if (!Number.isInteger(def.tier) || def.tier < 1 || def.tier > MAX_TIER) errors.push(`object "${id}": tier must be 1..${MAX_TIER}`);
  }

  const seen = new Set<string>();
  for (const p of ROOM.starterLayout) {
    if (seen.has(p.instanceId)) errors.push(`starter layout: duplicate instance "${p.instanceId}"`);
    seen.add(p.instanceId);
    if (!OBJECTS[p.definitionId]) errors.push(`starter layout: unknown object "${p.definitionId}"`);
    if (!p.position.every((v) => Number.isFinite(v))) errors.push(`starter layout: bad position for "${p.instanceId}"`);
  }
  for (const f of ROOM.foundItems ?? []) {
    if (seen.has(f.id)) errors.push(`found item: duplicate id "${f.id}"`);
    seen.add(f.id);
    if (!OBJECTS[f.definitionId]) errors.push(`found item: unknown object "${f.definitionId}"`);
    if (!f.position.every((v) => Number.isFinite(v))) errors.push(`found item: bad position for "${f.id}"`);
  }
  for (const [id, def] of Object.entries(OBJECTS)) {
    if (def.price > 0 && def.capabilities.grabbable && def.mass > GAME.interaction.maxCarryMass) errors.push(`object "${id}": too heavy to carry from the store`);
  }
  return errors;
}
