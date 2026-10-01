import { BufferAttribute, BufferGeometry } from "three";

/**
 * Non-indexed triangle list with per-triangle tags. This is the representation the destruction
 * code cuts, splits and deforms. Triangle i uses pos/nrm[9i..9i+8], uv[6i..6i+5].
 */
export type Soup = {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  /** Render material slot (index into the model's glTF materials). */
  slot: Uint8Array;
  /** Physical material (index into MATERIAL_TYPES). */
  mat: Uint8Array;
  count: number;
};

export type Vec3 = [number, number, number];

export function emptySoup(): Soup {
  return { pos: new Float32Array(0), nrm: new Float32Array(0), uv: new Float32Array(0), slot: new Uint8Array(0), mat: new Uint8Array(0), count: 0 };
}

/** Growable builder; `build()` returns tightly sized arrays. */
export class SoupBuilder {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  slot: Uint8Array;
  mat: Uint8Array;
  count = 0;

  constructor(capacity = 64) {
    const cap = Math.max(4, capacity);
    this.pos = new Float32Array(cap * 9);
    this.nrm = new Float32Array(cap * 9);
    this.uv = new Float32Array(cap * 6);
    this.slot = new Uint8Array(cap);
    this.mat = new Uint8Array(cap);
  }

  private ensure(extra: number): void {
    const needed = this.count + extra;
    if (needed <= this.slot.length) return;
    const cap = Math.max(needed, this.slot.length * 2);
    const grow = <T extends Float32Array | Uint8Array>(src: T, per: number): T => {
      const dst = new (src.constructor as new (n: number) => T)(cap * per);
      dst.set(src.subarray(0, this.count * per));
      return dst;
    };
    this.pos = grow(this.pos, 9);
    this.nrm = grow(this.nrm, 9);
    this.uv = grow(this.uv, 6);
    this.slot = grow(this.slot, 1);
    this.mat = grow(this.mat, 1);
  }

  /** Copies triangle `t` of `src` unchanged. */
  copyTri(src: Soup, t: number): void {
    this.ensure(1);
    const i = this.count++;
    this.pos.set(src.pos.subarray(t * 9, t * 9 + 9), i * 9);
    this.nrm.set(src.nrm.subarray(t * 9, t * 9 + 9), i * 9);
    this.uv.set(src.uv.subarray(t * 6, t * 6 + 6), i * 6);
    this.slot[i] = src.slot[t] ?? 0;
    this.mat[i] = src.mat[t] ?? 0;
  }

  /** Appends a triangle from three vertex records laid out as [px,py,pz,nx,ny,nz,u,v]. */
  pushVerts(a: Float32Array, b: Float32Array, c: Float32Array, slot: number, mat: number): void {
    this.ensure(1);
    const i = this.count++;
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? a : k === 1 ? b : c;
      const p = i * 9 + k * 3;
      this.pos[p] = v[0] ?? 0;
      this.pos[p + 1] = v[1] ?? 0;
      this.pos[p + 2] = v[2] ?? 0;
      this.nrm[p] = v[3] ?? 0;
      this.nrm[p + 1] = v[4] ?? 0;
      this.nrm[p + 2] = v[5] ?? 0;
      this.uv[i * 6 + k * 2] = v[6] ?? 0;
      this.uv[i * 6 + k * 2 + 1] = v[7] ?? 0;
    }
    this.slot[i] = slot;
    this.mat[i] = mat;
  }

  build(): Soup {
    const n = this.count;
    return {
      pos: this.pos.slice(0, n * 9),
      nrm: this.nrm.slice(0, n * 9),
      uv: this.uv.slice(0, n * 6),
      slot: this.slot.slice(0, n),
      mat: this.mat.slice(0, n),
      count: n,
    };
  }
}

/**
 * Converts indexed/non-indexed render geometry into a soup. `matOf` decides the physical
 * material of each triangle from its centroid (material zones like a TV screen).
 */
