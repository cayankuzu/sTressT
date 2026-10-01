import type { Soup, Vec3 } from "./geometry/soup";

/**
 * Pushes vertices near `point` along `dir` (a dent), with a smooth falloff over `radius`.
 * Normals of the touched vertices are bent towards the new face normals so lighting follows
 * the dent. Returns true if any vertex moved.
 */
export function dentSoup(s: Soup, point: Vec3, dir: Vec3, radius: number, depth: number): boolean {
  if (!(depth > 0) || !(radius > 0)) return false;
  const r2 = radius * radius;
  const touched: number[] = [];
  const weights: number[] = [];
  for (let v = 0; v < s.count * 3; v++) {
    const dx = (s.pos[v * 3] as number) - point[0];
    const dy = (s.pos[v * 3 + 1] as number) - point[1];
    const dz = (s.pos[v * 3 + 2] as number) - point[2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const f = 1 - d2 / r2;
    const w = f * f;
    s.pos[v * 3] = (s.pos[v * 3] as number) + dir[0] * depth * w;
    s.pos[v * 3 + 1] = (s.pos[v * 3 + 1] as number) + dir[1] * depth * w;
    s.pos[v * 3 + 2] = (s.pos[v * 3 + 2] as number) + dir[2] * depth * w;
    touched.push(v);
    weights.push(w);
  }
  if (touched.length === 0) return false;

  touched.forEach((v, i) => {
    const t = Math.floor(v / 3);
    const o = t * 9;
    const p = s.pos;
    const ux = (p[o + 3] as number) - (p[o] as number);
    const uy = (p[o + 4] as number) - (p[o + 1] as number);
    const uz = (p[o + 5] as number) - (p[o + 2] as number);
    const wx = (p[o + 6] as number) - (p[o] as number);
    const wy = (p[o + 7] as number) - (p[o + 1] as number);
    const wz = (p[o + 8] as number) - (p[o + 2] as number);
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) return;
    nx /= len;
    ny /= len;
    nz /= len;
    const blend = Math.min(1, (weights[i] as number) * 1.5) * 0.6;
    const bx = (s.nrm[v * 3] as number) * (1 - blend) + nx * blend;
    const by = (s.nrm[v * 3 + 1] as number) * (1 - blend) + ny * blend;
    const bz = (s.nrm[v * 3 + 2] as number) * (1 - blend) + nz * blend;
    const bl = Math.hypot(bx, by, bz) || 1;
    s.nrm[v * 3] = bx / bl;
    s.nrm[v * 3 + 1] = by / bl;
    s.nrm[v * 3 + 2] = bz / bl;
  });
  return true;
}
