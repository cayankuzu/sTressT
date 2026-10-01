// Downloads source assets listed in manifest.json into assets-src/ (idempotent: existing files are skipped).
// Usage: node scripts/assets/fetch.mjs [assetId ...]
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC_DIR = join(ROOT, "assets-src");
const UA = { "User-Agent": "sTressT-asset-pipeline/1.0" };
const CONCURRENCY = 4;

const exists = (p) => access(p).then(() => true, () => false);

async function download(url, dest) {
  if (await exists(dest)) return false;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function getJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function fetchPolyHaven(asset) {
  const dir = join(SRC_DIR, "polyhaven", asset.sourceId);
  const infoPath = join(dir, "info.json");
  if (!(await exists(infoPath))) {
    const info = await getJson(`https://api.polyhaven.com/info/${asset.sourceId}`);
    await mkdir(dir, { recursive: true });
    await writeFile(infoPath, JSON.stringify(info, null, 2));
  }
  const files = await getJson(`https://api.polyhaven.com/files/${asset.sourceId}`);
  const gltf = files.gltf?.["1k"]?.gltf;
  if (!gltf) throw new Error(`no 1k glTF for ${asset.sourceId}`);
  let fetched = 0;
  if (await download(gltf.url, join(dir, "model.gltf"))) fetched++;
  for (const [rel, file] of Object.entries(gltf.include ?? {})) {
    if (await download(file.url, join(dir, rel))) fetched++;
  }
  return fetched;
}

/** Tiling PBR textures: 1k diffuse, OpenGL normal and packed AO/rough/metal maps. */
async function fetchPolyHavenTexture(tex) {
  const dir = join(SRC_DIR, "polyhaven-tex", tex.sourceId);
  const infoPath = join(dir, "info.json");
  if (!(await exists(infoPath))) {
    const info = await getJson(`https://api.polyhaven.com/info/${tex.sourceId}`);
    await mkdir(dir, { recursive: true });
    await writeFile(infoPath, JSON.stringify(info, null, 2));
  }
  const files = await getJson(`https://api.polyhaven.com/files/${tex.sourceId}`);
  const maps = { diff: files.Diffuse, nor: files.nor_gl, arm: files.arm };
  let fetched = 0;
  for (const [name, map] of Object.entries(maps)) {
    const url = map?.["1k"]?.jpg?.url;
    if (!url) throw new Error(`no 1k ${name} map for ${tex.sourceId}`);
    if (await download(url, join(dir, `${name}.jpg`))) fetched++;
  }
  return fetched;
}

/** Poly Pizza: single GLB; license details come from the manifest entry (verified by hand on the model page). */
async function fetchPolyPizza(asset) {
  const dir = join(SRC_DIR, "polypizza", asset.sourceId);
  const infoPath = join(dir, "info.json");
  if (!(await exists(infoPath))) {
    await mkdir(dir, { recursive: true });
    await writeFile(infoPath, JSON.stringify(asset.license, null, 2));
  }
  return (await download(asset.url, join(dir, "model.glb"))) ? 1 : 0;
}

const FETCHERS = { polyhaven: fetchPolyHaven, polypizza: fetchPolyPizza };
const TEXTURE_FETCHERS = { polyhaven: fetchPolyHavenTexture };

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, "scripts", "assets", "manifest.json"), "utf8"));
  const only = new Set(process.argv.slice(2));
  const wanted = (a) => only.size === 0 || only.has(a.id);
  const queue = [
    ...manifest.assets.filter((a) => wanted(a) && FETCHERS[a.source]).map((a) => ({ ...a, run: FETCHERS[a.source] })),
    ...(manifest.textures ?? []).filter((t) => wanted(t) && TEXTURE_FETCHERS[t.source]).map((t) => ({ ...t, run: TEXTURE_FETCHERS[t.source] })),
  ];
  const failures = [];

  const worker = async () => {
    for (let asset = queue.shift(); asset; asset = queue.shift()) {
      try {
        const n = await asset.run(asset);
        console.log(`${n > 0 ? "fetched" : "cached "}  ${asset.id} (${n} files)`);
      } catch (err) {
        failures.push({ id: asset.id, reason: String(err.message ?? err) });
        console.error(`FAILED   ${asset.id}: ${err.message ?? err}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (failures.length) {
    console.error(`\n${failures.length} asset(s) failed; they are excluded from the build.`);
    process.exitCode = 1;
  }
}

main();
