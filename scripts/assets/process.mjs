// Converts downloaded source assets into game-ready files + an asset index + ASSET_LICENSES.md.
// Models:
//   - keeps only the picked nodes, bakes node transforms, joins primitives per material
//   - strips GPU-expensive material extensions (transmission etc. -> cheap alpha-blended glass)
//   - simplifies to the manifest triangle budget, puts the pivot at the bottom centre
//   - resizes textures and re-encodes them as WebP
// Textures: tiling PBR sets -> WebP (base colour + normal at full size, AO/rough/metal at half).
// Usage: node scripts/assets/process.mjs [id ...]
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  center,
  clearNodeTransform,
  dedup,
  flatten,
  getBounds,
  join as joinPrimitives,
  normals,
  prune,
  simplify,
  textureCompress,
  weld,
} from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MODEL_OUT_DIR = join(ROOT, "public", "assets", "models");
const TEX_OUT_DIR = join(ROOT, "public", "assets", "textures");
const INDEX_PATH = join(ROOT, "src", "data", "generated", "assetIndex.json");
const LICENSE_PATH = join(ROOT, "ASSET_LICENSES.md");
const EXTRA_LICENSES_PATH = join(ROOT, "scripts", "assets", "extra-licenses.md");
const EXPENSIVE_EXTENSIONS = /^KHR_materials_(transmission|volume|specular|ior|clearcoat|sheen|iridescence|anisotropy|dispersion)$/;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

function countTriangles(doc) {
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) tris += (prim.getIndices()?.getCount() ?? prim.getAttribute("POSITION").getCount()) / 3;
  return tris;
}

/** Replaces physically-based transmission with plain alpha blending; drops other costly extensions. */
function cheapenMaterials(doc) {
  for (const mat of doc.getRoot().listMaterials()) {
    const name = mat.getName().toLowerCase();
    const transmissive = mat.getExtension("KHR_materials_transmission") !== null;
    if (transmissive && /wine|liquid/.test(name)) {
      const [r, g, b] = mat.getBaseColorFactor();
      mat.setBaseColorFactor([r * 0.35, g * 0.2, b * 0.2, 1]).setAlphaMode("OPAQUE").setRoughnessFactor(0.2);
    } else if (transmissive || /glass/.test(name)) {
      const [r, g, b] = mat.getBaseColorFactor();
      mat.setBaseColorFactor([r, g, b, 0.32]).setAlphaMode("BLEND").setRoughnessFactor(Math.min(mat.getRoughnessFactor(), 0.12));
      mat.setDoubleSided(true);
    }
    for (const ext of mat.listExtensions()) mat.setExtension(ext.extensionName, null);
  }
  for (const ext of doc.getRoot().listExtensionsUsed()) if (EXPENSIVE_EXTENSIONS.test(ext.extensionName)) ext.dispose();
}

async function readLicense(source, srcDir, sourceId) {
  const info = JSON.parse(await readFile(join(srcDir, "info.json"), "utf8"));
  if (source === "polypizza") return { ...info, site: "Poly Pizza" };
  return { name: info.name, authors: Object.keys(info.authors ?? {}), url: `https://polyhaven.com/a/${sourceId}`, site: "Poly Haven", license: "CC0 1.0" };
}

async function processModel(asset) {
  const srcDir = join(ROOT, "assets-src", asset.source, asset.sourceId);
  const doc = await io.read(join(srcDir, asset.source === "polypizza" ? "model.glb" : "model.gltf"));
  const root = doc.getRoot();

  if (asset.pick) {
    for (const node of root.listNodes()) if (node.getMesh() && !asset.pick.includes(node.getName())) node.dispose();
  }
  await doc.transform(flatten());
  for (const node of root.listNodes()) if (node.getMesh()) clearNodeTransform(node);
  cheapenMaterials(doc);
  if (asset.recolor) for (const mat of root.listMaterials()) mat.setBaseColorFactor([...asset.recolor, 1]).setRoughnessFactor(0.55).setMetallicFactor(0);
  await doc.transform(prune());

  const srcTris = countTriangles(doc);
  const ratio = Math.min(1, asset.maxTris / srcTris);
  await doc.transform(
    joinPrimitives({ keepNamed: false }),
    weld(),
    ...(asset.smooth ? [normals({ overwrite: true })] : []),
    ...(ratio < 1 ? [simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.004 })] : []),
    center({ pivot: "below" }),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [asset.tex, asset.tex], slots: /^baseColorTexture$/, quality: 82 }),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [asset.tex / 2, asset.tex / 2], slots: /^(?!baseColorTexture$)/, quality: 88 }),
    dedup(),
    prune(),
  );

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const bounds = getBounds(scene);
  const size = bounds.max.map((v, i) => +(v - bounds.min[i]).toFixed(4));
  const outPath = join(MODEL_OUT_DIR, `${asset.id}.glb`);
  await io.write(outPath, doc);

  return {
    srcTris,
    entry: {
      file: `assets/models/${asset.id}.glb`,
      role: asset.role,
      triangles: countTriangles(doc),
      size,
      materials: root.listMaterials().map((m) => m.getName()),
      bytes: (await stat(outPath)).size,
      license: await readLicense(asset.source, srcDir, asset.sourceId),
    },
  };
}

