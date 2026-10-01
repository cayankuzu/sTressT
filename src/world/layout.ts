/**
 * World layout in metres. The street runs along X; buildings line the north side (negative Z).
 * Yaw 0 looks towards -Z (north, at the shops).
 *
 *   [ OBJECT STORE ]  [   sTressT   ]  [ TOOL SHOP ]      z = -6.5 (north facades)
 *   ------------------ sidewalk -------------------
 *   ====================== road ===================      z = 0
 *   ------------------ sidewalk -------------------
 *   ||||||||||||||||| alley wall |||||||||||||||||||      z = +6.5
 */
export const STREET = {
  halfLength: 18,
  roadHalfWidth: 3.5,
  northFacadeZ: -6.5,
  southFacadeZ: 6.5,
  facadeThickness: 0.3,
  roadDepth: 0.15,
} as const;

export const ROOM = {
  /** Centre of the room floor. */
  origin: [0, 0, -9.8] as [number, number, number],
  width: 8,
  depth: 6,
  height: 3.2,
  wall: 0.3,
} as const;

/** The roller-shutter entrance between street and rage room (in the facade wall). */
export const ROOM_DOOR = { x: 0, width: 1.1, height: 2.3 } as const;

export const SHOPS = {
  objects: { name: "OBJECT STORE", x0: -17, x1: -5.6, doorX: -9, windowX0: -15.2, windowX1: -11 },
  tools: { name: "TOOL SHOP", x0: 5.6, x1: 17, doorX: 9, windowX0: 11, windowX1: 15.2 },
} as const;

export const SPAWN = { position: [0, 0, 4.4] as [number, number, number], yaw: 0 };
/** Where the player stands when entering the room through the door. */
export const ROOM_ENTRY = { position: [0, 0, -7.6] as [number, number, number], yaw: 0 };

export function roomToWorld(local: readonly [number, number, number]): [number, number, number] {
  return [local[0] + ROOM.origin[0], local[1] + ROOM.origin[1], local[2] + ROOM.origin[2]];
}

export function worldToRoom(world: readonly [number, number, number]): [number, number, number] {
  return [world[0] - ROOM.origin[0], world[1] - ROOM.origin[1], world[2] - ROOM.origin[2]];
}

/** True when a world position is inside the rage room interior. */
export function isInRoom(x: number, z: number): boolean {
  const [ox, , oz] = ROOM.origin;
  return Math.abs(x - ox) < ROOM.width / 2 && z < STREET.northFacadeZ - STREET.facadeThickness && z > oz - ROOM.depth / 2;
}

/**
 * Behind the north facades there is nothing but the rage room. A point there that is outside the
 * room (behind its walls, under its floor, above its ceiling, inside a shop) cannot be reached by
 * anything legitimate. Returns the nearest point inside the room, `margin` from its walls, or null
 * when the point is fine (in the room, in the doorway or anywhere on the street side).
 */
export function confineToRoom(x: number, y: number, z: number, margin: number): [number, number, number] | null {
  const front = STREET.northFacadeZ - STREET.facadeThickness;
  if (z >= front) return null;
  const [ox, , oz] = ROOM.origin;
  const hw = ROOM.width / 2;
  const back = oz - ROOM.depth / 2;
  // A little below the floor is the floor rescue's job (it puts the piece back on top).
  if (Math.abs(x - ox) <= hw && z >= back && y >= -0.05 && y <= ROOM.height) return null;
  const m = Math.min(margin, hw / 2);
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  return [clamp(x, ox - hw + m, ox + hw - m), clamp(y, m, ROOM.height - m), clamp(z, back + m, front - m)];
}

/** The street waste container: across the road from the rage room, a few seconds' walk. */
export const TRASH = { x: -2.0, z: 5.88, width: 1.8, depth: 1.05, height: 1.12, wall: 0.05, floorY: 0.16 } as const;

/** Delivery bench in front of the Tool Shop window: bought tools wait here to be picked up. */
export const TOOL_BENCH = { x: 11.9, z: -5.85, width: 2.6, depth: 0.62, height: 0.82 } as const;

/** Sidewalk area in front of the Object Store where bought objects are left (door kept clear). */
export const OBJECT_DROP = { x0: -15.3, x1: -10.6, z0: -5.55, z1: -3.9, overflowZ: -2.1 } as const;

/** Where a lost object is put back: room centre, or the drop area on the street. */
export const RECOVERY = {
  room: [ROOM.origin[0], 0.05, ROOM.origin[2]] as [number, number, number],
  street: [-12.9, 0.05, -4.9] as [number, number, number],
};

/** True when a world point is inside the street block the player can walk (not in the room). */
export function isOnStreet(x: number, z: number): boolean {
  return Math.abs(x) < STREET.halfLength && z > STREET.northFacadeZ && z < STREET.southFacadeZ;
}
