import type { Rng } from "../../core/rng";
import type { FracturePattern } from "../../data/types";
import { splitIslands } from "./islands";
import { planeFromPointNormal, type Plane, sliceSoup } from "./slice";
import { mergeSoups, type Soup, type SoupStats, soupStats, type Vec3 } from "./soup";

type Piece = { soup: Soup; stats: SoupStats; locked: boolean };

export type FractureRequest = {
  soup: Soup;
  /** Impact point in the soup's local space. */
  point: Vec3;
  /** Unit direction the force travelled in (local space). */
  dir: Vec3;
  pattern: FracturePattern;
  /** Desired number of pieces. */
  pieces: number;
  rng: Rng;
};

/** Pieces smaller than this radius are not split further (they are already debris). */
const MIN_SPLIT_RADIUS = 0.02;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const normalize = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function randomUnit(rng: Rng): Vec3 {
  const z = rng.range(-1, 1);
  const phi = rng.range(0, Math.PI * 2);
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(phi), r * Math.sin(phi), z];
}

/** Removes the component along `axis` and renormalises (falls back to a random vector if degenerate). */
function perpendicular(v: Vec3, axis: Vec3, rng: Rng): Vec3 {
  const k = dot(v, axis);
  const p: Vec3 = [v[0] - axis[0] * k, v[1] - axis[1] * k, v[2] - axis[2] * k];
  return len(p) < 1e-4 ? perpendicular(randomUnit(rng), axis, rng) : normalize(p);
}

function longestAxis(stats: SoupStats): Vec3 {
  const ex = stats.max[0] - stats.min[0];
  const ey = stats.max[1] - stats.min[1];
  const ez = stats.max[2] - stats.min[2];
  if (ex >= ey && ex >= ez) return [1, 0, 0];
  return ey >= ez ? [0, 1, 0] : [0, 0, 1];
}

function clampToBox(p: Vec3, stats: SoupStats, shrink: number): Vec3 {
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const lo = stats.min[i] as number;
    const hi = stats.max[i] as number;
    const pad = (hi - lo) * shrink;
    out[i] = Math.min(hi - pad, Math.max(lo + pad, p[i] as number));
  }
  return out;
}

/** Picks a cutting plane for one piece according to the material's fracture pattern. */
function choosePlane(piece: Piece, req: FractureRequest): Plane {
  const { rng, pattern, point, dir } = req;
  const c = piece.stats.centroid;
  const pull = pattern === "radial" || pattern === "shatter" ? 0.7 : pattern === "tear" ? 0.55 : pattern === "chunk" ? 0.35 : 0.2;
  const jitter = randomUnit(rng);
  const j = piece.stats.radius * 0.22;
  const anchor = clampToBox(
    [
      c[0] + (point[0] - c[0]) * pull + jitter[0] * j,
      c[1] + (point[1] - c[1]) * pull + jitter[1] * j,
      c[2] + (point[2] - c[2]) * pull + jitter[2] * j,
    ],
    piece.stats,
    0.12,
  );

  let normal: Vec3;
  switch (pattern) {
    case "radial":
    case "shatter": {
      // Cracks radiate from the impact: planes contain the impact direction.
      const concentric = rng.next() < (pattern === "shatter" ? 0.3 : 0.2);
      normal = concentric ? randomUnit(rng) : perpendicular(randomUnit(rng), dir, rng);
      break;
    }
    case "splinter": {
      // Wood splits along its grain (the part's long axis) into long slivers; sometimes it snaps across.
      const grain = longestAxis(piece.stats);
      normal = rng.next() < 0.78 ? perpendicular(randomUnit(rng), grain, rng) : normalize([grain[0] + rng.range(-0.3, 0.3), grain[1] + rng.range(-0.3, 0.3), grain[2] + rng.range(-0.3, 0.3)]);
      break;
    }
    case "tear":
      normal = rng.next() < 0.6 ? perpendicular(randomUnit(rng), dir, rng) : randomUnit(rng);
      break;
    case "chunk":
      normal = randomUnit(rng);
      break;
  }
  return planeFromPointNormal(anchor[0], anchor[1], anchor[2], normal[0], normal[1], normal[2]);
}

function toPieces(soups: Soup[]): Piece[] {
  return soups.filter((s) => s.count > 0).map((soup) => ({ soup, stats: soupStats(soup), locked: false }));
}

/**
 * Impact-driven fracture: repeatedly splits the piece that is large and close to the impact,
 * with planes chosen by the material pattern. Near the impact you get small shards, far away
 * large chunks, and the same object never breaks the same way twice (the RNG is seeded per hit).
 */
