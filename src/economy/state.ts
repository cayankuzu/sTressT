import { GAME } from "../config/gameConfig";
import { STARTER_TOOL_ID } from "../data/catalog";
import type { ObjectOrigin } from "../data/types";

/** A bought tool waiting on the delivery bench in front of the Tool Shop. */
export type ToolDelivery = { id: string; toolId: string };

/**
 * An object waiting to be delivered to the street drop zone. Only old saves have them: the former
 * storage (and the v1/v2 object inventory) comes back this way when such a save is loaded.
 */
export type ReturningObject = { id: string; definitionId: string; origin: ObjectOrigin };

export type Counters = { object: number; delivery: number; session: number };

export type Statistics = {
  objectsDestroyed: number;
  objectsDamaged: number;
  creditsEarned: number;
  creditsSpent: number;
  breakSessions: number;
  roomsCleared: number;
  debrisDisposed: number;
  highestCombo: number;
  objectsThrown: number;
  objectsGrabbed: number;
  objectsPurchased: number;
};

/**
 * The economic half of a save: money, ownership and the reward ledger. The physical world
 * (where every object and piece of debris is) is snapshotted separately; both are written to
 * the save together, so money and the world can never disagree after a reload.
 */
export type ProgressState = {
  credits: number;
  /** Tools the player has picked up (owns and can equip). */
  ownedTools: string[];
  equippedToolId: string;
  toolDeliveries: ToolDelivery[];
  /** Street finds already taken (they never come back). */
  claimedFoundItems: string[];
  /** Kinds of object destroyed at least once (the collection; each pays a first-break bonus once). */
  collection: string[];
  /**
   * Idempotency keys of every reward still relevant: `brk:<object>:<stage>`, `cln:<debris>`,
   * `clr:<session>`. A reward whose key is here can never be paid again.
   */
  rewardLedger: string[];
  counters: Counters;
  statistics: Statistics;
  tutorialFlags: Record<string, boolean>;
};

export const EMPTY_STATS: Statistics = {
  objectsDestroyed: 0,
  objectsDamaged: 0,
  creditsEarned: 0,
  creditsSpent: 0,
  breakSessions: 0,
  roomsCleared: 0,
  debrisDisposed: 0,
  highestCombo: 0,
  objectsThrown: 0,
  objectsGrabbed: 0,
  objectsPurchased: 0,
};

export function defaultProgress(): ProgressState {
  return {
    credits: GAME.economy.startingCredits,
    ownedTools: [STARTER_TOOL_ID],
    equippedToolId: STARTER_TOOL_ID,
    toolDeliveries: [],
    claimedFoundItems: [],
    collection: [],
    rewardLedger: [],
    counters: { object: 0, delivery: 0, session: 0 },
    statistics: { ...EMPTY_STATS },
    tutorialFlags: {},
  };
}

export function cloneProgress(state: ProgressState): ProgressState {
  return {
    ...state,
    ownedTools: [...state.ownedTools],
    toolDeliveries: state.toolDeliveries.map((d) => ({ ...d })),
    claimedFoundItems: [...state.claimedFoundItems],
    collection: [...state.collection],
    rewardLedger: [...state.rewardLedger],
    counters: { ...state.counters },
    statistics: { ...state.statistics },
    tutorialFlags: { ...state.tutorialFlags },
  };
}
