/**
 * Per-object destruction state machine for one destruction cycle. Pure data: the runtime entity
 * feeds damage in and reacts to the returned transitions.
 *
 *   intact -> damaged -> broken -> destroyed
 *
 * "broken" = structural failure (a part came off, a chunk was knocked out, or health < 45%).
 * Each transition happens at most once per cycle, which is what makes rewards exactly-once.
 */
export type Stage = "intact" | "damaged" | "broken" | "destroyed";

const ORDER: Record<Stage, number> = { intact: 0, damaged: 1, broken: 2, destroyed: 3 };
export const DAMAGED_THRESHOLD = 0.92;
export const BROKEN_THRESHOLD = 0.45;

export type DestructionState = {
  readonly maxHealth: number;
  health: number;
  stage: Stage;
};

export function createState(maxHealth: number): DestructionState {
  const max = Number.isFinite(maxHealth) && maxHealth > 0 ? maxHealth : 1;
  return { maxHealth: max, health: max, stage: "intact" };
}

/** Moves forward to `target` (never backwards); returns every stage passed through. */
export function advanceTo(state: DestructionState, target: Stage): Stage[] {
  const passed: Stage[] = [];
  const stages: Stage[] = ["damaged", "broken", "destroyed"];
  for (const stage of stages) {
    if (ORDER[stage] > ORDER[state.stage] && ORDER[stage] <= ORDER[target]) passed.push(stage);
  }
  if (ORDER[target] > ORDER[state.stage]) state.stage = target;
  return passed;
}

/** Applies health damage (clamped at 0) and returns the stages it crossed. */
export function applyDamage(state: DestructionState, damage: number): Stage[] {
  if (state.stage === "destroyed" || !(damage > 0) || !Number.isFinite(damage)) return [];
  state.health = Math.max(0, state.health - damage);
  const ratio = state.health / state.maxHealth;
  const target: Stage = state.health <= 0 ? "destroyed" : ratio < BROKEN_THRESHOLD ? "broken" : ratio < DAMAGED_THRESHOLD ? "damaged" : "intact";
  return advanceTo(state, target);
}

export function resetState(state: DestructionState): void {
  state.health = state.maxHealth;
  state.stage = "intact";
}