export function fractureSoup(req: FractureRequest): Soup[] {
  const pieces = toPieces(splitIslands(req.soup));
  const whole = soupStats(req.soup);
  const falloff = Math.max(0.08, whole.radius * 0.6);
  const maxAttempts = req.pieces * 4;
  const minArea = whole.area * MIN_PIECE_AREA_SHARE;
  // Only real pieces count: detail islands (knobs, screws) are glued back on at the end, so a
  // model with many of them must still be cut.
  const real = (): number => pieces.reduce((n, p) => n + (p.stats.area >= minArea ? 1 : 0), 0);

  for (let attempt = 0; attempt < maxAttempts && real() < req.pieces; attempt++) {
    let best = -1;
    let bestScore = -Infinity;
    pieces.forEach((p, i) => {
      if (p.locked || p.stats.radius < MIN_SPLIT_RADIUS) return;
      const dist = len(sub(p.stats.centroid, req.point));
      const score = p.stats.radius * (0.35 + Math.exp(-(dist * dist) / (falloff * falloff)));
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    if (best < 0) break;
    const target = pieces[best] as Piece;
    const { front, back } = sliceSoup(target.soup, choosePlane(target, req));
    if (front.count === 0 || back.count === 0) {
      // Plane missed the piece; a couple of misses in a row means it is too thin to cut.
      if (req.rng.next() < 0.25) target.locked = true;
      continue;
    }
    pieces.splice(best, 1, ...toPieces([...splitIslands(front), ...splitIslands(back)]));
  }
  return consolidate(pieces, minArea).map((p) => p.soup);
}

/** Pieces below this share of the object's surface are glued onto their nearest neighbour. */
const MIN_PIECE_AREA_SHARE = 0.025;

/**
 * Cutting a model with many small detail islands (knobs, screws, labels) would turn every detail
 * into its own flying piece. Tiny pieces are merged into the nearest real piece instead.
 */
function consolidate(pieces: Piece[], minArea: number): Piece[] {
  const big = pieces.filter((p) => p.stats.area >= minArea);
  if (big.length === 0) {
    if (pieces.length === 0) return [];
    const soup = mergeSoups(pieces.map((p) => p.soup));
    return [{ soup, stats: soupStats(soup), locked: false }];
  }
  const groups = big.map((p) => [p.soup]);
  for (const small of pieces) {
    if (small.stats.area >= minArea) continue;
    let best = 0;
    let bestDist = Infinity;
    big.forEach((b, i) => {
      const d = len(sub(b.stats.centroid, small.stats.centroid)) - b.stats.radius;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    (groups[best] as Soup[]).push(small.soup);
  }
  return groups.map((g) => {
    const soup = g.length === 1 ? (g[0] as Soup) : mergeSoups(g);
    return { soup, stats: soupStats(soup), locked: false };
  });
}

export type ChipResult = { remain: Soup; chips: Soup[] };

/**
 * Knocks a local chip out around the impact: the region inside a three-sided pyramid whose apex
 * sits `depth` below the surface. Returns null if nothing (or everything) would come off.
 */
export function chipSoup(soup: Soup, point: Vec3, surfaceNormal: Vec3, depth: number, rng: Rng): ChipResult | null {
  const n = normalize(surfaceNormal);
  const apex: Vec3 = [point[0] - n[0] * depth, point[1] - n[1] * depth, point[2] - n[2] * depth];
  const t1 = perpendicular(randomUnit(rng), n, rng);
  const t2: Vec3 = normalize([n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]]);
  const alpha = (rng.range(28, 42) * Math.PI) / 180;

  let chip = soup;
  const rest: Soup[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3 + rng.range(-0.25, 0.25);
    const t: Vec3 = [t1[0] * Math.cos(a) + t2[0] * Math.sin(a), t1[1] * Math.cos(a) + t2[1] * Math.sin(a), t1[2] * Math.cos(a) + t2[2] * Math.sin(a)];
    const pn: Vec3 = [n[0] * Math.cos(alpha) + t[0] * Math.sin(alpha), n[1] * Math.cos(alpha) + t[1] * Math.sin(alpha), n[2] * Math.cos(alpha) + t[2] * Math.sin(alpha)];
    const { front, back } = sliceSoup(chip, planeFromPointNormal(apex[0], apex[1], apex[2], pn[0], pn[1], pn[2]));
    if (back.count > 0) rest.push(back);
    chip = front;
    if (chip.count === 0) return null;
  }
  if (rest.length === 0) return null;

  // Only islands of the chip region that are actually near the impact come off.
  const reach = depth * 3.5;
  const chips: Soup[] = [];
  for (const island of splitIslands(chip)) {
    const c = soupStats(island).centroid;
    if (len(sub(c, point)) <= reach) chips.push(island);
    else rest.push(island);
  }
  if (chips.length === 0) return null;
  return { remain: mergeSoups(rest), chips };
}
