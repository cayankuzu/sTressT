import { GAME } from "../config/gameConfig";
import { MATERIALS, OBJECTS, ROOM, TOOL_IDS, TOOLS } from "../data/catalog";
import type { ObjectDefinition, ToolDefinition } from "../data/types";
import { computeDamage, kineticEnergy } from "../destruction/damage";
import { majorPieceCount } from "../destruction/debrisRules";
import { cleanupPool, stageReward } from "./economy";

/**
 * Economy simulator: plays the real loop (buy, carry, break, clean up, buy again) with the real
 * catalog, prices and damage formula, for players of different skill. Used by the tests to prove
 * every item is reachable in a demo-length session and that nobody can get stuck.
 */
export type PlayerModel = {
  name: string;
  /** Share of the cleanup pool actually carried to the container. */
  cleanupRate: number;
  /** Average combo multiplier on break rewards. */
  combo: number;
  /** One-hit / chain-reaction bonuses as a share of value. */
  bonus: number;
  /** Swings per successful hit (misses, glancing blows). */
  missFactor: number;
  /** Seconds lost per object to walking, shopping, placing, looking around. */
  overhead: number;
  /** Seconds per major piece carried out to the container. */
  cleanupTrip: number;
};

export const PLAYERS: PlayerModel[] = [
  { name: "bad", cleanupRate: 0.2, combo: 1.0, bonus: 0, missFactor: 2.2, overhead: 34, cleanupTrip: 16 },
  { name: "average", cleanupRate: 0.75, combo: 1.12, bonus: 0.04, missFactor: 1.6, overhead: 24, cleanupTrip: 10 },
  { name: "good", cleanupRate: 1, combo: 1.3, bonus: 0.1, missFactor: 1.25, overhead: 16, cleanupTrip: 7 },
];

export type SimResult = {
  player: string;
  /** Minute each tool was bought (Infinity = never within the time limit). */
  toolMinutes: Record<string, number>;
  creditsAfterCycles: number[];
  minutes: number;
  cycles: number;
  stuck: boolean;
};

const ANGLE = 0.72;

/** Swings needed to destroy `def` with `tool` (square-ish hits, average angle). */
export function hitsToDestroy(def: ObjectDefinition, tool: ToolDefinition): number {
  const material = MATERIALS[def.material];
  const damage = computeDamage(
    {
      point: [0, 0, 0],
      normal: [0, 0, 1],
      dir: [0, 0, -1],
      energy: kineticEnergy(tool.effectiveMass, tool.swingSpeed),
      impulse: 0,
      contactRadius: tool.contactRadius,
      affinity: 1,
      affinityMap: tool.affinity,
      source: "tool",
      generation: 0,
    },
    material,
    def.material,
  );
  return Math.max(1, Math.ceil(def.health / Math.max(0.5, damage * ANGLE)));
}


/** Time (s) and credits for destroying and cleaning one object. */
function playObject(def: ObjectDefinition, tool: ToolDefinition, p: PlayerModel, alreadyInRoom = false): { seconds: number; credits: number } {
  const swing = tool.windup + tool.active + tool.recovery;
  const breakTime = hitsToDestroy(def, tool) * p.missFactor * swing;
  const pieces = majorPieceCount(def);
  const cleaned = Math.round(pieces * p.cleanupRate);
  const breakCredits = (stageReward(def, "broken") + stageReward(def, "destroyed")) * p.combo + def.value * p.bonus;
  const cleanupCredits = (cleanupPool(def) * cleaned) / pieces;
  return { seconds: (alreadyInRoom ? p.overhead * 0.25 : p.overhead) + breakTime + cleaned * p.cleanupTrip, credits: breakCredits + cleanupCredits };
}

const STORE = Object.entries(OBJECTS)
  .filter(([, d]) => d.price > 0 && d.capabilities.destructible)
  .map(([id, d]) => ({ id, def: d }));

/** Runs one player for `limitMinutes` of play. */
export function simulate(p: PlayerModel, limitMinutes = 60): SimResult {
  let credits = GAME.economy.startingCredits;
  let seconds = 0;
  const owned = new Set<string>(["fists"]);
  const toolMinutes: Record<string, number> = {};
  for (const id of TOOL_IDS) toolMinutes[id] = id === "fists" ? 0 : Infinity;
  const creditsAfterCycles: number[] = [];
  let stuck = false;

  const bestTool = (def: ObjectDefinition): ToolDefinition => {
    let best = TOOLS.fists as ToolDefinition;
    let bestTime = Infinity;
    for (const id of owned) {
      const t = TOOLS[id] as ToolDefinition;
      const time = hitsToDestroy(def, t) * (t.windup + t.active + t.recovery);
      if (time < bestTime) {
        bestTime = time;
        best = t;
      }
    }
    return best;
  };

  /** Buys the next tool as soon as it is affordable (keeping a small reserve to keep playing). */
  const shopTools = (reserve: number): void => {
    for (let next = TOOL_IDS.find((id) => !owned.has(id)); next; next = TOOL_IDS.find((id) => !owned.has(id))) {
      const price = (TOOLS[next] as ToolDefinition).price;
      if (credits < price + reserve) return;
      credits -= price;
      owned.add(next);
      seconds += 20; // walk to the shop, buy, pick it up from the bench
      toolMinutes[next] = seconds / 60;
    }
  };

  const play = (defs: ObjectDefinition[], alreadyInRoom = false, reserve = 0): void => {
    for (const def of defs) {
      const r = playObject(def, bestTool(def), p, alreadyInRoom);
      seconds += r.seconds;
      credits += r.credits;
      shopTools(reserve);
    }
  };

  // Free content first: the starter room, then the street finds.
  play(ROOM.starterLayout.map((s) => OBJECTS[s.definitionId] as ObjectDefinition), true);
  creditsAfterCycles.push(Math.floor(credits));
  play(ROOM.foundItems.map((f) => OBJECTS[f.definitionId] as ObjectDefinition));
  creditsAfterCycles.push(Math.floor(credits));

  let cycles = 2;
  while (seconds < limitMinutes * 60) {
    shopTools(60);
    // Otherwise invest everything in a room-full of things to break (best value per second).
    const budget = credits;
    const basket: ObjectDefinition[] = [];
    let spend = 0;
    const ranked = STORE.map((s) => {
      const r = playObject(s.def, bestTool(s.def), p);
      return { def: s.def, rate: (r.credits - s.def.price) / r.seconds };
    }).sort((a, b) => b.rate - a.rate);
    for (const { def } of ranked) {
      while (spend + def.price <= budget && basket.length < 12) {
        basket.push(def);
        spend += def.price;
      }
    }
    if (basket.length === 0) {
      // Broke with nothing to break: the store's free safety box keeps the player moving.
      const box = OBJECTS.cardboard_box as ObjectDefinition;
      if (credits >= box.price) {
        stuck = true;
        break;
      }
      play([box]);
      seconds += 20;
    } else {
      credits -= spend;
      play(basket, false, 60);
    }
    cycles++;
    creditsAfterCycles.push(Math.floor(credits));
  }
  return { player: p.name, toolMinutes, creditsAfterCycles, minutes: seconds / 60, cycles, stuck };
}
