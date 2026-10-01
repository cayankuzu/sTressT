import { DEFAULT_SETTINGS, type Settings, validateSettings } from "./settings";

/**
 * Local player profiles: who is playing on this browser. Small metadata only (localStorage); the
 * saves themselves live in IndexedDB under `installation/profile/slot` keys, so one profile never
 * sees another's saves. No accounts, no server: a different browser or computer starts fresh.
 */
export type Profile = { id: string; name: string; createdAt: number; lastSlot: number | null; settings: Settings };

export type ProfilesMeta = { version: 1; installationId: string; activeProfileId: string | null; profiles: Profile[] };

export const MAX_PROFILES = 5;
export const SLOT_COUNT = 3;
const KEY = "stresst.meta.v1";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function cleanName(name: string): string {
  // Nicknames are shown with textContent, but keep them short and printable anyway.
  return Array.from(name)
    .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
    .join("")
    .trim()
    .slice(0, 20);
}

function validate(input: unknown): ProfilesMeta | null {
  if (!isRecord(input) || typeof input.installationId !== "string" || !/^ins_[0-9a-f]{16}$/.test(input.installationId)) return null;
  const profiles: Profile[] = [];
  if (Array.isArray(input.profiles)) {
    for (const p of input.profiles) {
      if (!isRecord(p) || typeof p.id !== "string" || !/^pro_[0-9a-f]{16}$/.test(p.id) || profiles.some((x) => x.id === p.id)) continue;
      const name = typeof p.name === "string" ? cleanName(p.name) : "";
      profiles.push({
        id: p.id,
        name: name || "Oyuncu",
        createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
        lastSlot: typeof p.lastSlot === "number" && p.lastSlot >= 0 && p.lastSlot < SLOT_COUNT ? Math.floor(p.lastSlot) : null,
        settings: validateSettings(p.settings),
      });
      if (profiles.length >= MAX_PROFILES) break;
    }
  }
  const active = typeof input.activeProfileId === "string" && profiles.some((p) => p.id === input.activeProfileId) ? input.activeProfileId : (profiles[0]?.id ?? null);
  return { version: 1, installationId: input.installationId, activeProfileId: active, profiles };
}

/** Profile metadata with write-through persistence (never throws; storage may be blocked). */
export class ProfileStore {
  meta: ProfilesMeta;
  private available = true;

  constructor() {
    let loaded: ProfilesMeta | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      loaded = raw ? validate(JSON.parse(raw)) : null;
    } catch (err) {
      console.warn("sTressT: could not read profiles, starting fresh", err);
    }
    this.meta = loaded ?? { version: 1, installationId: randomId("ins"), activeProfileId: null, profiles: [] };
    if (!loaded) this.persist();
  }

  get active(): Profile | null {
    return this.meta.profiles.find((p) => p.id === this.meta.activeProfileId) ?? null;
  }

  /** Settings of the active profile (defaults before any profile exists). */
  get settings(): Settings {
    return this.active?.settings ?? { ...DEFAULT_SETTINGS };
  }

  slotKey(profileId: string, slot: number): string {
    return `${this.meta.installationId}/${profileId}/${slot}`;
  }

  create(name: string): Profile | null {
    if (this.meta.profiles.length >= MAX_PROFILES) return null;
    const settings = this.active?.settings ?? { ...DEFAULT_SETTINGS };
    const profile: Profile = { id: randomId("pro"), name: cleanName(name) || "Oyuncu", createdAt: Date.now(), lastSlot: null, settings: { ...settings } };
    this.meta.profiles.push(profile);
    this.meta.activeProfileId = profile.id;
    this.persist();
    return profile;
  }

  select(profileId: string): void {
    if (!this.meta.profiles.some((p) => p.id === profileId)) return;
    this.meta.activeProfileId = profileId;
    this.persist();
  }

  rename(profileId: string, name: string): void {
    const p = this.meta.profiles.find((x) => x.id === profileId);
    const clean = cleanName(name);
    if (!p || !clean) return;
    p.name = clean;
    this.persist();
  }

  /** Removes the profile entry (its slots must be deleted by the caller). */
  remove(profileId: string): void {
    this.meta.profiles = this.meta.profiles.filter((p) => p.id !== profileId);
    if (this.meta.activeProfileId === profileId) this.meta.activeProfileId = this.meta.profiles[0]?.id ?? null;
    this.persist();
  }

  setLastSlot(slot: number | null): void {
    const p = this.active;
    if (!p) return;
    p.lastSlot = slot;
    this.persist();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const p = this.active;
    const next = validateSettings({ ...(p?.settings ?? DEFAULT_SETTINGS), ...patch });
    if (p) {
      p.settings = next;
      this.persist();
    }
    return next;
  }

  private persist(): void {
    if (!this.available) return;
    try {
      localStorage.setItem(KEY, JSON.stringify(this.meta));
    } catch (err) {
      this.available = false;
      console.warn("sTressT: profiles cannot be saved in this browser", err);
    }
  }
}
