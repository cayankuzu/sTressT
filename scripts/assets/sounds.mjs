// Downloads Kenney "Impact Sounds" (CC0), converts the used clips from OGG to mono MP3
// (MP3 decodes in every browser, including old iOS Safari that lacks Ogg Vorbis) and
// writes a sound index grouping variations: { "impactGlass_heavy": 5, ... }.
// Usage: node scripts/assets/sounds.mjs
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { Mp3Encoder } from "@breezystack/lamejs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZIP_URL = "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip";
const ZIP_PATH = join(ROOT, "assets-src", "kenney", "impact-sounds.zip");
const OUT_DIR = join(ROOT, "public", "assets", "audio");
const INDEX_PATH = join(ROOT, "src", "data", "generated", "soundIndex.json");
/** Clip groups the game uses; each group has numbered variations _000.._004. */
const GROUPS = /^(footstep_(concrete|carpet)|impact(Glass|Metal|Plate|Wood)_(light|medium|heavy)|impactPlank_medium|impactPunch_(medium|heavy)|impactSoft_(medium|heavy)|impactTin_medium|impactMining|impactGeneric_light)_\d{3}\.ogg$/;
const KBPS = 96;
/** Trailing samples quieter than this are trimmed. */
const SILENCE = 0.002;

const exists = (p) => access(p).then(() => true, () => false);

async function ensureZip() {
  if (await exists(ZIP_PATH)) return;
  const res = await fetch(ZIP_URL, { headers: { "User-Agent": "sTressT-asset-pipeline/1.0" } });
  if (!res.ok) throw new Error(`${res.status} for ${ZIP_URL}`);
  await mkdir(dirname(ZIP_PATH), { recursive: true });
  await writeFile(ZIP_PATH, Buffer.from(await res.arrayBuffer()));
}

function toMonoInt16(channels, length) {
  let end = length;
  while (end > 0 && channels.every((c) => Math.abs(c[end - 1] ?? 0) < SILENCE)) end--;
  const out = new Int16Array(end);
  for (let i = 0; i < end; i++) {
    let sum = 0;
    for (const c of channels) sum += c[i] ?? 0;
    const v = Math.max(-1, Math.min(1, sum / channels.length));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function encodeMp3(samples, sampleRate) {
  const encoder = new Mp3Encoder(1, sampleRate, KBPS);
  const chunks = [];
  for (let i = 0; i < samples.length; i += 1152) chunks.push(encoder.encodeBuffer(samples.subarray(i, i + 1152)));
  chunks.push(encoder.flush());
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

async function main() {
  await ensureZip();
  const files = unzipSync(new Uint8Array(await readFile(ZIP_PATH)));
  await mkdir(OUT_DIR, { recursive: true });
  await mkdir(dirname(INDEX_PATH), { recursive: true });

  const decoder = new OggVorbisDecoder();
  await decoder.ready;
  const groups = {};
  let bytes = 0;

  for (const [path, data] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const name = path.split("/").pop();
    if (!GROUPS.test(name)) continue;
    const decoded = await decoder.decodeFile(data);
    await decoder.reset();
    const mp3 = encodeMp3(toMonoInt16(decoded.channelData, decoded.samplesDecoded), decoded.sampleRate);
    const base = name.replace(/\.ogg$/, "");
    await writeFile(join(OUT_DIR, `${base}.mp3`), mp3);
    bytes += mp3.length;
    const group = base.replace(/_\d{3}$/, "");
    groups[group] = (groups[group] ?? 0) + 1;
  }
  decoder.free();

  await writeFile(INDEX_PATH, JSON.stringify(groups, null, 2) + "\n");
  const count = Object.values(groups).reduce((a, b) => a + b, 0);
  console.log(`${count} clips in ${Object.keys(groups).length} groups, ${(bytes / 1024).toFixed(0)} KB`);
}

main();
