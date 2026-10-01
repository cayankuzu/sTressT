// Prints structure of downloaded source assets: nodes, materials, triangles, bounds.
// Usage: node scripts/assets/inspect.mjs [assetId ...]
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const manifest = JSON.parse(await readFile(join(ROOT, "scripts", "assets", "manifest.json"), "utf8"));
const only = new Set(process.argv.slice(2));

for (const asset of manifest.assets) {
  if (only.size && !only.has(asset.id)) continue;
  const doc = await io.read(join(ROOT, "assets-src", asset.source, asset.sourceId, "model.gltf"));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const b = getBounds(scene);
  const size = b.max.map((v, i) => (v - b.min[i]).toFixed(3)).join(" x ");
  let tris = 0;
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) tris += (prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount()) / 3;
  console.log(`\n== ${asset.id} (${asset.sourceId})  tris=${tris}  size(m)=${size}`);
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const mats = mesh.listPrimitives().map((p) => p.getMaterial()?.getName() ?? "-").join(",");
    const t = mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);
    console.log(`   node "${node.getName()}" tris=${t} mats=[${mats}] s=${node.getScale().map((v) => +v.toFixed(3))}`);
  }
}
