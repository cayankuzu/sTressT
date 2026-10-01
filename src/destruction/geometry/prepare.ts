import type { FracturePattern } from "../../data/types";
import { Rng } from "../../core/rng";
import { fractureSoup } from "./fracture";
import { hullPoints, type Soup, soupStats, type Vec3 } from "./soup";

/** One render slot's triangles of a piece, already re-centred on the piece's own origin. */
export type PreparedSlot = { slot: number; pos: Float32Array; nrm: Float32Array; uv: Float32Array };

/**
 * A fragment ready to become a physics body: everything expensive (stats, re-centring, per-slot
 * geometry, hull points) is done, so spawning is just "create body + upload". This is what the
 * fracture worker sends back.
 */
export type PreparedPiece = {
  centroid: Vec3;
  radius: number;
  area: number;
  min: Vec3;
  max: Vec3;
  hull: Float32Array;
  /** Majority physical material index. */
  mat: number;
  slots: PreparedSlot[];
};

export function preparePiece(s: Soup): PreparedPiece {
  const stats = soupStats(s);
  const [cx, cy, cz] = stats.centroid;
  const counts = new Map<number, number>();
  const matCounts = new Map<number, number>();
  for (let t = 0; t < s.count; t++) {
    counts.set(s.slot[t] as number, (counts.get(s.slot[t] as number) ?? 0) + 1);
    matCounts.set(s.mat[t] as number, (matCounts.get(s.mat[t] as number) ?? 0) + 1);
  }
  const slots: PreparedSlot[] = [];
  for (const [slot, n] of counts) {
    const pos = new Float32Array(n * 9);
    const nrm = new Float32Array(n * 9);
    const uv = new Float32Array(n * 6);
    let o = 0;
    for (let t = 0; t < s.count; t++) {
      if (s.slot[t] !== slot) continue;
      for (let k = 0; k < 9; k += 3) {
        pos[o * 9 + k] = (s.pos[t * 9 + k] as number) - cx;
        pos[o * 9 + k + 1] = (s.pos[t * 9 + k + 1] as number) - cy;
        pos[o * 9 + k + 2] = (s.pos[t * 9 + k + 2] as number) - cz;
      }
      nrm.set(s.nrm.subarray(t * 9, t * 9 + 9), o * 9);
      uv.set(s.uv.subarray(t * 6, t * 6 + 6), o * 6);
      o++;
    }
    slots.push({ slot, pos, nrm, uv });
  }
  let mat = 0;
  let best = -1;
  for (const [m, n] of matCounts) {
    if (n > best) {
      best = n;
      mat = m;
    }
  }
  const hull = hullPoints(s, 48);
  for (let i = 0; i < hull.length; i += 3) {
    hull[i] = (hull[i] as number) - cx;
    hull[i + 1] = (hull[i + 1] as number) - cy;
    hull[i + 2] = (hull[i + 2] as number) - cz;
  }
  return {
    centroid: stats.centroid,
    radius: stats.radius,
    area: stats.area,
    min: [stats.min[0] - cx, stats.min[1] - cy, stats.min[2] - cz],
    max: [stats.max[0] - cx, stats.max[1] - cy, stats.max[2] - cz],
    hull,
    mat,
    slots,
  };
}

export type FractureJob = { soup: Soup; point: Vec3; dir: Vec3; pattern: FracturePattern; pieces: number; seed: number };

/** The whole job the worker runs (also used directly when workers are unavailable). */
export function runFractureJob(job: FractureJob): PreparedPiece[] {
  const soups = job.pieces > 1 ? fractureSoup({ soup: job.soup, point: job.point, dir: job.dir, pattern: job.pattern, pieces: job.pieces, rng: new Rng(job.seed) }) : [job.soup];
  return soups.filter((s) => s.count > 0).map(preparePiece);
}

/** Every typed array inside prepared pieces, for zero-copy transfer between threads. */
export function transferables(pieces: PreparedPiece[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const p of pieces) {
    out.push(p.hull.buffer as ArrayBuffer);
    for (const s of p.slots) out.push(s.pos.buffer as ArrayBuffer, s.nrm.buffer as ArrayBuffer, s.uv.buffer as ArrayBuffer);
  }
  return out;
}

/** Rebuilds a cuttable soup from a prepared piece (piece-local space), for breaking it again. */
export function pieceToSoup(piece: PreparedPiece): Soup {
  let count = 0;
  for (const s of piece.slots) count += s.pos.length / 9;
  const out: Soup = { pos: new Float32Array(count * 9), nrm: new Float32Array(count * 9), uv: new Float32Array(count * 6), slot: new Uint8Array(count), mat: new Uint8Array(count), count };
  let t = 0;
  for (const s of piece.slots) {
    const n = s.pos.length / 9;
    out.pos.set(s.pos, t * 9);
    out.nrm.set(s.nrm, t * 9);
    out.uv.set(s.uv, t * 6);
    out.slot.fill(s.slot, t, t + n);
    out.mat.fill(piece.mat, t, t + n);
    t += n;
  }
  return out;
}
