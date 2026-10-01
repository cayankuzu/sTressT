import RAPIER, { type Collider, type World } from "@dimforge/rapier3d";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Scene } from "three";
import { GROUPS } from "../config/gameConfig";
import type { Assets } from "../core/assets";
import { StaticBuilder } from "./architecture";
import { ROOM, ROOM_DOOR, STREET } from "./layout";
import { PropPlacer } from "./props";
import { wallWithOpenings } from "./street";

const DOOR_SPEED = 3.2;
const SHUTTER_OPEN_Y = ROOM_DOOR.height - 0.05;

/** The roller shutter between the street and the room: physically blocks the doorway when down. */
export class RoomDoor {
  private y = SHUTTER_OPEN_Y;
  private target = SHUTTER_OPEN_Y;
  private readonly lamp: MeshBasicMaterial;

  constructor(
    private readonly shutter: Group,
    private readonly collider: Collider,
    lamp: MeshBasicMaterial,
  ) {
    this.lamp = lamp;
    this.apply();
  }

  get locked(): boolean {
    return this.target === 0;
  }

  /** True while the shutter is travelling. */
  get moving(): boolean {
    return this.y !== this.target;
  }

  setLocked(locked: boolean): void {
    this.target = locked ? 0 : SHUTTER_OPEN_Y;
    // The doorway is blocked as soon as the lock engages, so nobody slips out mid-animation.
    this.collider.setEnabled(locked);
    this.lamp.color.setHex(locked ? 0xff3b2f : 0x3bd46a);
  }

  update(dt: number): void {
    if (this.y === this.target) return;
    const step = DOOR_SPEED * dt;
    this.y = this.y < this.target ? Math.min(this.target, this.y + step) : Math.max(this.target, this.y - step);
    this.apply();
  }

  private apply(): void {
    this.shutter.position.y = this.y;
    this.shutter.updateMatrixWorld(true);
  }
}

export type RageRoomShell = { door: RoomDoor };