export function soupFromGeometry(
  parts: { geometry: BufferGeometry; slot: number }[],
  matOf: (slot: number, cx: number, cy: number, cz: number) => number,
): Soup {
  let total = 0;
  for (const { geometry } of parts) total += (geometry.index ? geometry.index.count : geometry.getAttribute("position").count) / 3;
  const out: Soup = {
    pos: new Float32Array(total * 9),
    nrm: new Float32Array(total * 9),
    uv: new Float32Array(total * 6),
    slot: new Uint8Array(total),
    mat: new Uint8Array(total),
    count: total,
  };
  let t = 0;
  for (const { geometry, slot } of parts) {
    const pos = geometry.getAttribute("position");
    const nrm = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const index = geometry.index;
    const tris = (index ? index.count : pos.count) / 3;
    for (let i = 0; i < tris; i++, t++) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let k = 0; k < 3; k++) {
        const v = index ? index.getX(i * 3 + k) : i * 3 + k;
        const p = t * 9 + k * 3;
        out.pos[p] = pos.getX(v);
        out.pos[p + 1] = pos.getY(v);
        out.pos[p + 2] = pos.getZ(v);
        out.nrm[p] = nrm.getX(v);
        out.nrm[p + 1] = nrm.getY(v);
        out.nrm[p + 2] = nrm.getZ(v);
        out.uv[t * 6 + k * 2] = uv.getX(v);
        out.uv[t * 6 + k * 2 + 1] = uv.getY(v);
        cx += pos.getX(v);
        cy += pos.getY(v);
        cz += pos.getZ(v);
      }
      out.slot[t] = slot;
      out.mat[t] = matOf(slot, cx / 3, cy / 3, cz / 3);
    }
  }
  return out;
}

export function cloneSoup(s: Soup): Soup {
  return { pos: s.pos.slice(), nrm: s.nrm.slice(), uv: s.uv.slice(), slot: s.slot.slice(), mat: s.mat.slice(), count: s.count };
}

export function subsetSoup(s: Soup, tris: ArrayLike<number>): Soup {
  const b = new SoupBuilder(tris.length);
  for (let i = 0; i < tris.length; i++) b.copyTri(s, tris[i] as number);
  return b.build();
}

export function mergeSoups(list: Soup[]): Soup {
  const b = new SoupBuilder(list.reduce((n, s) => n + s.count, 0));
  for (const s of list) for (let t = 0; t < s.count; t++) b.copyTri(s, t);
  return b.build();
}

export type SoupStats = { min: Vec3; max: Vec3; centroid: Vec3; area: number; radius: number };

/** Bounds, area-weighted centroid, total area and bounding radius around the centroid. */
export function soupStats(s: Soup): SoupStats {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const p = s.pos;
  for (let t = 0; t < s.count; t++) {
    const o = t * 9;
    const ax = p[o] as number, ay = p[o + 1] as number, az = p[o + 2] as number;
    const bx = p[o + 3] as number, by = p[o + 4] as number, bz = p[o + 5] as number;
    const qx = p[o + 6] as number, qy = p[o + 7] as number, qz = p[o + 8] as number;
    // Inline min/max (this loop is hot: no temporary arrays).
    if (ax < min[0]) min[0] = ax;
    if (ax > max[0]) max[0] = ax;
    if (bx < min[0]) min[0] = bx;
    if (bx > max[0]) max[0] = bx;
    if (qx < min[0]) min[0] = qx;
    if (qx > max[0]) max[0] = qx;
    if (ay < min[1]) min[1] = ay;
    if (ay > max[1]) max[1] = ay;
    if (by < min[1]) min[1] = by;
    if (by > max[1]) max[1] = by;
    if (qy < min[1]) min[1] = qy;
    if (qy > max[1]) max[1] = qy;
    if (az < min[2]) min[2] = az;
    if (az > max[2]) max[2] = az;
    if (bz < min[2]) min[2] = bz;
    if (bz > max[2]) max[2] = bz;
    if (qz < min[2]) min[2] = qz;
    if (qz > max[2]) max[2] = qz;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = qx - ax, vy = qy - ay, vz = qz - az;
    const a = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    area += a;
    cx += a * (ax + bx + qx);
    cy += a * (ay + by + qy);
    cz += a * (az + bz + qz);
  }
  const centroid: Vec3 =
    area > 0
      ? [cx / (3 * area), cy / (3 * area), cz / (3 * area)]
      : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let r2 = 0;
  for (let i = 0; i < s.count * 3; i++) {
    const dx = (p[i * 3] as number) - centroid[0];
    const dy = (p[i * 3 + 1] as number) - centroid[1];
    const dz = (p[i * 3 + 2] as number) - centroid[2];
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }
  return { min, max, centroid, area, radius: Math.sqrt(r2) };
}

/** Returns a copy of the soup translated by -offset (recentres a fragment on its own origin). */
export function translateSoup(s: Soup, offset: Vec3): Soup {
  const out = cloneSoup(s);
  for (let i = 0; i < out.count * 3; i++) {
    out.pos[i * 3] = (out.pos[i * 3] as number) - offset[0];
    out.pos[i * 3 + 1] = (out.pos[i * 3 + 1] as number) - offset[1];
    out.pos[i * 3 + 2] = (out.pos[i * 3 + 2] as number) - offset[2];
  }
  return out;
}

