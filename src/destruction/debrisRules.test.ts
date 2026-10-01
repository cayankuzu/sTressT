import { describe, expect, it } from "vitest";
import { GAME } from "../config/gameConfig";
import { canRefracture, canTransition, classifyPieces, isHeavyPiece } from "./debrisRules";

const D = GAME.debris;

describe("debris rules", () => {
  it("keeps the biggest pieces collectible, within the budget and the world cap", () => {
    const radii = [0.3, 0.02, 0.2, 0.1, 0.05, 0.25];
    expect(classifyPieces(radii, 3, 30).filter((k) => k === "major")).toHaveLength(3);
    expect(classifyPieces(radii, 3, 30)[0]).toBe("major");
    expect(classifyPieces(radii, 3, 1).filter((k) => k === "major")).toHaveLength(1);
    expect(classifyPieces(radii, 0, 30)).not.toContain("major");
    // Too small to be worth carrying, whatever the budget.
    expect(classifyPieces([D.majorMinRadius * 0.5], 5, 30)[0]).not.toBe("major");
  });

  it("never lets a disposed piece come back", () => {
    expect(canTransition("active", "held")).toBe(true);
    expect(canTransition("thrown", "disposed")).toBe(true);
    expect(canTransition("disposed", "held")).toBe(false);
    expect(canTransition("lost", "active")).toBe(false);
    expect(canTransition("held", "disposed")).toBe(false);
  });

  it("limits refracture depth, except for pieces too heavy to carry", () => {
    const heavy = GAME.interaction.maxGrabMass + 1;
    expect(isHeavyPiece(heavy)).toBe(true);
    expect(isHeavyPiece(GAME.interaction.maxGrabMass)).toBe(false);
    expect(canRefracture(0.2, 1, 2)).toBe(true);
    expect(canRefracture(0.2, D.maxFractureDepth, 2)).toBe(false);
    expect(canRefracture(D.minFractureRadius * 0.5, 1, 2)).toBe(false);
    // A heavy piece must always be breakable, or the room could never be cleaned.
    expect(canRefracture(0.2, D.maxFractureDepth + 5, heavy)).toBe(true);
  });
});
