import type { MeshStandardMaterial } from "three";
import type { Assets } from "../core/assets";
import { getObject } from "../data/catalog";
import { MATERIAL_TYPES, type MaterialType, type ObjectDefinition } from "../data/types";
import { splitIslands } from "./geometry/islands";
import { mergeSoups, type Soup, soupFromGeometry, type SoupStats, soupStats, subsetSoup } from "./geometry/soup";

export type PartSeed = { soup: Soup; mat: MaterialType; stats: SoupStats };

/** Everything shared by all instances of one object definition. */
export type Template = {
  id: string;
  def: ObjectDefinition;
  materials: MeshStandardMaterial[];
  soup: Soup;
  parts: PartSeed[];
  totalArea: number;
  size: [number, number, number];
  /** Centre of the model's bounding box in its own frame (the origin sits at the base). */
  center: [number, number, number];
};

const MAX_PARTS = 10;
const MAJOR_AREA_SHARE = 0.035;
/** A glass island (a door window, a screen) is its own part down to this share: it must shatter. */
const GLASS_AREA_SHARE = 0.004;

export function materialIndex(type: MaterialType): number {
  return MATERIAL_TYPES.indexOf(type);
}

export function materialAt(index: number): MaterialType {
  return MATERIAL_TYPES[index] ?? "plastic";
}

function majorityMaterial(s: Soup): MaterialType {
  const counts = new Map<number, number>();
  for (let t = 0; t < s.count; t++) counts.set(s.mat[t] as number, (counts.get(s.mat[t] as number) ?? 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [m, c] of counts) {
    if (c > bestCount) {
      best = m;
      bestCount = c;
    }
  }
  return materialAt(best);
}

function boxDistance(p: [number, number, number], stats: SoupStats): number {
  let d2 = 0;
  for (let i = 0; i < 3; i++) {
    const v = p[i] as number;
    const lo = stats.min[i] as number;
    const hi = stats.max[i] as number;
    const d = v < lo ? lo - v : v > hi ? v - hi : 0;
    d2 += d * d;
  }
  return Math.sqrt(d2);
}

/**
 * Groups the model's connected components into structural parts: big islands become parts
 * (legs, seat, back, screen, door...), small bits (screws, knobs) attach to the nearest part.
 */
export function buildParts(soup: Soup): PartSeed[] {
  const islands = splitIslands(soup)
    .flatMap(splitGlass)
    .map((s) => ({ soup: s, stats: soupStats(s) }));
  islands.sort((a, b) => b.stats.area - a.stats.area);
  const total = islands.reduce((sum, i) => sum + i.stats.area, 0) || 1;
  const isGlass = (s: Soup): boolean => majorityMaterial(s) === "glass";
  const majors = islands.filter((i, idx) => {
    if (idx === 0) return true;
    const share = i.stats.area / total;
    return share >= MAJOR_AREA_SHARE || (share >= GLASS_AREA_SHARE && isGlass(i.soup));
  });
  majors.splice(MAX_PARTS);
  const groups = majors.map((m) => [m.soup]);
  for (const island of islands) {
    if (majors.includes(island)) continue;
    let best = 0;
    let bestDist = Infinity;
    majors.forEach((m, i) => {
      const d = boxDistance(island.stats.centroid, m.stats);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    (groups[best] as Soup[]).push(island.soup);
  }
  return groups.map((g) => {
    const merged = g.length === 1 ? (g[0] as Soup) : mergeSoups(g);
    return { soup: merged, mat: majorityMaterial(merged), stats: soupStats(merged) };
  });
}

export async function buildTemplate(definitionId: string, assets: Assets): Promise<Template> {
  const def = getObject(definitionId);
  const model = await assets.model(def.model);
  const scale = def.scale ?? 1;
  const baseMat = materialIndex(def.material);
  const glassMat = materialIndex("glass");
  const glassSlots = new Set(model.parts.map((p, i) => (/glass/i.test(p.name) ? i : -1)).filter((i) => i >= 0));

  const soup = soupFromGeometry(
    model.parts.map((p, slot) => ({ geometry: p.geometry, slot })),
    (slot, cx, cy, cz) => {
      for (const zone of def.zones ?? []) {
        if (cx >= zone.min[0] && cx <= zone.max[0] && cy >= zone.min[1] && cy <= zone.max[1] && cz >= zone.min[2] && cz <= zone.max[2]) {
          return materialIndex(zone.material);
        }
      }
      return glassSlots.has(slot) ? glassMat : baseMat;
    },
  );
  if (scale !== 1) for (let i = 0; i < soup.pos.length; i++) soup.pos[i] = (soup.pos[i] as number) * scale;
  if (def.restPose === "faceUp") layFaceUp(soup);

  const parts = buildParts(soup);
  const bounds = soupStats(soup);
  const size: [number, number, number] =
    def.restPose === "faceUp" ? [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]] : [model.size.x * scale, model.size.y * scale, model.size.z * scale];
  return {
    id: definitionId,
    def,
    materials: model.parts.map((p) => p.material),
    soup,
    parts,
    totalArea: parts.reduce((sum, p) => sum + p.stats.area, 0),
    size,
    center: [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2],
  };
}

/**
 * A door window or screen modelled in one piece with its frame (shared vertices) would otherwise
 * be part of a metal or plastic part and never shatter: its glass becomes an island of its own.
 */
function splitGlass(island: Soup): Soup[] {
  const glass = materialIndex("glass");
  const glassTris: number[] = [];
  const otherTris: number[] = [];
  for (let t = 0; t < island.count; t++) (island.mat[t] === glass ? glassTris : otherTris).push(t);
  if (glassTris.length === 0 || otherTris.length === 0) return [island];
  return [subsetSoup(island, otherTris), ...splitIslands(subsetSoup(island, glassTris))];
}

/**
 * Turns the model onto its back, front (+Z) facing up, base on y = 0 and centred in x/z: a thin
 * panel then lies flat instead of balancing on its edge.
 */
function layFaceUp(soup: Soup): void {
  // (x, y, z) -> (x, z, -y): a quarter turn about X.
  for (let i = 0; i < soup.count * 3; i++) {
    for (const arr of [soup.pos, soup.nrm]) {
      const y = arr[i * 3 + 1] as number;
      arr[i * 3 + 1] = arr[i * 3 + 2] as number;
      arr[i * 3 + 2] = -y;
    }
  }
  const { min, max } = soupStats(soup);
  const dx = -(min[0] + max[0]) / 2;
  const dz = -(min[2] + max[2]) / 2;
  for (let i = 0; i < soup.count * 3; i++) {
    soup.pos[i * 3] = (soup.pos[i * 3] as number) + dx;
    soup.pos[i * 3 + 1] = (soup.pos[i * 3 + 1] as number) - min[1];
    soup.pos[i * 3 + 2] = (soup.pos[i * 3 + 2] as number) + dz;
  }
}
