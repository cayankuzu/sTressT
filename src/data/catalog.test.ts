import { describe, expect, it } from "vitest";
import { canBreak, COLLECTIBLE_IDS, MAX_TIER, OBJECTS, objectsOfTier, ROOM, TOOL_IDS, TOOLS, toolForTier, validateCatalog } from "./catalog";

describe("game data catalog", () => {
  it("is internally consistent", () => {
    expect(validateCatalog()).toEqual([]);
  });

  it("orders tools by progression tier starting with the free starter", () => {
    expect(TOOL_IDS[0]).toBe("fists");
    const prices = TOOL_IDS.map((id) => TOOLS[id]?.price ?? -1);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it("starts with a small room that fists can get going on", () => {
    expect(ROOM.starterLayout.length).toBeGreaterThanOrEqual(4);
    expect(ROOM.starterLayout.length).toBeLessThanOrEqual(10);
    expect(ROOM.starterLayout.some((p) => (OBJECTS[p.definitionId]?.health ?? Infinity) <= 100)).toBe(true);
    // Fists (level 1) must have at least four things to break; the rest are goals for later.
    expect(ROOM.starterLayout.filter((p) => canBreak(1, OBJECTS[p.definitionId]!)).length).toBeGreaterThanOrEqual(4);
  });

  it("gives every level from 2 up its own tool and things to break, and the last tool breaks everything", () => {
    for (let tier = 1; tier <= MAX_TIER; tier++) {
      expect(TOOLS[toolForTier(tier)]?.tier).toBe(tier);
      expect(objectsOfTier(tier).length, `level ${tier}`).toBeGreaterThanOrEqual(3);
    }
    const last = TOOLS[TOOL_IDS[TOOL_IDS.length - 1]!]!;
    for (const id of COLLECTIBLE_IDS) expect(canBreak(last.tier, OBJECTS[id]!), id).toBe(true);
    for (const id of COLLECTIBLE_IDS) expect(canBreak(OBJECTS[id]!.tier - 1, OBJECTS[id]!), id).toBe(false);
  });

  it("raises prices with the level: a level's cheapest object costs more than the level two below's dearest", () => {
    const prices = (tier: number): number[] => objectsOfTier(tier).map((id) => OBJECTS[id]!.price);
    for (let tier = 3; tier <= MAX_TIER; tier++) expect(Math.min(...prices(tier))).toBeGreaterThan(Math.max(...prices(tier - 2)));
  });

  it("only offers street finds that exist, once each", () => {
    const ids = ROOM.foundItems.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of ROOM.foundItems) expect(OBJECTS[f.definitionId]?.capabilities.destructible).toBe(true);
  });

  it("lets every sold object be carried from the store to the room", () => {
    for (const [id, def] of Object.entries(OBJECTS)) {
      if (def.price > 0) expect(def.capabilities.grabbable, id).toBe(true);
    }
  });
});
