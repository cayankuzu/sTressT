import { type Soup, SoupBuilder } from "./soup";

/** Plane n·x = d with unit normal n. "Front" is the side the normal points to. */
export type Plane = { nx: number; ny: number; nz: number; d: number };

export function planeFromPointNormal(px: number, py: number, pz: number, nx: number, ny: number, nz: number): Plane {
  const len = Math.hypot(nx, ny, nz) || 1;
  const x = nx / len;
  const y = ny / len;
  const z = nz / len;
  return { nx: x, ny: y, nz: z, d: x * px + y * py + z * pz };
}

// Scratch vertex records [px,py,pz,nx,ny,nz,u,v].
const V = [new Float32Array(8), new Float32Array(8), new Float32Array(8)];
const I1 = new Float32Array(8);
const I2 = new Float32Array(8);

function loadVertex(s: Soup, t: number, k: number, out: Float32Array): void {
  const p = t * 9 + k * 3;
  out[0] = s.pos[p] as number;
  out[1] = s.pos[p + 1] as number;
  out[2] = s.pos[p + 2] as number;
  out[3] = s.nrm[p] as number;
  out[4] = s.nrm[p + 1] as number;
  out[5] = s.nrm[p + 2] as number;
  out[6] = s.uv[t * 6 + k * 2] as number;
  out[7] = s.uv[t * 6 + k * 2 + 1] as number;
}

/** Lexicographic position order so both triangles sharing an edge compute the same cut point. */
function lessThan(a: Float32Array, b: Float32Array): boolean {
  if (a[0] !== b[0]) return (a[0] as number) < (b[0] as number);
  if (a[1] !== b[1]) return (a[1] as number) < (b[1] as number);
  return (a[2] as number) < (b[2] as number);
}

function intersect(a: Float32Array, da: number, b: Float32Array, db: number, out: Float32Array): void {
  // Canonical direction: always interpolate from the "smaller" endpoint.
  let from = a;
  let to = b;
  let df = da;
  let dt = db;
  if (lessThan(b, a)) {
    from = b;
    to = a;
    df = db;
    dt = da;
  }
  const t = df / (df - dt);
  for (let i = 0; i < 8; i++) out[i] = (from[i] as number) + ((to[i] as number) - (from[i] as number)) * t;
  const len = Math.hypot(out[3] as number, out[4] as number, out[5] as number) || 1;
  out[3] = (out[3] as number) / len;
  out[4] = (out[4] as number) / len;
  out[5] = (out[5] as number) / len;
}

/**
 * Cuts every triangle crossing the plane and sorts triangles into the two half-spaces.
 * The cut is left open (no cap); fragments render their inside via back faces instead,
 * which also works for thin shells like vases where a cap would be wrong.
 */
export function sliceSoup(s: Soup, plane: Plane): { front: Soup; back: Soup } {
  const front = new SoupBuilder(s.count);
  const back = new SoupBuilder(Math.max(8, s.count >> 1));
  const { nx, ny, nz, d } = plane;
  const dist = [0, 0, 0];

  for (let t = 0; t < s.count; t++) {
    let frontCount = 0;
    for (let k = 0; k < 3; k++) {
      const p = t * 9 + k * 3;
      const dk = nx * (s.pos[p] as number) + ny * (s.pos[p + 1] as number) + nz * (s.pos[p + 2] as number) - d;
      dist[k] = dk;
      if (dk >= 0) frontCount++;
    }
    if (frontCount === 3) {
      front.copyTri(s, t);
      continue;
    }
    if (frontCount === 0) {
      back.copyTri(s, t);
      continue;
    }

    // One vertex is alone on its side; find it (i) and keep winding order i -> j -> k.
    let lone = 0;
    for (let k = 0; k < 3; k++) {
      const isFront = (dist[k] as number) >= 0;
      if ((frontCount === 1 && isFront) || (frontCount === 2 && !isFront)) lone = k;
    }
    const i = lone;
    const j = (lone + 1) % 3;
    const k = (lone + 2) % 3;
    loadVertex(s, t, i, V[0] as Float32Array);
    loadVertex(s, t, j, V[1] as Float32Array);
    loadVertex(s, t, k, V[2] as Float32Array);
    const vi = V[0] as Float32Array;
    const vj = V[1] as Float32Array;
    const vk = V[2] as Float32Array;
    intersect(vi, dist[i] as number, vj, dist[j] as number, I1);
    intersect(vi, dist[i] as number, vk, dist[k] as number, I2);

    const slot = s.slot[t] as number;
    const mat = s.mat[t] as number;
    const loneSide = (dist[i] as number) >= 0 ? front : back;
    const otherSide = loneSide === front ? back : front;
    loneSide.pushVerts(vi, I1, I2, slot, mat);
    otherSide.pushVerts(I1, vj, vk, slot, mat);
    otherSide.pushVerts(I1, vk, I2, slot, mat);
  }
  return { front: front.build(), back: back.build() };
}