/**
 * Points for a convex hull collider: distinct vertex positions (quantized), capped at
 * `maxPoints`, chosen so that what an object stands on and carries stays true. Rapier (0.21)
 * computes face contacts reliably only for faces with at most four corners: on a five-or-more
 * corner face the contact is clipped to part of it, and a cup on a round or chamfered table top
 * tips over. So:
 *   - the footprint is exactly four points, the extremes along the diagonals of the bottom layer
 *     (a ring's inscribed square, a rectangle's corners, one foot per chair leg), flattened to
 *     one plane; a base a few millimetres out of level (a sagging box) counts as flat;
 *   - the top face is the largest four-corner shape inside the top outline, flattened; the rest of
 *     the outline stays, a few millimetres lower, as a bevel, so the top keeps its full size;
 *   - the silhouette comes from the extreme vertex along many directions;
 *   - an even sample of the rest fills the budget.
 * No other point may lie in the bottom or top plane (it would split the face).
 */
const DIAGONALS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

export function hullPoints(s: Soup, maxPoints = 96): Float32Array {
  const seen = new Set<number>();
  const pts: number[] = [];
  for (let i = 0; i < s.count * 3; i++) {
    const x = s.pos[i * 3] as number;
    const y = s.pos[i * 3 + 1] as number;
    const z = s.pos[i * 3 + 2] as number;
    // 2 mm grid packed into one exact double (±8 m range).
    const key = ((Math.round(x * 500) + 4096) * 8192 + (Math.round(y * 500) + 4096)) * 8192 + (Math.round(z * 500) + 4096);
    if (seen.has(key)) continue;
    seen.add(key);
    pts.push(x, y, z);
  }
  const n = pts.length / 3;
  if (n === 0) return new Float32Array(0);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minY = Math.min(minY, pts[i * 3 + 1] as number);
    maxY = Math.max(maxY, pts[i * 3 + 1] as number);
  }
  const height = maxY - minY;
  const LAYER_EPS = 0.003;
  // A paper-thin piece (a shard of screen) has no base or top to shape: flattening would leave
  // its points in one plane, which is no hull at all. It keeps its real thickness instead.
  const thin = height <= LAYER_EPS * 2;
  // Feet may be this far out of level and still form one flat base (3% of the height, ≤ 1 cm).
  const footEps = Math.max(LAYER_EPS, Math.min(0.01, height * 0.03));
  const y = (i: number): number => pts[i * 3 + 1] as number;
  const isBase = (i: number): boolean => !thin && y(i) <= minY + LAYER_EPS;
  const hasTop = !thin && height > footEps + LAYER_EPS;
  const isTop = (i: number): boolean => hasTop && y(i) >= maxY - LAYER_EPS;
  /** Output height per kept point, where it differs from the input. */
  const yOut = new Map<number, number>();

  // Footprint: four diagonal extremes of the bottom layer, flattened.
  const foot = new Set<number>();
  for (const [dx, dz] of thin ? [] : DIAGONALS) {
    let best = -1;
    let bestDot = -Infinity;
    for (let i = 0; i < n; i++) {
      if (y(i) > minY + footEps) continue;
      const dot = (pts[i * 3] as number) * dx + (pts[i * 3 + 2] as number) * dz;
      if (dot > bestDot) {
        bestDot = dot;
        best = i;
      }
    }
    if (best >= 0) foot.add(best);
  }
  for (const i of foot) yOut.set(i, minY);

  // Top: the largest quad inside the outline, flattened; the other outline corners a little lower.
  const outline = hasTop ? outline2d(pts, n, isTop, 16) : [];
  const quad = new Set(largestQuad(pts, outline));
  const TOP_BEVEL = 0.005;
  for (const i of outline) yOut.set(i, quad.has(i) ? maxY : maxY - TOP_BEVEL);

  const keep = new Set<number>(foot);
  const take = (i: number): void => {
    if (keep.size >= maxPoints || foot.has(i) || isBase(i)) return;
    if (isTop(i) && !yOut.has(i)) return;
    keep.add(i);
  };
  for (const i of quad) take(i);
  for (const i of outline) take(i);

  // Everything else, if it fits.
  if (n <= maxPoints) {
    for (let i = 0; i < n; i++) take(i);
  } else {
    // Silhouette: the extreme vertex along many directions (a Fibonacci sphere).
    const dirs = 40;
    for (let d = 0; d < dirs; d++) {
      const dy = 1 - (2 * (d + 0.5)) / dirs;
      const r = Math.sqrt(1 - dy * dy);
      const phi = d * 2.399963229728653;
      const dx = Math.cos(phi) * r;
      const dz = Math.sin(phi) * r;
      let best = -1;
      let bestDot = -Infinity;
      for (let i = 0; i < n; i++) {
        if (isBase(i) || (isTop(i) && !yOut.has(i))) continue;
        const dot = (pts[i * 3] as number) * dx + y(i) * dy + (pts[i * 3 + 2] as number) * dz;
        if (dot > bestDot) {
          bestDot = dot;
          best = i;
        }
      }
      if (best >= 0) take(best);
    }
    // An even sample of the rest fills the budget.
    const stride = n / Math.max(1, maxPoints - keep.size);
    for (let f = 0; f < n && keep.size < maxPoints; f += stride) take(Math.floor(f));
  }
  const out = new Float32Array(keep.size * 3);
  let o = 0;
  for (const i of keep) {
    out[o++] = pts[i * 3] as number;
    out[o++] = yOut.get(i) ?? y(i);
    out[o++] = pts[i * 3 + 2] as number;
  }
  return out;
}

