import { GAME } from "../config/gameConfig";
import { canBreak, COLLECTIBLE_IDS, MATERIALS, OBJECTS, ROOM, TOOL_IDS, TOOLS } from "../data/catalog";
import type { ObjectDefinition, ToolDefinition } from "../data/types";
import { computeDamage, kineticEnergy } from "../destruction/damage";
import { majorPieceCount } from "../destruction/debrisRules";
import { cleanupPool, firstBreakBonus } from "./economy";

/**
 * Economy simulator: plays the real loop (buy, carry, break, clean up, buy again) with the real
 * catalog, prices, levels and damage formula, for players of different skill. Used by the tests
 * to prove every tool, level and kind of object is reachable, that the next tool is never a long
 * wait away, and that nobody can get stuck. There is no time limit; the rhythm is what is guarded.
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
  /** Minute every kind of object had been destroyed once (Infinity = not within the limit). */
  collectionMinute: number;
  /** Kinds destroyed by the end. */
  collected: number;
  creditsAfterCycles: number[];
  minutes: number;
  cycles: number;
  stuck: boolean;
};

const ANGLE = 0.72;

/** Swings needed to destroy `def` with `tool` (square-ish hits, average angle). Infinity when the tool's level is too low. */
export function hitsToDestroy(def: ObjectDefinition, tool: ToolDefinition): number {
  if (!canBreak(tool.tier, def)) return Infinity;
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

const STORE = Object.entries(OBJECTS)
  .filter(([, d]) => d.price > 0 && d.capabilities.destructible)
  .map(([id, d]) => ({ id, def: d }));

/** Runs one player for `limitMinutes` of play. */
export function simulate(p: PlayerModel, limitMinutes = 60): SimResult {
  let credits = GAME.economy.startingCredits;
  let seconds = 0;
  const owned = new Set<string>(["fists"]);
  const collection = new Set<string>();
  let collectionMinute = Infinity;
  const toolMinutes: Record<string, number> = {};
  for (const id of TOOL_IDS) toolMinutes[id] = id === "fists" ? 0 : Infinity;
  const creditsAfterCycles: number[] = [];
  let stuck = false;
  const tier = (): number => Math.max(...[...owned].map((id) => (TOOLS[id] as ToolDefinition).tier));

  const bestTool = (def: ObjectDefinition): ToolDefinition | null => {
    let best: ToolDefinition | null = null;
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

  /** Time (s) and credits for destroying and cleaning one object (null = nothing owned can break it). */
  const playObject = (id: string, def: ObjectDefinition, alreadyInRoom = false): { seconds: number; credits: number } | null => {
    const tool = bestTool(def);
    if (!tool) return null;
    const swing = tool.windup + tool.active + tool.recovery;
    const breakTime = hitsToDestroy(def, tool) * p.missFactor * swing;
    const pieces = majorPieceCount(def);
    const cleaned = Math.round(pieces * p.cleanupRate);
    // The three stages pay the whole value; combos and bonuses on top.
    const breakCredits = def.value * p.combo + def.value * p.bonus;
    const cleanupCredits = (cleanupPool(def) * cleaned) / pieces;
    const first = collection.has(id) ? 0 : firstBreakBonus(def);
    return { seconds: (alreadyInRoom ? p.overhead * 0.25 : p.overhead) + breakTime + cleaned * p.cleanupTrip, credits: breakCredits + cleanupCredits + first };
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

  /** Plays what it can; returns the objects it could not break yet (they wait for a better tool). */
  const play = (items: { id: string; def: ObjectDefinition }[], alreadyInRoom = false, reserve = 0): { id: string; def: ObjectDefinition }[] => {
    const waiting: { id: string; def: ObjectDefinition }[] = [];
    for (const item of items) {
      const r = playObject(item.id, item.def, alreadyInRoom);
      if (!r) {
        waiting.push(item);
        continue;
      }
      seconds += r.seconds;
      credits += r.credits;
      if (!collection.has(item.id)) {
        collection.add(item.id);
        if (collection.size === COLLECTIBLE_IDS.length) {
          credits += GAME.economy.collectionBonus;
          collectionMinute = seconds / 60;
        }
      }
      shopTools(reserve);
    }
    return waiting;
  };
  const byId = (id: string): { id: string; def: ObjectDefinition } => ({ id, def: OBJECTS[id] as ObjectDefinition });

  // Free content first: the starter room, then the street finds. What fists cannot break waits.
  let waiting = play(ROOM.starterLayout.map((s) => byId(s.definitionId)), true);
  creditsAfterCycles.push(Math.floor(credits));
  waiting = [...waiting, ...play(ROOM.foundItems.map((f) => byId(f.definitionId)))];
  creditsAfterCycles.push(Math.floor(credits));

  let cycles = 2;
  while (seconds < limitMinutes * 60) {
    shopTools(60);
    // Whatever was waiting for a better tool goes first: it is already paid for.
    waiting = play(waiting, true, 60);
    // Then everything is invested in a room-full of things to break (best value per second,
    // first breaks included), from the levels the player has unlocked.
    const budget = credits;
    const basket: { id: string; def: ObjectDefinition }[] = [];
    let spend = 0;
    const ranked = STORE.filter((s) => s.def.tier <= tier())
      .map((s) => {
        const r = playObject(s.id, s.def) as { seconds: number; credits: number };
        return { ...s, rate: (r.credits - s.def.price) / r.seconds };
      })
      .sort((a, b) => b.rate - a.rate);
    // The collection is a goal: one of every kind not broken yet comes first (cheapest first),
    // then the room is filled with the best value per second.
    const fresh = ranked.filter((s) => !collection.has(s.id)).sort((a, b) => a.def.price - b.def.price);
    for (const item of fresh) {
      if (spend + item.def.price > budget || basket.length >= 12) continue;
      basket.push(item);
      spend += item.def.price;
    }
    for (const item of ranked) {
      while (spend + item.def.price <= budget && basket.length < 12) {
        basket.push(item);
        spend += item.def.price;
      }
    }
    if (basket.length === 0) {
      // Broke with nothing to break: the store's free safety box keeps the player moving.
      const box = OBJECTS.cardboard_box as ObjectDefinition;
      if (credits >= box.price) {
        stuck = true;
        break;
      }
      play([{ id: "cardboard_box", def: box }]);
      seconds += 20;
    } else {
      credits -= spend;
      play(basket, false, 60);
    }
    cycles++;
    creditsAfterCycles.push(Math.floor(credits));
  }
  return { player: p.name, toolMinutes, collectionMinute, collected: collection.size, creditsAfterCycles, minutes: seconds / 60, cycles, stuck };
}
