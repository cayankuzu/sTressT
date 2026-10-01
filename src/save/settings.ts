import { isQualityTier, type QualityTier } from "../config/quality";

export type Language = "tr" | "en";

/** Per-profile preferences (stored with the profile, shared by its save slots). */
export type Settings = {
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  /** Mouse sensitivity multiplier (1 = default). */
  sensitivity: number;
  /** Mouse up looks down (flight-stick style). */
  invertY: boolean;
  quality: "auto" | QualityTier;
  /** Camera shake scale 0..1. */
  shake: number;
  /** Walk head-bob scale 0..1. */
  headBob: number;
  fov: number;
  language: Language;
};

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.8,
  sfxVolume: 1,
  musicVolume: 0.5,
  sensitivity: 1,
  invertY: false,
  quality: "auto",
  shake: 1,
  headBob: 1,
  fov: 75,
  language: "tr",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, lo: number, hi: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

export function validateSettings(input: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  if (!isRecord(input)) return { ...d };
  return {
    masterVolume: num(input.masterVolume, d.masterVolume, 0, 1),
    sfxVolume: num(input.sfxVolume, d.sfxVolume, 0, 1),
    musicVolume: num(input.musicVolume, d.musicVolume, 0, 1),
    sensitivity: num(input.sensitivity, d.sensitivity, 0.2, 3),
    invertY: typeof input.invertY === "boolean" ? input.invertY : d.invertY,
    quality: input.quality === "auto" || isQualityTier(input.quality) ? input.quality : d.quality,
    shake: num(input.shake, d.shake, 0, 1),
    headBob: num(input.headBob, d.headBob, 0, 1),
    fov: num(input.fov, d.fov, 60, 100),
    language: input.language === "en" || input.language === "tr" ? input.language : d.language,
  };
}
