import type { World } from "@dimforge/rapier3d";
import { Box3, MeshStandardMaterial, type Scene, Vector3 } from "three";
import type { Assets } from "../core/assets";
import { StaticBuilder } from "./architecture";
import { TRASH } from "./layout";
import { PropPlacer } from "./props";
import { createSign } from "./signs";

export type TrashContainer = {
  /** Interior below the rim: a piece that comes to rest in here is disposed of. */
  volume: Box3;
  /** Point in front of the container (prompts, debug). */
  front: Vector3;
};

/**
 * The street waste container: an open-top steel bin on casters, rusty green, with a real hollow
 * inside (floor and four walls as separate colliders), so pieces physically drop in, can bounce
 * off the rim, and settle on the bottom. Its interior is the disposal volume; nothing pulls
 * pieces in.
 */
export async function buildTrashContainer(scene: Scene, world: World, assets: Assets, label: string): Promise<TrashContainer> {
  const builder = new StaticBuilder(scene, world);
  const steel = assets.surface("dumpster_metal");
  const frame = assets.surface("metal_plate");
  const rubber = new MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.85 });
  const { x, z, width: w, depth: d, height: h, wall: t, floorY } = TRASH;
  const top = floorY + h;
  const wallH = h;
  const wallY = floorY + wallH / 2;

  // Floor (thick, so fast pieces cannot tunnel through) and the four walls.
  builder.box(steel, [w, 0.08, d], [x, floorY - 0.04, z], { tile: 1, castShadow: true });
  builder.box(steel, [w, wallH, t], [x, wallY, z - d / 2 + t / 2], { tile: 1, castShadow: true });
  builder.box(steel, [w, wallH, t], [x, wallY, z + d / 2 - t / 2], { tile: 1, castShadow: true });
  builder.box(steel, [t, wallH, d - 2 * t], [x - w / 2 + t / 2, wallY, z], { tile: 1, castShadow: true });
  builder.box(steel, [t, wallH, d - 2 * t], [x + w / 2 - t / 2, wallY, z], { tile: 1, castShadow: true });
  // Rolled rim and reinforcement ribs (visual only: the walls already collide).
  builder.box(frame, [w + 0.06, 0.06, 0.08], [x, top - 0.03, z - d / 2], { tile: 0.5, collider: false, castShadow: true });
  builder.box(frame, [w + 0.06, 0.06, 0.08], [x, top - 0.03, z + d / 2], { tile: 0.5, collider: false, castShadow: true });
  builder.box(frame, [0.08, 0.06, d + 0.06], [x - w / 2, top - 0.03, z], { tile: 0.5, collider: false, castShadow: true });
  builder.box(frame, [0.08, 0.06, d + 0.06], [x + w / 2, top - 0.03, z], { tile: 0.5, collider: false, castShadow: true });
  for (const rx of [-0.55, 0, 0.55]) builder.box(frame, [0.07, wallH * 0.86, 0.035], [x + rx * w * 0.8, wallY, z - d / 2 - 0.016], { tile: 0.5, collider: false });
  // Lifting pockets on the sides and four casters.
  for (const sx of [-1, 1]) builder.box(frame, [0.06, 0.12, d * 0.5], [x + sx * (w / 2 + 0.04), floorY + h * 0.62, z], { tile: 0.5, collider: false });
  for (const [cx, cz] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ] as const) {
    builder.box(rubber, [0.1, floorY - 0.01, 0.1], [x + cx * (w / 2 - 0.12), (floorY - 0.01) / 2, z + cz * (d / 2 - 0.12)], { collider: false, castShadow: true });
  }
  builder.flush();

  // A stencilled label on the front, and a few bags waiting beside it.
  const sign = createSign(label, { width: 0.7, height: 0.22, background: "#20321f", color: "#e9e4d6" });
  sign.position.set(x, floorY + h * 0.58, z - d / 2 - 0.036);
  sign.rotation.y = Math.PI;
  sign.updateMatrix();
  sign.matrixAutoUpdate = false;
  scene.add(sign);
  const props = new PropPlacer(scene, world, assets);
  props.place("trashbag", [x + w / 2 + 0.42, 0, z + 0.1], 30);
  props.place("trashbag", [x + w / 2 + 0.38, 0, z - 0.45], 160, { scale: 0.85 });
  await props.build();

  const inset = t + 0.03;
  return {
    volume: new Box3(new Vector3(x - w / 2 + inset, floorY, z - d / 2 + inset), new Vector3(x + w / 2 - inset, top - 0.08, z + d / 2 - inset)),
    front: new Vector3(x, 0, z - d / 2 - 0.8),
  };
}
