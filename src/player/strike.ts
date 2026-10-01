import RAPIER, { type Collider, type World } from "@dimforge/rapier3d";
import { Vector3 } from "three";
import { GROUPS } from "../config/gameConfig";

export type StrikeTarget = { collider: Collider; point: Vector3; normal: Vector3; distance: number };

/**
 * Finds what a melee strike actually touches: a precise ray first, then a sphere sweep as wide
 * as the striking surface. Both stop at the first solid thing, so nothing is ever hit through a
 * wall or through the object in front of it. When the ray slips through a gap (between chair
 * legs, past the edge of a vase) and hits the floor or a wall behind, a breakable thing the
 * striking surface would have clipped on the way is struck instead: the swing connects with what
 * the player aimed at.
 */
export function findStrikeTarget(world: World, origin: Vector3, dir: Vector3, reach: number, radius: number, exclude: Collider, isTarget?: (c: Collider) => boolean): StrikeTarget | null {
  const ray = new RAPIER.Ray(origin, dir);
  const rayHit = world.castRayAndGetNormal(ray, reach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.aim, exclude);
  if (rayHit && (!isTarget || isTarget(rayHit.collider))) {
    return {
      collider: rayHit.collider,
      point: origin.clone().addScaledVector(dir, rayHit.timeOfImpact),
      normal: new Vector3(rayHit.normal.x, rayHit.normal.y, rayHit.normal.z),
      distance: rayHit.timeOfImpact,
    };
  }
  const r = Math.max(0.04, radius);
  const shapeHit = world.castShape(origin, { x: 0, y: 0, z: 0, w: 1 }, dir, new RAPIER.Ball(r), 0, Math.max(0.05, reach - r), true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.aim, exclude);
  if (rayHit && (!shapeHit || !isTarget?.(shapeHit.collider) || shapeHit.time_of_impact > rayHit.timeOfImpact)) {
    return {
      collider: rayHit.collider,
      point: origin.clone().addScaledVector(dir, rayHit.timeOfImpact),
      normal: new Vector3(rayHit.normal.x, rayHit.normal.y, rayHit.normal.z),
      distance: rayHit.timeOfImpact,
    };
  }
  if (!shapeHit) return null;
  return {
    collider: shapeHit.collider,
    point: new Vector3(shapeHit.witness1.x, shapeHit.witness1.y, shapeHit.witness1.z),
    normal: new Vector3(shapeHit.normal1.x, shapeHit.normal1.y, shapeHit.normal1.z),
    distance: shapeHit.time_of_impact,
  };
}
