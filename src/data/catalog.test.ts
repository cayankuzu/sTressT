import { describe, expect, it } from "vitest";
import { OBJECTS, ROOM, TOOL_IDS, TOOLS, validateCatalog } from "./catalog";

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
