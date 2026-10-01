import { GAME } from "../config/gameConfig";
import { MODELS } from "../data/catalog";
import type { ObjectDefinition } from "../data/types";

const D = GAME.debris;

/**
 * Debris rules shared by the game and the economy simulator.
 *
 *   major  the biggest pieces of a break: physical, collectible, disposable, saved, can break again
 *   minor  visual clutter with physics; clears itself when the break session ends
 *   micro  crumbs and shards; a few seconds of physics, then gone
 */
export type DebrisKind = "major" | "minor" | "micro";

/** Life cycle of a major piece. `disposed` and `lost` are final. */
export type DebrisState = "active" | "held" | "thrown" | "disposed" | "lost";

const TRANSITIONS: Record<DebrisState, readonly DebrisState[]> = {
  active: ["held", "thrown", "disposed", "lost"],
  held: ["active", "thrown", "lost"],
  thrown: ["active", "held", "disposed", "lost"],
  disposed: [],
  lost: [],
};

/** The only legal moves of the debris state machine (DISPOSED -> HELD can never happen). */
export function canTransition(from: DebrisState, to: DebrisState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Collectible pieces a destroyed object leaves: 1 + a few per metre of its largest dimension. */
export function majorPieceCount(def: ObjectDefinition): number {
  const size = Math.max(...(MODELS[def.model]?.size ?? [0.3, 0.3, 0.3])) * (def.scale ?? 1);
  return Math.min(D.majorPerObjectMax, Math.max(1, Math.round(1 + size * D.majorPerMetre)));
}

/**
 * Splits one break's pieces into kinds: the `budget` biggest pieces that are large enough become
 * major (limited further by `worldRoom`, the room left under the global cap), the rest minor or
 * micro by size. Returns kinds in the input order.
 */
export function classifyPieces(radii: readonly number[], budget: number, worldRoom: number): DebrisKind[] {
  const order = radii.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
  const kinds: DebrisKind[] = radii.map((r) => (r < GAME.destruction.microFragmentRadius ? "micro" : "minor"));
  let left = Math.max(0, Math.min(budget, worldRoom));
  for (const { r, i } of order) {
    if (left <= 0 || r < D.majorMinRadius) break;
    kinds[i] = "major";
    left--;
  }
  return kinds;
}

/** Health of a major piece: its share of the parent's toughness. */
export function pieceHealth(parentHealth: number, areaShare: number): number {
  return Math.max(8, parentHealth * Math.min(1, Math.max(0, areaShare)) * D.hpScale);
}

/** A piece too heavy to carry: it must stay breakable whatever its depth, or it could never be cleaned up. */
export function isHeavyPiece(mass: number): boolean {
  return mass > GAME.interaction.maxGrabMass;
}

/** Pieces that can still be broken into smaller ones by a hard enough hit. */
export function canRefracture(radius: number, depth: number, mass: number): boolean {
  return isHeavyPiece(mass) || (radius >= D.minFractureRadius && depth < D.maxFractureDepth);
}