export async function buildRageRoom(scene: Scene, world: World, assets: Assets): Promise<RageRoomShell> {
  const builder = new StaticBuilder(scene, world);
  const props = new PropPlacer(scene, world, assets);
  const [ox, , oz] = ROOM.origin;
  const hw = ROOM.width / 2;
  const hd = ROOM.depth / 2;
  const h = ROOM.height;
  const t = ROOM.wall;
  const front = STREET.northFacadeZ - STREET.facadeThickness / 2;
  const back = oz - hd;

  const floor = assets.surface("rubber_floor");
  const wall = assets.surface("room_wall");
  const ceiling = assets.surface("room_ceiling");

  // Floor runs under the doorway so the threshold is continuous with the sidewalk.
  builder.box(floor, [ROOM.width, 0.3, front - back + STREET.facadeThickness / 2], [ox, -0.15, (front + STREET.facadeThickness / 2 + back) / 2], { tile: 1 });
  builder.box(ceiling, [ROOM.width + 2 * t, 0.3, ROOM.depth + t], [ox, h + 0.15, oz], { tile: 2 });
  builder.box(wall, [t, h, ROOM.depth], [ox - hw - t / 2, h / 2, oz], { tile: 2 });
  builder.box(wall, [t, h, ROOM.depth], [ox + hw + t / 2, h / 2, oz], { tile: 2 });
  builder.box(wall, [ROOM.width + 2 * t, h, t], [ox, h / 2, back - t / 2], { tile: 2 });
  // Inner layer of the front wall (the outer layer is the sTressT facade).
  const door = { x0: ROOM_DOOR.x - ROOM_DOOR.width / 2, x1: ROOM_DOOR.x + ROOM_DOOR.width / 2, y0: 0, y1: ROOM_DOOR.height };
  wallWithOpenings(builder, wall, ox - hw, ox + hw, front - STREET.facadeThickness / 2, front, h, [door], 2);
  // Invisible backing behind the walls and above the ceiling: a shard flung at 7 m/s moves 12 cm
  // per step and could pass a thin wall between two steps. A metre of solid makes that impossible
  // (cheaper and steadier than continuous collision on every piece).
  // Everything stays behind the front wall's inner face, so nothing reaches the sidewalk.
  const BACKING = 1;
  const inner = front - STREET.facadeThickness / 2;
  const z0 = back - t - BACKING;
  const depth = inner - z0;
  const zc = (inner + z0) / 2;
  builder.blocker([BACKING, h + 2 * BACKING, depth], [ox - hw - t - BACKING / 2, h / 2, zc]);
  builder.blocker([BACKING, h + 2 * BACKING, depth], [ox + hw + t + BACKING / 2, h / 2, zc]);
  builder.blocker([ROOM.width + 2 * (t + BACKING), h + 2 * BACKING, BACKING], [ox, h / 2, back - t - BACKING / 2]);
  builder.blocker([ROOM.width + 2 * (t + BACKING), BACKING, depth], [ox, h + 0.3 + BACKING / 2, zc]);
  builder.blocker([ROOM.width + 2 * (t + BACKING), BACKING, depth], [ox, -0.3 - BACKING / 2, zc]);

  // Rubber safety mats on the lower walls: this is a space built to be wrecked.
  const mat = new MeshStandardMaterial({ color: 0x3d434b, roughness: 0.9, metalness: 0 });
  for (const z of [-2.2, -0.7, 0.8, 2.2]) {
    builder.box(mat, [0.05, 1.5, 1.3], [ox - hw + 0.025, 0.95, oz + z], { collider: false });
    builder.box(mat, [0.05, 1.5, 1.3], [ox + hw - 0.025, 0.95, oz + z], { collider: false });
  }
  for (const x of [-2.9, -1.45, 0, 1.45, 2.9]) builder.box(mat, [1.3, 1.5, 0.05], [ox + x, 0.95, back + 0.025], { collider: false });
  // Hazard stripe along the base of the walls.
  const stripe = new MeshStandardMaterial({ color: 0xd8a524, roughness: 0.7 });
  builder.box(stripe, [ROOM.width, 0.08, 0.02], [ox, 0.12, back + 0.06], { collider: false });
  builder.box(stripe, [0.02, 0.08, ROOM.depth], [ox - hw + 0.06, 0.12, oz], { collider: false });
  builder.box(stripe, [0.02, 0.08, ROOM.depth], [ox + hw - 0.06, 0.12, oz], { collider: false });
  builder.flush();

  // Ceiling fluorescent fixtures; their tubes glow without any real light cost.
  const lights = await assets.model("fluorescent_lights");
  for (const part of lights.parts) {
    if (/glass/i.test(part.name)) {
      part.material.emissive.setHex(0xf4f6ff);
      part.material.emissiveIntensity = 2.2;
      part.material.transparent = false;
      part.material.opacity = 1;
    }
  }
  for (const [x, z] of [
    [-2, -1.9],
    [0, -1.9],
    [2, -1.9],
    [-2, 1.1],
    [0, 1.1],
    [2, 1.1],
  ] as const) {
    props.place("fluorescent_lights", [ox + x, h - 0.04, oz + z], 90, { collider: false });
  }
  await props.build(false);

  // Roller shutter door on the room side of the doorway.
  const shutterModel = await assets.model("shutter_door");
  const shutter = new Group();
  for (const part of shutterModel.parts) {
    const mesh = new Mesh(part.geometry, part.material);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    shutter.add(mesh);
  }
  const doorZ = front - STREET.facadeThickness / 2 - shutterModel.size.z / 2 - 0.01;
  shutter.position.set(ox + ROOM_DOOR.x, 0, doorZ);
  shutter.scale.x = (ROOM_DOOR.width + 0.1) / shutterModel.size.x;
  scene.add(shutter);
  const doorBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(ox + ROOM_DOOR.x, ROOM_DOOR.height / 2, front));
  const doorCollider = world.createCollider(
    RAPIER.ColliderDesc.cuboid(ROOM_DOOR.width / 2, ROOM_DOOR.height / 2, STREET.facadeThickness / 2).setCollisionGroups(GROUPS.world),
    doorBody,
  );
  doorCollider.setEnabled(false);

  const lampMaterial = new MeshBasicMaterial({ color: 0x3bd46a, toneMapped: false });
  const lamp = new Mesh(new BoxGeometry(0.16, 0.08, 0.04), lampMaterial);
  lamp.position.set(ox + ROOM_DOOR.x, ROOM_DOOR.height + 0.18, front - STREET.facadeThickness / 2 - 0.03);
  lamp.updateMatrix();
  lamp.matrixAutoUpdate = false;
  scene.add(lamp);
  const outsideLamp = lamp.clone();
  outsideLamp.position.z = STREET.northFacadeZ + 0.03;
  outsideLamp.updateMatrix();
  scene.add(outsideLamp);

  return { door: new RoomDoor(shutter, doorCollider, lampMaterial) };
}
