import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, validateSettings } from "./settings";

describe("settings", () => {
  it("fills every field from defaults when the stored value is missing or broken", () => {
    expect(validateSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(validateSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values and clamps or drops the rest", () => {
    const s = validateSettings({ invertY: true, sensitivity: 9, fov: 10, quality: "ultra", language: "en", masterVolume: Number.NaN });
    expect(s.invertY).toBe(true);
    expect(s.sensitivity).toBe(3);
    expect(s.fov).toBe(60);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.language).toBe("en");
    expect(s.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
  });

  it("only accepts a real boolean for invert-Y", () => {
    expect(validateSettings({ invertY: "yes" }).invertY).toBe(false);
  });
});
