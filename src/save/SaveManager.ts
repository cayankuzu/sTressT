import type { ProfileStore } from "./profiles";
import { SLOT_COUNT } from "./profiles";
import { checksum, type SlotStore } from "./storage";
import { type SaveData, type SlotSummary, summarize, validateSaveData } from "./schema";

export type LoadResult = { save: SaveData; recovered: boolean };

const AUTOSAVE_INTERVAL = 60;

/**
 * Owns the save life cycle of the running game: which slot is active, debounced autosaves after
 * gameplay events, a periodic safety save, and strictly sequential writes (a later snapshot never
 * gets overwritten by an earlier one finishing late).
 */
export class SaveManager {
  /** Builds a complete snapshot of the running game (null = nothing to save, e.g. on the menu). */
  provider: (() => SaveData | null) | null = null;
  onSaved: (ok: boolean, manual: boolean) => void = () => undefined;
  private due = -1;
  private sinceSave = 0;
  private chain: Promise<unknown> = Promise.resolve();
  lastSavedAt = 0;
  lastError: string | null = null;

  constructor(
    readonly store: SlotStore,
    readonly profiles: ProfileStore,
  ) {}

  get persistent(): boolean {
    return this.store.persistent;
  }

  async summaries(profileId: string): Promise<(SlotSummary | null)[]> {
    const keys = Array.from({ length: SLOT_COUNT }, (_, slot) => this.profiles.slotKey(profileId, slot));
    try {
      return await this.store.summaries(keys);
    } catch (err) {
      console.error("sTressT: could not list saves", err);
      return keys.map(() => null);
    }
  }

  /** Reads a slot: the primary if intact, else the last known good backup, else null. */
  async load(profileId: string, slot: number): Promise<LoadResult | null> {
    let stored;
    try {
      stored = await this.store.read(this.profiles.slotKey(profileId, slot));
    } catch (err) {
      console.error("sTressT: could not read save", err);
      return null;
    }
    if (!stored) return null;
    const pick = (data: unknown, sum: string): SaveData | null => (data && checksum(data) === sum ? validateSaveData(data) : null);
    const primary = pick(stored.primary, stored.primarySum);
    if (primary && primary.profileId === profileId) return { save: { ...primary, slot }, recovered: false };
    const backup = pick(stored.backup, stored.backupSum);
    if (backup && backup.profileId === profileId) {
      console.warn("sTressT: save was damaged, restored the last good copy");
      return { save: { ...backup, slot }, recovered: true };
    }
    // Checksum failed on both: still try to salvage what validates (never crash, never wipe).
    const salvage = validateSaveData(stored.primary) ?? validateSaveData(stored.backup);
    return salvage && salvage.profileId === profileId ? { save: { ...salvage, slot }, recovered: true } : null;
  }

  /** Writes one complete snapshot. Resolves true only after the data is really stored. */
  write(save: SaveData, manual = false): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        save.updatedAt = Date.now();
        await this.store.write(this.profiles.slotKey(save.profileId, save.slot), save, summarize(save));
        this.lastSavedAt = save.updatedAt;
        this.lastError = null;
        this.onSaved(true, manual);
        return true;
      } catch (err) {
        // Quota exceeded, storage revoked...: keep playing, say so, retry on the next autosave.
        this.lastError = String((err as Error)?.message ?? err);
        console.error("sTressT: save failed", err);
        this.onSaved(false, manual);
        return false;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next;
    return next;
  }

  async remove(profileId: string, slot: number): Promise<void> {
    await this.store.remove(this.profiles.slotKey(profileId, slot));
  }

  /** Schedules an autosave `delay` seconds from now (earlier requests win). */
  request(delay = 2): void {
    if (this.due < 0 || delay < this.due) this.due = delay;
  }

  /** Saves the current game right now (manual save, leaving to the menu, page hide). */
  async flush(manual = false): Promise<boolean> {
    this.due = -1;
    this.sinceSave = 0;
    const snapshot = this.provider?.();
    if (!snapshot) return false;
    return this.write(snapshot, manual);
  }

  /** Called every frame while a game is running. */
  tick(dt: number): void {
    if (!this.provider) return;
    this.sinceSave += dt;
    if (this.sinceSave >= AUTOSAVE_INTERVAL) this.request(0);
    if (this.due < 0) return;
    this.due -= dt;
    if (this.due <= 0) void this.flush();
  }

  /** Forgets pending autosaves (after loading another game). */
  reset(): void {
    this.due = -1;
    this.sinceSave = 0;
  }
}
