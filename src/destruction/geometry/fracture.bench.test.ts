// Performance probe for the fracture pipeline on real game models (run with: npx vitest run fracture.bench).
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { BufferAttribute, BufferGeometry } from "three";
import { describe, expect, it } from "vitest";
import { Rng } from "../../core/rng";
import { buildParts } from "../Template";
import { chipSoup, fractureSoup } from "./fracture";
import { splitIslands } from "./islands";
import { planeFromPointNormal, sliceSoup } from "./slice";
import { hullPoints, type Soup, soupFromGeometry, soupStats } from "./soup";

async function loadSoup(id: string): Promise<Soup> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(`public/assets/models/${id}.glb`);
  const parts: { geometry: BufferGeometry; slot: number }[] = [];
  let slot = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const g = new BufferGeometry();
      const pos = prim.getAttribute("POSITION");
      const nrm = prim.getAttribute("NORMAL");
      const uv = prim.getAttribute("TEXCOORD_0");
      if (!pos || !nrm) continue;
      g.setAttribute("position", new BufferAttribute(pos.getArray() as Float32Array, 3));
      g.setAttribute("normal", new BufferAttribute(nrm.getArray() as Float32Array, 3));
      g.setAttribute("uv", new BufferAttribute((uv?.getArray() as Float32Array) ?? new Float32Array(pos.getCount() * 2), 2));
      const idx = prim.getIndices();
      if (idx) g.setIndex(new BufferAttribute(idx.getArray() as Uint16Array, 1));
      parts.push({ geometry: g, slot: slot++ });
    }
  }
  return soupFromGeometry(parts, () => 0);
}

function time(label: string, fn: () => unknown, runs = 20): number {
  fn();
  const t = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = (performance.now() - t) / runs;
  console.log(`${label.padEnd(36)} ${ms.toFixed(3)} ms`);
  return ms;
}

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
describe.skipIf(!env.BENCH)("fracture performance", () => {
  for (const id of ["ceramic_vase_01", "small_tv", "wine_bottle", "wooden_cabinet"]) {
    it(`profiles ${id}`, async () => {
      const soup = await loadSoup(id);
      const st = soupStats(soup);
      console.log(`\n${id}: ${soup.count} tris`);
      time("soupStats", () => soupStats(soup));
      time("splitIslands", () => splitIslands(soup));
      time("sliceSoup (1 plane)", () => sliceSoup(soup, planeFromPointNormal(st.centroid[0], st.centroid[1], st.centroid[2], 0.3, 1, 0.2)));
      time("hullPoints", () => hullPoints(soup, 64));
      time("buildParts", () => buildParts(soup));
      const req = { soup, point: [st.max[0], st.centroid[1], st.centroid[2]] as [number, number, number], dir: [-1, 0, 0] as [number, number, number], pattern: "radial" as const, pieces: 10, rng: new Rng(1) };
      const total = time("fractureSoup (10 pieces)", () => fractureSoup({ ...req, rng: new Rng(1) }), 10);
      time("chipSoup", () => chipSoup(soup, req.point, [1, 0, 0], 0.05, new Rng(2)));
      expect(total).toBeGreaterThan(0);
    });
  }
});
