import { describe, expect, it } from "vitest";
import { TOOL_IDS } from "../data/catalog";
import { PLAYERS, simulate } from "./simulate";

// There is no time limit: the simulation runs long enough for everyone to finish, and the tests
// guard the rhythm instead (the next goal is never far away), not a total length.
const byName = Object.fromEntries(PLAYERS.map((p) => [p.name, simulate(p, 120)]));

/** Longest wait (minutes) between one tool and the next. */
function longestGap(toolMinutes: Record<string, number>): number {
  const times = TOOL_IDS.map((id) => toolMinutes[id] ?? Infinity);
  let gap = 0;
  for (let i = 1; i < times.length; i++) gap = Math.max(gap, (times[i] as number) - (times[i - 1] as number));
  return gap;
}

describe("economy simulation", () => {
  it("prints the progression table", () => {
    const rows = Object.values(byName).map((r) => ({
      player: r.player,
      ...Object.fromEntries(TOOL_IDS.slice(1).map((id) => [id, Number.isFinite(r.toolMinutes[id]) ? Number((r.toolMinutes[id] as number).toFixed(1)) : "never"])),
      collection: Number.isFinite(r.collectionMinute) ? Number(r.collectionMinute.toFixed(1)) : `${r.collected}/36`,
      "longest gap": Number(longestGap(r.toolMinutes).toFixed(1)),
    }));
    console.table(rows);
    expect(rows.length).toBe(3);
  });

  it("lets a good player afford a first upgrade within a few minutes", () => {
    const good = byName.good!;
    const first = Math.min(...TOOL_IDS.slice(1).map((id) => good.toolMinutes[id] ?? Infinity));
    expect(first).toBeLessThan(5);
  });

  it("never lets progress stall: the next tool always comes within a reasonable wait", () => {
    expect(longestGap(byName.good!.toolMinutes)).toBeLessThan(10);
    expect(longestGap(byName.average!.toolMinutes)).toBeLessThan(13);
    expect(longestGap(byName.bad!.toolMinutes)).toBeLessThan(16);
  });

  it("lets every player get every tool and break every kind of object once", () => {
    for (const r of Object.values(byName)) {
      for (const id of TOOL_IDS) expect(r.toolMinutes[id], `${r.player} never got ${id}`).toBeLessThan(Infinity);
      expect(r.collectionMinute, `${r.player} collection`).toBeLessThan(Infinity);
    }
  });

  it("never hard-locks anyone, even a careless player", () => {
    for (const r of Object.values(byName)) expect(r.stuck).toBe(false);
  });
});
