import { GAME } from "../config/gameConfig";
import { OBJECTS, TOOLS } from "../data/catalog";
import type { ObjectDefinition, ObjectOrigin } from "../data/types";
import { cloneProgress, type ProgressState } from "./state";

/**
 * The only code allowed to change credits, ownership and the reward ledger. Every function is
 * pure: it validates, returns a new state (or a reason for refusal), and never mutates its input.
 * Reasons are stable codes; the UI translates them.
 */
export type Refusal =
  | "invalid_amount"
  | "already_rewarded"
  | "unknown_tool"
  | "already_owned"
  | "awaiting_pickup"
  | "insufficient_funds"
  | "unknown_object"
  | "not_for_sale"
  | "no_delivery"
  | "not_owned"
  | "already_claimed"
  | "not_stored"
  | "already_stored";

export type Result<T = object> = ({ ok: true; state: ProgressState } & T) | { ok: false; reason: Refusal; missing?: number };

const refuse = (reason: Refusal, missing?: number): { ok: false; reason: Refusal; missing?: number } => (missing === undefined ? { ok: false, reason } : { ok: false, reason, missing });

const pad = (n: number): string => String(n).padStart(6, "0");

/** Pays `amount` once for the idempotency `key`; a key already in the ledger pays nothing. */
export function grantReward(state: ProgressState, key: string, amount: number): Result {
  if (!Number.isFinite(amount) || amount < 0 || !key) return refuse("invalid_amount");
  if (state.rewardLedger.includes(key)) return refuse("already_rewarded");
  const whole = Math.floor(amount);
  const next = cloneProgress(state);
  next.rewardLedger.push(key);
  next.credits += whole;
  next.statistics.creditsEarned += whole;
  return { ok: true, state: next };
}

/** Pays a bought tool; it waits on the delivery bench until the player picks it up. */
export function purchaseTool(state: ProgressState, toolId: string): Result<{ deliveryId: string }> {
  const tool = TOOLS[toolId];
  if (!tool) return refuse("unknown_tool");
  if (state.ownedTools.includes(toolId)) return refuse("already_owned");
  if (state.toolDeliveries.some((d) => d.toolId === toolId)) return refuse("awaiting_pickup");
  if (!Number.isInteger(tool.price) || tool.price < 0) return refuse("unknown_tool");
  if (state.credits < tool.price) return refuse("insufficient_funds", tool.price - state.credits);
  const next = cloneProgress(state);
  next.credits -= tool.price;
  next.statistics.creditsSpent += tool.price;
  next.counters.delivery += 1;
  const deliveryId = `dlv_${pad(next.counters.delivery)}`;
  next.toolDeliveries.push({ id: deliveryId, toolId });
  return { ok: true, state: next, deliveryId };
}

/** Takes a delivered tool off the bench: it is owned and equipped from now on. */
export function pickUpTool(state: ProgressState, deliveryId: string): Result<{ toolId: string }> {
  const delivery = state.toolDeliveries.find((d) => d.id === deliveryId);
  if (!delivery) return refuse("no_delivery");
  const next = cloneProgress(state);
  next.toolDeliveries = next.toolDeliveries.filter((d) => d.id !== deliveryId);
  if (!next.ownedTools.includes(delivery.toolId)) next.ownedTools.push(delivery.toolId);
  next.equippedToolId = delivery.toolId;
  return { ok: true, state: next, toolId: delivery.toolId };
}

export function equipTool(state: ProgressState, toolId: string): Result {
  if (!TOOLS[toolId]) return refuse("unknown_tool");
  if (!state.ownedTools.includes(toolId)) return refuse("not_owned");
  if (state.equippedToolId === toolId) return { ok: true, state };
  const next = cloneProgress(state);
  next.equippedToolId = toolId;
  return { ok: true, state: next };
}

/** Pays a new object; the caller places the new instance (with this id) in front of the store. */
export function purchaseObject(state: ProgressState, definitionId: string): Result<{ objectId: string }> {
  const def = OBJECTS[definitionId];
  if (!def) return refuse("unknown_object");
  if (!Number.isInteger(def.price) || def.price <= 0) return refuse("not_for_sale");
  if (state.credits < def.price) return refuse("insufficient_funds", def.price - state.credits);
  const next = cloneProgress(state);
  next.credits -= def.price;
  next.statistics.creditsSpent += def.price;
  next.statistics.objectsPurchased += 1;
  next.counters.object += 1;
  return { ok: true, state: next, objectId: `obj_${pad(next.counters.object)}` };
}

/**
 * The store's safety net: a free object when the player has neither credits for the cheapest
 * item nor anything left to break. The caller checks the "nothing to break" half.
 */
