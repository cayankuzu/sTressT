import { beforeEach, describe, expect, it } from "vitest";
import { OBJECTS } from "../data/catalog";
import { type Payout, Session } from "./Session";

const tv = OBJECTS.crt_tv!;
const cup = OBJECTS.tea_cup!;
const duck = OBJECTS.rubber_duck!;

describe("session", () => {
  let ledger: Map<string, number>;
  let payouts: Payout[];
  let clears: number[];
  let collected: Set<string>;
  let session: Session;
  const info = { oneHit: false, generation: 0 };
  const total = (): number => [...ledger.values()].reduce((a, b) => a + b, 0);

  beforeEach(() => {
    ledger = new Map();
    payouts = [];
    clears = [];
    collected = new Set();
    session = new Session({
      reward: (key, amount) => {
        if (ledger.has(key)) return false;
        ledger.set(key, amount);
        return true;
      },
      payout: (p) => payouts.push(p),
      firstBreak: (id) => {
        if (collected.has(id)) return 0;
        collected.add(id);
        return 10;
      },
      stress: () => undefined,
      combo: () => undefined,
      cleared: (bonus) => clears.push(bonus),
    });
    session.begin("ses_000001", [tv, tv, tv, cup, cup]);
  });

  it("pays each stage of an object exactly once", () => {
    session.onStage("tv_a", tv, "broken", info);
    session.onStage("tv_a", tv, "broken", info);
    session.onStage("tv_a", tv, "destroyed", info);
    session.onStage("tv_a", tv, "destroyed", info);
    expect(ledger.size).toBe(2);
    expect(payouts.length).toBe(2);
  });

  it("never pays twice for the same object across sessions (objects do not come back)", () => {
    session.onStage("tv_a", tv, "destroyed", info);
    const before = total();
    session.begin("ses_000002", [tv]);
    session.onStage("tv_a", tv, "destroyed", info);
    expect(total()).toBe(before);
  });

  it("pays every stage once and the three stages add up to the value (no combo)", () => {
    for (const stage of ["damaged", "broken", "destroyed"] as const) session.onStage("tv_a", tv, stage, info);
    expect(ledger.size).toBe(3);
    expect(payouts.map((p) => p.label)).toEqual(["damaged", "broken", "destroyed"]);
    expect(payouts.every((p) => p.key === "tv_a")).toBe(true);
    expect(total()).toBe(tv.value);
  });

  it("pays nothing for toys or outside a session", () => {
    session.onStage("duck", duck, "destroyed", info);
    session.end();
    session.onStage("cup_b", cup, "destroyed", info);
    expect(ledger.size).toBe(0);
  });

  it("pays the first-break bonus once per kind of object", () => {
    session.onStage("cup_a", cup, "destroyed", { ...info, definitionId: "tea_cup" });
    session.onStage("cup_b", cup, "destroyed", { ...info, definitionId: "tea_cup" });
    expect(payouts.filter((p) => p.label === "first").length).toBe(1);
    expect(payouts.find((p) => p.label === "first")?.key).toBe("cup_a:first");
  });

  it("builds a combo only across different objects and expires it", () => {
    session.onStage("cup_a", cup, "broken", info);
    session.onStage("cup_a", cup, "destroyed", info);
    expect(session.combo).toBe(1);
    session.onStage("cup_b", cup, "destroyed", info);
    expect(session.combo).toBe(2);
    session.update(10);
    expect(session.combo).toBe(0);
  });

  it("clears the room once when stress hits zero and pays a value-based bonus once", () => {
    for (const id of ["tv_a", "tv_b", "tv_c", "cup_a", "cup_b"]) {
      const def = id.startsWith("tv") ? tv : cup;
      session.onStage(id, def, "broken", info);
      session.onStage(id, def, "destroyed", info);
    }
    expect(clears.length).toBe(1);
    expect(clears[0]).toBeGreaterThan(0);
    expect(ledger.has("clr:ses_000001")).toBe(true);
  });

  it("rewards one-hit and chain-reaction destruction", () => {
    session.onStage("tv_a", tv, "destroyed", { oneHit: true, generation: 0 });
    session.onStage("tv_b", tv, "destroyed", { oneHit: false, generation: 1 });
    expect(payouts.map((p) => p.label)).toEqual(["one_hit", "chain"]);
  });
});
