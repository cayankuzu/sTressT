import { describe, expect, it } from "vitest";
import { Rng } from "../../core/rng";
import { chipSoup, fractureSoup } from "./fracture";
import { labelIslands, splitIslands } from "./islands";
import { planeFromPointNormal, sliceSoup } from "./slice";
import { hullPoints, mergeSoups, type Soup, SoupBuilder, soupStats } from "./soup";

/** Closed axis-aligned box as a soup with outward normals and CCW winding. */
function box(cx = 0, cy = 0, cz = 0, size = 1): Soup {
  const h = size / 2;
  const b = new SoupBuilder(12);
  const faces: [number[], number[]][] = [
    [[1, 0, 0], [0, 1, 2, 3]],
    [[-1, 0, 0], [4, 5, 6, 7]],
    [[0, 1, 0], [8, 9, 10, 11]],
    [[0, -1, 0], [12, 13, 14, 15]],
    [[0, 0, 1], [16, 17, 18, 19]],
    [[0, 0, -1], [20, 21, 22, 23]],
  ];
  const corners = (n: number[]): number[][] => {
    // Build a CCW quad for the face whose outward normal is n.
    const [nx, ny, nz] = n as [number, number, number];
    const u = Math.abs(nx) > 0 ? [0, 0, -nx] : Math.abs(ny) > 0 ? [1, 0, 0] : [nz, 0, 0];
    const v = [ny * (u[2] as number) - nz * (u[1] as number), nz * (u[0] as number) - nx * (u[2] as number), nx * (u[1] as number) - ny * (u[0] as number)];
    return [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([a, c]) => [0, 1, 2].map((i) => [cx, cy, cz][i]! + (n[i]! + (u[i] as number) * a! + (v[i] as number) * c!) * h));
  };
  for (const [n] of faces) {
    const q = corners(n);
    const vert = (p: number[], uv: [number, number]) => new Float32Array([...p, ...n, ...uv]);
    b.pushVerts(vert(q[0]!, [0, 0]), vert(q[1]!, [1, 0]), vert(q[2]!, [1, 1]), 0, 0);
    b.pushVerts(vert(q[0]!, [0, 0]), vert(q[2]!, [1, 1]), vert(q[3]!, [0, 1]), 0, 0);
  }
  return b.build();
}

/** A round table top: a closed cylinder whose caps are triangle fans around a centre vertex. */
function cylinder(radius: number, height: number, segments = 24): Soup {
  const b = new SoupBuilder(segments * 4);
  const vert = (x: number, y: number, z: number, n: number[]) => new Float32Array([x, y, z, ...n, 0, 0]);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const [x0, z0, x1, z1] = [Math.cos(a0) * radius, Math.sin(a0) * radius, Math.cos(a1) * radius, Math.sin(a1) * radius];
    b.pushVerts(vert(0, height, 0, [0, 1, 0]), vert(x1, height, z1, [0, 1, 0]), vert(x0, height, z0, [0, 1, 0]), 0, 0);
    b.pushVerts(vert(0, 0, 0, [0, -1, 0]), vert(x0, 0, z0, [0, -1, 0]), vert(x1, 0, z1, [0, -1, 0]), 0, 0);
    const n0 = [Math.cos(a0), 0, Math.sin(a0)];
    const n1 = [Math.cos(a1), 0, Math.sin(a1)];
    b.pushVerts(vert(x0, 0, z0, n0), vert(x1, height, z1, n1), vert(x1, 0, z1, n1), 0, 0);
    b.pushVerts(vert(x0, 0, z0, n0), vert(x0, height, z0, n0), vert(x1, height, z1, n1), 0, 0);
  }
  return b.build();
}

