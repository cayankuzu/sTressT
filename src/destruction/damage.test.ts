import { describe, expect, it } from "vitest";
import { MATERIALS, TOOLS } from "../data/catalog";
import { angleFactor, collisionEnergy, computeDamage, concentration, generationScale, type Impact, kineticEnergy, thresholdFactor } from "./damage";
import { advanceTo, applyDamage, createState, resetState } from "./stages";

const hit = (over: Partial<Impact> = {}): Impact => ({
  point: [0, 0, 0],
  normal: [0, 0, 1],
  dir: [0, 0, -1],
  energy: 50,
  impulse: 10,
  contactRadius: 0.04,
  affinity: 1,
  source: "tool",
  generation: 0,
  ...over,
});

describe("damage model", () => {
  it("rates direct hits above glancing ones and never goes negative", () => {
    expect(angleFactor([0, 0, -1], [0, 0, 1])).toBeCloseTo(1);
    expect(angleFactor([1, 0, 0], [0, 0, 1])).toBeCloseTo(0.35);
    expect(angleFactor([0, 0, 1], [0, 0, 1])).toBeCloseTo(0.35);
  });

  it("concentrates damage for small contact areas on brittle materials", () => {
    expect(concentration(0.015, 0.75)).toBeGreaterThan(concentration(0.06, 0.75));
    expect(concentration(0.015, 0)).toBeCloseTo(1);
    expect(concentration(0.0001, 1)).toBeLessThanOrEqual(2.2);
  });

  it("attenuates impacts below the material threshold", () => {
    expect(thresholdFactor(20, 40)).toBeCloseTo(0.25);
    expect(thresholdFactor(80, 40)).toBe(1);
  });

  it("makes a fist weak against metal but fine against cardboard", () => {
    const fists = TOOLS.fists!;
    const energy = kineticEnergy(fists.effectiveMass, fists.swingSpeed);
    const metal = computeDamage(hit({ energy, contactRadius: fists.contactRadius, affinityMap: fists.affinity }), MATERIALS.metal, "metal");
    const cardboard = computeDamage(hit({ energy, contactRadius: fists.contactRadius, affinityMap: fists.affinity }), MATERIALS.cardboard, "cardboard");
    expect(cardboard).toBeGreaterThan(metal * 3);
  });

  it("makes the sledgehammer outclass fists on a heavy wooden object", () => {
    const f = TOOLS.fists!;
    const s = TOOLS.sledgehammer!;
    const fist = computeDamage(hit({ energy: kineticEnergy(f.effectiveMass, f.swingSpeed), contactRadius: f.contactRadius, affinity: f.affinity.wood ?? 1 }), MATERIALS.wood);
    const sledge = computeDamage(hit({ energy: kineticEnergy(s.effectiveMass, s.swingSpeed), contactRadius: s.contactRadius, affinity: s.affinity.wood ?? 1 }), MATERIALS.wood);
    expect(sledge).toBeGreaterThan(fist * 5);
  });

  it("scales down and finally stops chain reactions", () => {
    expect(generationScale(0)).toBe(1);
    expect(generationScale(1)).toBeLessThan(1);
    expect(generationScale(3)).toBe(0);
    expect(computeDamage(hit({ generation: 5 }), MATERIALS.ceramic)).toBe(0);
  });

  it("never produces NaN or Infinity", () => {
    expect(computeDamage(hit({ energy: NaN }), MATERIALS.glass)).toBe(0);
    expect(computeDamage(hit({ energy: Infinity }), MATERIALS.glass)).toBe(0);
    expect(computeDamage(hit({ energy: 1e12 }), MATERIALS.glass)).toBeLessThanOrEqual(5000);
    expect(collisionEnergy(10, 0, 0)).toBe(0);
    expect(collisionEnergy(2, 1, Infinity)).toBeCloseTo(2);
    // Order must not matter: a static wall can be either collider of the pair.
    expect(collisionEnergy(2, Infinity, 1)).toBeCloseTo(2);
    expect(collisionEnergy(2, Infinity, Infinity)).toBe(0);
  });
});

describe("destruction stages", () => {
  it("walks intact -> damaged -> broken -> destroyed exactly once", () => {
    const s = createState(100);
    expect(applyDamage(s, 5)).toEqual([]);
    expect(applyDamage(s, 10)).toEqual(["damaged"]);
    expect(applyDamage(s, 1)).toEqual([]);
    expect(applyDamage(s, 40)).toEqual(["broken"]);
    expect(applyDamage(s, 500)).toEqual(["destroyed"]);
    expect(s.health).toBe(0);
    expect(applyDamage(s, 50)).toEqual([]);
  });

  it("reports every stage skipped by one huge hit", () => {
    const s = createState(100);
    expect(applyDamage(s, 1000)).toEqual(["damaged", "broken", "destroyed"]);
  });

  it("never moves backwards and ignores invalid damage", () => {
    const s = createState(100);
    advanceTo(s, "broken");
    expect(advanceTo(s, "damaged")).toEqual([]);
    expect(s.stage).toBe("broken");
    expect(applyDamage(s, -5)).toEqual([]);
    expect(applyDamage(s, NaN)).toEqual([]);
    expect(s.health).toBe(100);
  });

  it("resets to intact", () => {
    const s = createState(50);
    applyDamage(s, 999);
    resetState(s);
    expect(s).toEqual({ maxHealth: 50, health: 50, stage: "intact" });
  });
});
