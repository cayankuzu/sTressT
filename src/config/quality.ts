export type QualityTier = "low" | "medium" | "high";

/**
 * Quality tiers only scale cosmetic/invisible cost (resolution, shadow sharpness, dust particles).
 * Gameplay, physics, fragments and objects are identical on every tier.
 */
export type QualitySettings = {
  tier: QualityTier;
  /** Upper bound for the render buffer's device pixel ratio. */
  maxPixelRatio: number;
  /** Lower bound the dynamic-resolution governor may drop to under load. */
  minPixelRatio: number;
  antialias: boolean;
  shadowMapSize: number;
  anisotropy: number;
  /** Multiplier on purely cosmetic dust/particle counts. */
  particleScale: number;
};

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: { tier: "low", maxPixelRatio: 0.85, minPixelRatio: 0.5, antialias: false, shadowMapSize: 512, anisotropy: 1, particleScale: 0.5 },
  medium: { tier: "medium", maxPixelRatio: 1, minPixelRatio: 0.6, antialias: false, shadowMapSize: 1024, anisotropy: 2, particleScale: 0.8 },
  high: { tier: "high", maxPixelRatio: 1.5, minPixelRatio: 0.75, antialias: true, shadowMapSize: 2048, anisotropy: 4, particleScale: 1 },
};

const SOFTWARE_OR_WEAK_GPU = /swiftshader|llvmpipe|softpipe|basic render|mali-4|mali-t6|adreno \(tm\) [2-4]\d\d|powervr sgx/i;
const INTEGRATED_GPU = /intel|mali|adreno|powervr|apple gpu/i;

function readGpuName(): string {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return "";
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof name === "string" ? name : "";
  } catch {
    return "";
  }
}

export function isQualityTier(value: unknown): value is QualityTier {
  return value === "low" || value === "medium" || value === "high";
}

/** Cheap heuristic pick; the runtime FPS governor refines resolution afterwards. */
export function detectQuality(): QualitySettings {
  const forced = new URLSearchParams(location.search).get("q");
  if (isQualityTier(forced)) return QUALITY[forced];

  const cores = navigator.hardwareConcurrency || 2;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
  const gpu = readGpuName();
  const coarseOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;

  if (cores <= 2 || memory <= 2 || SOFTWARE_OR_WEAK_GPU.test(gpu)) return QUALITY.low;
  if (coarseOnly || cores <= 4 || INTEGRATED_GPU.test(gpu)) return QUALITY.medium;
  return QUALITY.high;
}
