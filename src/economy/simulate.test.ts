import { describe, expect, it } from "vitest";
import { TOOL_IDS } from "../data/catalog";
import { PLAYERS, simulate } from "./simulate";

const byName = Object.fromEntries(PLAYERS.map((p) => [p.name, simulate(p, 60)]));

describe("economy simulation", () => {
  it("prints the progression table", () => {
    const rows = Object.values(byName).map((r) => ({
      player: r.player,
      ...Object.fromEntries(TOOL_IDS.slice(1).map((id) => [id, Number.isFinite(r.toolMinutes[id]) ? Number((r.toolMinutes[id] as number).toFixed(1)) : "never"])),
      collection: Number.isFinite(r.collectionMinute) ? Number(r.collectionMinute.toFixed(1)) : `${r.collected}/36`,
      "cr@5": r.creditsAfterCycles[4],
      "cr@10": r.creditsAfterCycles[9],
    }));
    console.table(rows);
    expect(rows.length).toBe(3);
  });

  it("lets a good player afford a first upgrade within a few minutes", () => {
    const good = byName.good!;
    const first = Math.min(...TOOL_IDS.slice(1).map((id) => good.toolMinutes[id] ?? Infinity));
    expect(first).toBeLessThan(5);
  });

  it("makes every tool reachable for a player who plays the loop properly", () => {
    for (const name of ["good", "average"]) {
      const r = byName[name]!;
      for (const id of TOOL_IDS) expect(r.toolMinutes[id], `${name} never got ${id}`).toBeLessThan(name === "good" ? 30 : 45);
    }
  });

  it("lets a player who plays the loop properly break every kind of object once", () => {
    expect(byName.good!.collectionMinute).toBeLessThan(40);
    expect(byName.average!.collectionMinute).toBeLessThan(55);
  });

  it("never hard-locks anyone, even a careless player", () => {
    for (const r of Object.values(byName)) expect(r.stuck).toBe(false);
    const bad = byName.bad!;
    expect(bad.toolMinutes.baseball_bat).toBeLessThan(30);
  });
});