/**
 * The four of the given outline corners (point indices, in outline order) that enclose the
 * largest area; all of them when there are four or fewer.
 */
function largestQuad(pts: readonly number[], outline: readonly number[]): number[] {
  const m = outline.length;
  if (m <= 4) return outline.slice();
  const x = (k: number): number => pts[(outline[k] as number) * 3] as number;
  const z = (k: number): number => pts[(outline[k] as number) * 3 + 2] as number;
  const tri = (a: number, b: number, c: number): number => Math.abs((x(b) - x(a)) * (z(c) - z(a)) - (z(b) - z(a)) * (x(c) - x(a)));
  let best = [0, 1, 2, 3];
  let bestArea = -1;
  // Outline order is convex, so a, b, c, d in order form a convex quad: area = abc + acd.
  for (let a = 0; a < m; a++)
    for (let b = a + 1; b < m; b++)
      for (let c = b + 1; c < m; c++)
        for (let d = c + 1; d < m; d++) {
          const area = tri(a, b, c) + tri(a, c, d);
          if (area > bestArea) {
            bestArea = area;
            best = [a, b, c, d];
          }
        }
  return best.map((k) => outline[k] as number);
}

/**
 * Corners of the horizontal (xz) convex outline of the selected points, without collinear or
 * interior points, reduced evenly to at most `max` corners. Returns point indices.
 */
function outline2d(pts: readonly number[], n: number, select: (i: number) => boolean, max: number): number[] {
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (select(i)) idx.push(i);
  if (idx.length <= 2) return idx;
  const x = (i: number): number => pts[i * 3] as number;
  const z = (i: number): number => pts[i * 3 + 2] as number;
  idx.sort((a, b) => x(a) - x(b) || z(a) - z(b));
  // 1 mm² tolerance: points that barely bend the outline count as collinear.
  const cross = (o: number, a: number, b: number): number => (x(a) - x(o)) * (z(b) - z(o)) - (z(a) - z(o)) * (x(b) - x(o));
  const EPS = 1e-6;
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2] as number, lower[lower.length - 1] as number, i) <= EPS) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k] as number;
    while (upper.length >= 2 && cross(upper[upper.length - 2] as number, upper[upper.length - 1] as number, i) <= EPS) upper.pop();
    upper.push(i);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length <= max) return hull;
  const out: number[] = [];
  for (let k = 0; k < max; k++) out.push(hull[Math.floor((k * hull.length) / max)] as number);
  return out;
}

/** Builds one non-indexed BufferGeometry per render slot (null for slots without triangles). */
export function soupToGeometries(s: Soup, slotCount: number): (BufferGeometry | null)[] {
  const counts = Array.from({ length: slotCount }, () => 0);
  for (let t = 0; t < s.count; t++) counts[s.slot[t] as number] = (counts[s.slot[t] as number] ?? 0) + 1;
  const onlySlot = counts.findIndex((n) => n === s.count);
  if (onlySlot >= 0 && s.count > 0) {
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(s.pos, 3));
    g.setAttribute("normal", new BufferAttribute(s.nrm, 3));
    g.setAttribute("uv", new BufferAttribute(s.uv, 2));
    g.computeBoundingSphere();
    return counts.map((_, slot) => (slot === onlySlot ? g : null));
  }
  return counts.map((n, slot) => {
    if (n === 0) return null;
    const pos = new Float32Array(n * 9);
    const nrm = new Float32Array(n * 9);
    const uv = new Float32Array(n * 6);
    let o = 0;
    for (let t = 0; t < s.count; t++) {
      if (s.slot[t] !== slot) continue;
      pos.set(s.pos.subarray(t * 9, t * 9 + 9), o * 9);
      nrm.set(s.nrm.subarray(t * 9, t * 9 + 9), o * 9);
      uv.set(s.uv.subarray(t * 6, t * 6 + 6), o * 6);
      o++;
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("normal", new BufferAttribute(nrm, 3));
    g.setAttribute("uv", new BufferAttribute(uv, 2));
    g.computeBoundingSphere();
    return g;
  });
}
