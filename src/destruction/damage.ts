import { GAME } from "../config/gameConfig";
import type { MaterialDefinition, MaterialType } from "../data/types";
import type { Vec3 } from "./geometry/soup";

export type ImpactSource = "tool" | "throw" | "collision";

/** Everything the destruction system needs to know about one hit, in world space. */
export type Impact = {
  point: Vec3;
  /** Outward surface normal at the hit point. */
  normal: Vec3;
  /** Unit direction the force travelled in. */
  dir: Vec3;
  /** Kinetic energy delivered (J) before material/angle factors. */
  energy: number;
  /** Momentum-ish scale for pushing the target (N·s). */
  impulse: number;
  /** Radius of the striking surface (m): small = concentrated. */
  contactRadius: number;
  /** Impactor hardness/affinity multiplier (1 = neutral). */
  affinity: number;
  /** Per-material tool affinity, resolved against the struck part. */
  affinityMap?: Partial<Record<MaterialType, number>>;
  source: ImpactSource;
  /** 0 = caused directly by the player; each chain-reaction hop adds one. */
  generation: number;
  /** Largest velocity change the push may cause (m/s); default 2.5 for tools. */
  maxDeltaV?: number;
  /** Unique per swing so one swing can damage an object only once. */
  attackId?: number;
  toolId?: string;
};

/** Reference contact radius (m) at which concentration is neutral. */
const REF_RADIUS = 0.04;
const MAX_DAMAGE = 5000;

export function kineticEnergy(mass: number, speed: number): number {
  return safe(0.5 * mass * speed * speed);
}

/** Energy dissipated by a collision impulse J between masses a and b (Infinity = static). */
export function collisionEnergy(impulse: number, massA: number, massB: number): number {
  const finiteA = Number.isFinite(massA);
  const finiteB = Number.isFinite(massB);
  const reduced = finiteA && finiteB ? (massA * massB) / (massA + massB) : finiteA ? massA : finiteB ? massB : NaN;
  if (!(reduced > 0)) return 0;
  return safe((impulse * impulse) / (2 * reduced));
}

/** Direct hit = 1, 45° ≈ 0.72, grazing → 0.35. Never negative. */
export function angleFactor(dir: Vec3, normal: Vec3): number {
  const cos = Math.max(0, Math.min(1, -(dir[0] * normal[0] + dir[1] * normal[1] + dir[2] * normal[2])));
  return 0.35 + 0.65 * Math.pow(cos, 1.5);
}

/** Small striking faces concentrate stress; brittle materials care most. */
export function concentration(contactRadius: number, brittleness: number): number {
  const r = Math.max(0.004, contactRadius);
  return Math.min(2.2, Math.max(0.6, Math.pow(REF_RADIUS / r, brittleness)));
}

/** Below the material's threshold, impacts fall off quadratically instead of adding up linearly. */
export function thresholdFactor(energy: number, minEnergy: number): number {
  if (minEnergy <= 0 || energy >= minEnergy) return 1;
  const x = energy / minEnergy;
  return x * x;
}

export function generationScale(generation: number): number {
  const scales = GAME.destruction.secondaryDamageScale;
  if (generation < 0) return scales[0];
  if (generation > GAME.destruction.maxCascadeGeneration) return 0;
  return scales[Math.min(generation, scales.length - 1)] ?? 0;
}

/** Final damage (J-equivalent) an impact deals to a material. Always finite and within [0, MAX]. */
export function computeDamage(impact: Impact, material: MaterialDefinition, type?: MaterialType): number {
  const toolAffinity = type && impact.affinityMap ? (impact.affinityMap[type] ?? 1) : 1;
  const damage =
    impact.energy *
    angleFactor(impact.dir, impact.normal) *
    concentration(impact.contactRadius, material.brittleness) *
    thresholdFactor(impact.energy, material.minEnergy) *
    impact.affinity *
    toolAffinity *
    generationScale(impact.generation);
  return Math.min(MAX_DAMAGE, safe(damage));
}

/** Impact strength bucket for sound and camera feedback. */
export function impactLevel(energy: number): "light" | "medium" | "heavy" {
  if (energy < 25) return "light";
  if (energy < 110) return "medium";
  return "heavy";
}

function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}