/** Every triangle's geometric normal must agree with its stored vertex normal (winding kept). */
function windingConsistent(s: Soup): boolean {
  for (let t = 0; t < s.count; t++) {
    const p = s.pos.subarray(t * 9, t * 9 + 9);
    const ux = p[3]! - p[0]!, uy = p[4]! - p[1]!, uz = p[5]! - p[2]!;
    const vx = p[6]! - p[0]!, vy = p[7]! - p[1]!, vz = p[8]! - p[2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = Math.hypot(nx, ny, nz);
    if (area < 1e-9) continue;
    const dot = nx * s.nrm[t * 9]! + ny * s.nrm[t * 9 + 1]! + nz * s.nrm[t * 9 + 2]!;
    if (dot <= 0) return false;
  }
  return true;
}

describe("mesh slicing", () => {
  it("builds a valid test box", () => {
    const b = box();
    expect(b.count).toBe(12);
    expect(soupStats(b).area).toBeCloseTo(6, 5);
    expect(windingConsistent(b)).toBe(true);
  });

  it("splits a box into two halves that preserve area and winding", () => {
    const { front, back } = sliceSoup(box(), planeFromPointNormal(0, 0, 0, 1, 0, 0));
    expect(soupStats(front).area).toBeCloseTo(3, 4);
    expect(soupStats(back).area).toBeCloseTo(3, 4);
    expect(windingConsistent(front)).toBe(true);
    expect(windingConsistent(back)).toBe(true);
    expect(soupStats(front).min[0]).toBeGreaterThanOrEqual(-1e-6);
    expect(soupStats(back).max[0]).toBeLessThanOrEqual(1e-6);
  });

  it("produces bit-identical cut points so halves stay connected when merged", () => {
    const { front, back } = sliceSoup(box(), planeFromPointNormal(0.1, 0, 0, 1, 0.3, 0.2));
    expect(labelIslands(mergeSoups([front, back])).count).toBe(1);
  });

  it("leaves a soup entirely on one side untouched", () => {
    const { front, back } = sliceSoup(box(), planeFromPointNormal(5, 0, 0, 1, 0, 0));
    expect(front.count).toBe(0);
    expect(back.count).toBe(12);
  });
});

describe("islands", () => {
  it("separates disconnected parts", () => {
    const two = mergeSoups([box(0, 0, 0), box(3, 0, 0)]);
    expect(splitIslands(two)).toHaveLength(2);
  });
});

describe("fracture", () => {
  const request = (seed: number) => ({
    soup: box(0, 0.5, 0),
    point: [0, 1, 0] as [number, number, number],
    dir: [0, -1, 0] as [number, number, number],
    pattern: "radial" as const,
    pieces: 8,
    rng: new Rng(seed),
  });

  it("breaks a box into several pieces while preserving surface area", () => {
    const pieces = fractureSoup(request(7));
    expect(pieces.length).toBeGreaterThanOrEqual(5);
    const area = pieces.reduce((sum, p) => sum + soupStats(p).area, 0);
    expect(area).toBeCloseTo(6, 3);
    for (const p of pieces) {
      expect(p.count).toBeGreaterThan(0);
      expect(windingConsistent(p)).toBe(true);
    }
  });

  it("is deterministic for a seed and varies across seeds", () => {
    const a = fractureSoup(request(1)).map((p) => p.count);
    const b = fractureSoup(request(1)).map((p) => p.count);
    const c = fractureSoup(request(2)).map((p) => p.count);
    expect(a).toEqual(b);
    expect(c).not.toEqual(a);
  });

  it("works for every pattern", () => {
    for (const pattern of ["radial", "shatter", "splinter", "chunk", "tear"] as const) {
      const pieces = fractureSoup({ ...request(3), pattern });
      expect(pieces.length).toBeGreaterThan(1);
    }
  });

  it("still cuts a body that carries many tiny detail islands (knobs, screws)", () => {
    // A big box plus six tiny boxes: the islands alone already outnumber the requested pieces,
    // but they are glued back on, so the big body itself must be cut.
    const details = [0, 1, 2, 3, 4, 5].map((i) => box(-0.4 + i * 0.16, 1.02, 0.4, 0.02));
    const soup = mergeSoups([box(0, 0.5, 0), ...details]);
    const pieces = fractureSoup({ ...request(5), soup, pieces: 4 });
    const areas = pieces.map((p) => soupStats(p).area).sort((a, b) => b - a);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    expect(areas[0] as number).toBeLessThan(soupStats(soup).area * 0.75);
  });
});

describe("chipping", () => {
  it("knocks a local chip off a corner and keeps the rest", () => {
    const soup = box(0, 0.5, 0);
    const result = chipSoup(soup, [0.5, 1, 0.5], [0.577, 0.577, 0.577], 0.15, new Rng(3));
    expect(result).not.toBeNull();
    const chipArea = result!.chips.reduce((s, c) => s + soupStats(c).area, 0);
    expect(chipArea).toBeGreaterThan(0);
    expect(chipArea).toBeLessThan(0.5);
    expect(soupStats(result!.remain).area + chipArea).toBeCloseTo(6, 3);
  });
});

describe("hull points", () => {
  const layers = (pts: Float32Array) => {
    const ys: number[] = [];
    for (let i = 1; i < pts.length; i += 3) ys.push(pts[i] as number);
    const max = Math.max(...ys);
    const min = Math.min(...ys);
    const top: [number, number][] = [];
    for (let i = 0; i < pts.length; i += 3) if (pts[i + 1] === max) top.push([pts[i] as number, pts[i + 2] as number]);
    return { max, min, top, bottom: ys.filter((y) => y === min).length, bevel: ys.filter((y) => y < max && y > max - 0.006).length };
  };
  const area = (poly: [number, number][]) => {
    // The corners come unordered: sort them around their centre first.
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const sorted = poly.slice().sort((a, b) => Math.atan2(a[1] - cz, a[0] - cx) - Math.atan2(b[1] - cz, b[0] - cx));
    let sum = 0;
    for (let i = 0; i < sorted.length; i++) {
      const [x0, z0] = sorted[i] as [number, number];
      const [x1, z1] = sorted[(i + 1) % sorted.length] as [number, number];
      sum += x0 * z1 - x1 * z0;
    }
    return Math.abs(sum) / 2;
  };

  it("gives a round top a single four-corner face, the rest of its rim as a bevel", () => {
    // Rapier clips contacts on faces with more than four corners: a cup there tips over.
    const pts = hullPoints(cylinder(0.3, 0.5));
    const { top, bottom, bevel } = layers(pts);
    expect(top.length).toBe(4);
    expect(bottom).toBe(4);
    expect(area(top)).toBeGreaterThan(0.6 * Math.PI * 0.3 * 0.3);
    expect(bevel).toBeGreaterThanOrEqual(8);
  });

  it("keeps a paper-thin shard three-dimensional (never a flat, invalid hull)", () => {
    const shard = box(0, 0.001, 0, 1);
    for (let i = 1; i < shard.pos.length; i += 3) shard.pos[i] = (shard.pos[i] as number) > 0.001 ? 0.002 : 0;
    const pts = hullPoints(shard);
    const ys = new Set<number>();
    for (let i = 1; i < pts.length; i += 3) ys.add(pts[i] as number);
    expect(ys.size).toBeGreaterThan(1);
    expect(pts.length / 3).toBeGreaterThanOrEqual(4);
  });

  it("keeps a box's top and base as its four corners only", () => {
    const pts = hullPoints(box(0, 0.5, 0, 1));
    const { top, bottom } = layers(pts);
    expect(top.length).toBe(4);
    expect(bottom).toBe(4);
    expect(area(top)).toBeCloseTo(1, 3);
  });
});
