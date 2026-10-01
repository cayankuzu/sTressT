import { type Soup, subsetSoup } from "./soup";

/** Quantization for "same vertex" tests: 0.1 mm. */
const Q = 10000;
const OFFSET = 65536;
const SPAN = 131072;

/** Packs a quantized position into one exact double (51 bits) for fast Map keys. */
export function positionKey(x: number, y: number, z: number): number {
  const qx = Math.round(x * Q) + OFFSET;
  const qy = Math.round(y * Q) + OFFSET;
  const qz = Math.round(z * Q) + OFFSET;
  return (qx * SPAN + qy) * SPAN + qz;
}

/**
 * Labels triangles by connected component (triangles sharing a vertex position are connected).
 * Separately modelled parts — chair legs, a TV's screen, a cabinet door — come out as islands.
 */
export function labelIslands(s: Soup): { labels: Int32Array; count: number } {
  const parent = new Int32Array(s.count);
  for (let i = 0; i < s.count; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[a] !== r) {
      const next = parent[a] as number;
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const owner = new Map<number, number>();
  for (let t = 0; t < s.count; t++) {
    for (let k = 0; k < 3; k++) {
      const p = t * 9 + k * 3;
      const key = positionKey(s.pos[p] as number, s.pos[p + 1] as number, s.pos[p + 2] as number);
      const other = owner.get(key);
      if (other === undefined) owner.set(key, t);
      else {
        const ra = find(t);
        const rb = find(other);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const labels = new Int32Array(s.count);
  const remap = new Map<number, number>();
  for (let t = 0; t < s.count; t++) {
    const root = find(t);
    let id = remap.get(root);
    if (id === undefined) {
      id = remap.size;
      remap.set(root, id);
    }
    labels[t] = id;
  }
  return { labels, count: remap.size };
}

/** Splits a soup into its connected components. */
export function splitIslands(s: Soup): Soup[] {
  if (s.count === 0) return [];
  const { labels, count } = labelIslands(s);
  if (count === 1) return [s];
  const buckets: number[][] = Array.from({ length: count }, () => []);
  for (let t = 0; t < s.count; t++) (buckets[labels[t] as number] as number[]).push(t);
  return buckets.map((tris) => subsetSoup(s, tris));
}