export function grantSafetyObject(state: ProgressState): Result<{ objectId: string }> {
  if (state.credits >= cheapestObjectPrice()) return refuse("not_for_sale");
  const next = cloneProgress(state);
  next.counters.object += 1;
  return { ok: true, state: next, objectId: `obj_${pad(next.counters.object)}` };
}

/** A street find becomes the player's the first time it is picked up. Never twice. */
export function claimFoundItem(state: ProgressState, foundId: string): Result {
  if (state.claimedFoundItems.includes(foundId)) return refuse("already_claimed");
  const next = cloneProgress(state);
  next.claimedFoundItems.push(foundId);
  return { ok: true, state: next };
}

/** Arrange mode: an intact object leaves the world and waits in storage. */
export function storeObject(state: ProgressState, id: string, definitionId: string, origin: ObjectOrigin): Result {
  if (!OBJECTS[definitionId]) return refuse("unknown_object");
  if (state.storage.some((s) => s.id === id)) return refuse("already_stored");
  const next = cloneProgress(state);
  next.storage.push({ id, definitionId, origin });
  return { ok: true, state: next };
}

export function takeFromStorage(state: ProgressState, id: string): Result<{ definitionId: string; origin: ObjectOrigin }> {
  const item = state.storage.find((s) => s.id === id);
  if (!item) return refuse("not_stored");
  const next = cloneProgress(state);
  next.storage = next.storage.filter((s) => s.id !== id);
  return { ok: true, state: next, definitionId: item.definitionId, origin: item.origin };
}

/** A new break session: returns its id (unique for the whole save). */
export function beginSession(state: ProgressState): Result<{ sessionId: string }> {
  const next = cloneProgress(state);
  next.counters.session += 1;
  next.statistics.breakSessions += 1;
  return { ok: true, state: next, sessionId: `ses_${pad(next.counters.session)}` };
}

/**
 * Drops ledger keys for things that can never pay again (the object or piece no longer exists;
 * ids are never reused), so the ledger stays small over a long save.
 */
export function pruneLedger(state: ProgressState, liveIds: ReadonlySet<string>): ProgressState {
  const keep = state.rewardLedger.filter((key) => liveIds.has(key.split(":")[1] ?? ""));
  if (keep.length === state.rewardLedger.length) return state;
  return { ...state, rewardLedger: keep };
}

/** Every rule the economy must always satisfy; empty = healthy. */
export function checkInvariants(state: ProgressState): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(state.credits) || state.credits < 0) problems.push("credits must be a non-negative integer");
  if (new Set(state.ownedTools).size !== state.ownedTools.length) problems.push("duplicate tool ownership");
  if (!state.ownedTools.includes(state.equippedToolId)) problems.push("equipped tool not owned");
  for (const d of state.toolDeliveries) {
    if (!TOOLS[d.toolId]) problems.push(`unknown delivered tool ${d.toolId}`);
    if (state.ownedTools.includes(d.toolId)) problems.push(`delivered tool already owned ${d.toolId}`);
  }
  if (new Set(state.toolDeliveries.map((d) => d.toolId)).size !== state.toolDeliveries.length) problems.push("duplicate tool delivery");
  if (new Set(state.storage.map((s) => s.id)).size !== state.storage.length) problems.push("duplicate stored object");
  for (const s of state.storage) if (!OBJECTS[s.definitionId]) problems.push(`unknown stored object ${s.definitionId}`);
  if (new Set(state.rewardLedger).size !== state.rewardLedger.length) problems.push("duplicate reward key");
  return problems;
}

// ---------------------------------------------------------------- rewards

export type RewardStage = "broken" | "destroyed";

/** Deterministic payout for one destruction stage of one object (before combo). */
export function stageReward(def: ObjectDefinition, stage: RewardStage): number {
  const value = Math.max(0, def.value);
  const broken = Math.round(value * GAME.economy.brokenShare);
  return stage === "broken" ? broken : value - broken;
}

/** The whole cleanup pool of an object, shared by its major debris. Always below its break value. */
export function cleanupPool(def: ObjectDefinition): number {
  return Math.max(0, def.value) * GAME.economy.cleanupShare;
}

export function comboMultiplier(count: number): number {
  if (!(count > 1)) return 1;
  return Math.min(GAME.session.comboMaxMultiplier, 1 + GAME.session.comboStep * (count - 1));
}

/** Final credits for a stage with the combo applied (rounded, never negative, never NaN). */
export function rewardWithCombo(base: number, combo: number): number {
  const amount = Math.round(base * comboMultiplier(combo));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** Cheapest thing the Object Store sells (for the "never stuck" safety net). */
export function cheapestObjectPrice(): number {
  let min = Infinity;
  for (const def of Object.values(OBJECTS)) if (def.price > 0 && def.capabilities.destructible) min = Math.min(min, def.price);
  return min;
}