async function processTexture(tex) {
  const srcDir = join(ROOT, "assets-src", "polyhaven-tex", tex.sourceId);
  const outputs = [
    ["diff", tex.size, 82],
    ["nor", tex.size, 90],
    ["arm", tex.size / 2, 88],
  ];
  let bytes = 0;
  for (const [map, size, quality] of outputs) {
    const out = join(TEX_OUT_DIR, `${tex.id}_${map}.webp`);
    const info = await sharp(join(srcDir, `${map}.jpg`)).resize(size, size, { fit: "fill" }).webp({ quality }).toFile(out);
    bytes += info.size;
  }
  return { base: `assets/textures/${tex.id}`, bytes, license: await readLicense("polyhaven", srcDir, tex.sourceId) };
}

async function writeLicenses(index) {
  const header = ["| Game id | Original asset | Author(s) | Source | License |", "| --- | --- | --- | --- | --- |"];
  const rows = (group) =>
    Object.entries(group)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, e]) => `| \`${id}\` | ${e.license.name} | ${e.license.authors.join(", ")} | [${e.license.site}](${e.license.url}) | ${e.license.license} |`);
  let extra = "";
  try {
    extra = (await readFile(EXTRA_LICENSES_PATH, "utf8")).trim();
  } catch {
    // no hand-maintained license sections yet
  }
  const lines = [
    "# Asset Licenses",
    "",
    "All third-party assets shipped with sTressT, with source and license. Generated by `npm run assets:process`.",
    "",
    "## 3D models",
    "",
    "Processed (simplified, re-textured as WebP, re-pivoted) from the originals. CC-BY assets require the attribution below; CC0 assets do not, but their authors are credited anyway.",
    "",
    ...header,
    ...rows(index.models),
    "",
    "## Textures",
    "",
    ...header,
    ...rows(index.textures),
    "",
  ];
  if (extra) lines.push(extra, "");
  await writeFile(LICENSE_PATH, lines.join("\n"));
}

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, "scripts", "assets", "manifest.json"), "utf8"));
  const only = new Set(process.argv.slice(2));
  const wanted = (item) => only.size === 0 || only.has(item.id);
  await mkdir(MODEL_OUT_DIR, { recursive: true });
  await mkdir(TEX_OUT_DIR, { recursive: true });
  await mkdir(dirname(INDEX_PATH), { recursive: true });

  const index = { models: {}, textures: {} };
  try {
    const previous = JSON.parse(await readFile(INDEX_PATH, "utf8"));
    Object.assign(index.models, previous.models);
    Object.assign(index.textures, previous.textures);
  } catch {
    // first run: start with an empty index
  }
  const failures = [];

  for (const asset of manifest.assets.filter(wanted)) {
    try {
      const { entry, srcTris } = await processModel(asset);
      index.models[asset.id] = entry;
      console.log(`${asset.id.padEnd(20)} ${String(srcTris).padStart(6)} -> ${String(entry.triangles).padStart(5)} tris  ${(entry.bytes / 1024).toFixed(0).padStart(5)} KB  [${entry.size.join(" x ")}] m`);
    } catch (err) {
      failures.push(asset.id);
      console.error(`FAILED ${asset.id}: ${err.stack ?? err}`);
    }
  }
  for (const tex of (manifest.textures ?? []).filter(wanted)) {
    try {
      index.textures[tex.id] = await processTexture(tex);
      console.log(`${tex.id.padEnd(20)} texture set  ${(index.textures[tex.id].bytes / 1024).toFixed(0).padStart(5)} KB`);
    } catch (err) {
      failures.push(tex.id);
      console.error(`FAILED ${tex.id}: ${err.stack ?? err}`);
    }
  }

  const knownModels = new Set(manifest.assets.map((a) => a.id));
  const knownTextures = new Set((manifest.textures ?? []).map((t) => t.id));
  for (const id of Object.keys(index.models)) if (!knownModels.has(id)) delete index.models[id];
  for (const id of Object.keys(index.textures)) if (!knownTextures.has(id)) delete index.textures[id];
  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
  await writeLicenses(index);

  const total = [...Object.values(index.models), ...Object.values(index.textures)].reduce((sum, e) => sum + e.bytes, 0);
  console.log(`\n${Object.keys(index.models).length} models, ${Object.keys(index.textures).length} texture sets, ${(total / 1024 / 1024).toFixed(2)} MB total`);
  if (failures.length) {
    console.error(`FAILED: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main();
