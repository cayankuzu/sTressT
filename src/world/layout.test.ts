import { describe, expect, it } from "vitest";
import { confineToRoom, isInRoom, ROOM, ROOM_DOOR, STREET } from "./layout";

const [ox, , oz] = ROOM.origin;
const back = oz - ROOM.depth / 2;
const front = STREET.northFacadeZ - STREET.facadeThickness;

describe("room confinement", () => {
  it("leaves the room interior, the doorway and the whole street side alone", () => {
    expect(confineToRoom(ox, 0.3, oz, 0.05)).toBeNull();
    expect(confineToRoom(ox + ROOM.width / 2 - 0.01, ROOM.height - 0.1, back + 0.01, 0.05)).toBeNull();
    expect(confineToRoom(ROOM_DOOR.x, 0.5, front + 0.1, 0.05)).toBeNull();
    expect(confineToRoom(-9, 0.2, -2, 0.05)).toBeNull();
    expect(confineToRoom(12, 0.1, 5.8, 0.05)).toBeNull();
  });

  it("puts back anything behind the room's walls, under its floor, above its ceiling or inside a shop", () => {
    for (const p of [
      [ox, 0.03, back - 1.4],
      [ox - 7.23, 0.03, -19.3],
      [ox + ROOM.width / 2 + 0.6, 1, oz],
      [ox, ROOM.height + 0.5, oz],
      [ox, -2, oz],
      [-10, 1, -8],
    ] as const) {
      const fixed = confineToRoom(p[0], p[1], p[2], 0.05);
      expect(fixed, p.join()).not.toBeNull();
      const [x, y, z] = fixed!;
      expect(isInRoom(x, z), p.join()).toBe(true);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(ROOM.height);
      expect(confineToRoom(x, y, z, 0.05)).toBeNull();
    }
  });
});
