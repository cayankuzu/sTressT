import type { SaveData, SlotSummary } from "./schema";

/**
 * Persistent slot storage. IndexedDB holds the saves (structured data with typed arrays, survives
 * tab/browser close and reboots); a memory store stands in when the browser blocks storage, so the
 * game still plays (and says that progress will not be kept).
 *
 * Each slot keeps `primary` and `backup` (the previous good save) plus a checksum for each, written
 * in one transaction: a crash mid-write leaves the old pair intact.
 */
export type StoredSlot = { primary: unknown; primarySum: string; backup: unknown; backupSum: string };

export interface SlotStore {
  readonly persistent: boolean;
  read(key: string): Promise<StoredSlot | null>;
  write(key: string, data: SaveData, summary: SlotSummary): Promise<void>;
  remove(key: string): Promise<void>;
  summaries(keys: string[]): Promise<(SlotSummary | null)[]>;
}

// ---------------------------------------------------------------- checksum

/** FNV-1a over a canonical walk of the save; typed arrays hashed byte by byte. Integrity, not security. */
export function checksum(value: unknown): string {
  let h = 0x811c9dc5;
  const mix = (byte: number): void => {
    h ^= byte & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const text = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      mix(c);
      mix(c >> 8);
    }
  };
  const walk = (v: unknown): void => {
    if (v === null || v === undefined) return text("~");
    if (typeof v === "number") return text(Number.isFinite(v) ? v.toString() : v > 0 ? "inf" : v < 0 ? "-inf" : "nan");
    if (typeof v === "string") return text(`"${v}`);
    if (typeof v === "boolean") return text(v ? "T" : "F");
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      text(`#${bytes.length}`);
      for (let i = 0; i < bytes.length; i++) mix(bytes[i] as number);
      return;
    }
    if (Array.isArray(v)) {
      text("[");
      for (const x of v) walk(x);
      return text("]");
    }
    if (typeof v === "object") {
      text("{");
      for (const k of Object.keys(v as object).sort()) {
        text(k);
        walk((v as Record<string, unknown>)[k]);
      }
      return text("}");
    }
  };
  walk(value);
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = "stresst";
const DB_VERSION = 1;
const SAVES = "saves";
const SUMMARIES = "summaries";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

class IdbStore implements SlotStore {
  readonly persistent = true;
  constructor(private readonly db: IDBDatabase) {}

  async read(key: string): Promise<StoredSlot | null> {
    const tx = this.db.transaction(SAVES, "readonly");
    const value = (await request(tx.objectStore(SAVES).get(key))) as StoredSlot | undefined;
    return value ?? null;
  }

  async write(key: string, data: SaveData, summary: SlotSummary): Promise<void> {
    const tx = this.db.transaction([SAVES, SUMMARIES], "readwrite");
    const saves = tx.objectStore(SAVES);
    const current = (await request(saves.get(key))) as StoredSlot | undefined;
    // The previous primary becomes the backup only if it was itself intact.
    const keepOld = current && checksum(current.primary) === current.primarySum;
    const record: StoredSlot = {
      primary: data,
      primarySum: checksum(data),
      backup: keepOld ? current.primary : (current?.backup ?? null),
      backupSum: keepOld ? current.primarySum : (current?.backupSum ?? ""),
    };
    saves.put(record, key);
    tx.objectStore(SUMMARIES).put(summary, key);
    await done(tx);
  }

  async remove(key: string): Promise<void> {
    const tx = this.db.transaction([SAVES, SUMMARIES], "readwrite");
    tx.objectStore(SAVES).delete(key);
    tx.objectStore(SUMMARIES).delete(key);
    await done(tx);
  }

  async summaries(keys: string[]): Promise<(SlotSummary | null)[]> {
    const tx = this.db.transaction(SUMMARIES, "readonly");
    const store = tx.objectStore(SUMMARIES);
    return Promise.all(keys.map(async (k) => ((await request(store.get(k))) as SlotSummary | undefined) ?? null));
  }
}

class MemoryStore implements SlotStore {
  readonly persistent = false;
  private slots = new Map<string, StoredSlot>();
  private sums = new Map<string, SlotSummary>();

  async read(key: string): Promise<StoredSlot | null> {
    return this.slots.get(key) ?? null;
  }

  async write(key: string, data: SaveData, summary: SlotSummary): Promise<void> {
    const current = this.slots.get(key);
    this.slots.set(key, { primary: data, primarySum: checksum(data), backup: current?.primary ?? null, backupSum: current?.primarySum ?? "" });
    this.sums.set(key, summary);
  }

  async remove(key: string): Promise<void> {
    this.slots.delete(key);
    this.sums.delete(key);
  }

  async summaries(keys: string[]): Promise<(SlotSummary | null)[]> {
    return keys.map((k) => this.sums.get(k) ?? null);
  }
}

/** Opens IndexedDB (2 s timeout); falls back to memory with a console warning. */
export async function openSlotStore(): Promise<SlotStore> {
  try {
    if (typeof indexedDB === "undefined") throw new Error("IndexedDB unavailable");
    const db = await Promise.race([
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(SAVES)) db.createObjectStore(SAVES);
          if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("IndexedDB blocked"));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("IndexedDB timed out")), 2000)),
    ]);
    // Ask the browser not to evict our data under storage pressure (best effort).
    void navigator.storage?.persist?.().catch(() => undefined);
    return new IdbStore(db);
  } catch (err) {
    console.warn("sTressT: persistent storage unavailable, progress will not be kept after closing", err);
    return new MemoryStore();
  }
}

export function createMemoryStore(): SlotStore {
  return new MemoryStore();
}
