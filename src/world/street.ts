import type { World } from "@dimforge/rapier3d";
import { BackSide, type Material, Mesh, MeshStandardMaterial, type Object3D, PlaneGeometry, type Scene, ShaderMaterial, SphereGeometry } from "three";
import type { Assets } from "../core/assets";
import { StaticBuilder } from "./architecture";
import { ROOM_DOOR, SHOPS, STREET } from "./layout";
import { PropPlacer } from "./props";
import { createSign } from "./signs";
import { t as text } from "../ui/i18n";

export type ShopId = keyof typeof SHOPS;

/** Interaction spots the player can walk up to on the street (shop doors). */
export type StreetSpot = { id: ShopId; position: [number, number, number] };

const FACADE_HEIGHT = { objects: 4.6, rage: 5.2, tools: 4.6 } as const;

type Opening = { x0: number; x1: number; y0: number; y1: number };

/** Builds a wall along X with rectangular openings (doors, windows). */
export function wallWithOpenings(
  builder: StaticBuilder,
  material: Material,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  height: number,
  openings: Opening[],
  tile: number,
): void {
  const zc = (z0 + z1) / 2;
  const depth = Math.abs(z1 - z0);
  const sorted = [...openings].sort((a, b) => a.x0 - b.x0);
  let cursor = x0;
  for (const o of sorted) {
    if (o.x0 > cursor) builder.box(material, [o.x0 - cursor, height, depth], [(cursor + o.x0) / 2, height / 2, zc], { tile });
    const w = o.x1 - o.x0;
    const cx = (o.x0 + o.x1) / 2;
    if (o.y0 > 0) builder.box(material, [w, o.y0, depth], [cx, o.y0 / 2, zc], { tile });
    if (o.y1 < height) builder.box(material, [w, height - o.y1, depth], [cx, (height + o.y1) / 2, zc], { tile });
    cursor = o.x1;
  }
  if (cursor < x1) builder.box(material, [x1 - cursor, height, depth], [(cursor + x1) / 2, height / 2, zc], { tile });
}

export async function buildStreet(scene: Scene, world: World, assets: Assets): Promise<StreetSpot[]> {
  const builder = new StaticBuilder(scene, world);
  const props = new PropPlacer(scene, world, assets);
  const L = STREET.halfLength;
  const zN = STREET.northFacadeZ;
  const zS = STREET.southFacadeZ;
  const t = STREET.facadeThickness;

  const asphalt = assets.surface("asphalt");
  const sidewalk = assets.surface("sidewalk");
  const alley = assets.surface("alley_wall");
  const metal = assets.surface("metal_plate");

  // Ground: road sits one kerb lower than the sidewalks.
  builder.box(asphalt, [2 * L, 0.3, 2 * STREET.roadHalfWidth], [0, -STREET.roadDepth - 0.15, 0], { tile: 5, collider: false });
  // The road collides at sidewalk height: a capsule cannot step a sharp kerb, and nobody notices 15 cm.
  builder.blocker([2 * L, 0.3, 2 * STREET.roadHalfWidth], [0, -0.15, 0]);
  const walkDepth = -zN - STREET.roadHalfWidth;
  builder.box(sidewalk, [2 * L, 0.3, walkDepth], [0, -0.15, -(STREET.roadHalfWidth + walkDepth / 2)], { tile: 2 });
  builder.box(sidewalk, [2 * L, 0.3, zS - STREET.roadHalfWidth], [0, -0.15, STREET.roadHalfWidth + (zS - STREET.roadHalfWidth) / 2], { tile: 2 });

  // North facades: object store, sTressT (rage room building), tool shop.
  const doorH = 2.4;
  const winY0 = 0.8;
  const winY1 = 2.7;
  for (const [id, shop] of Object.entries(SHOPS) as [ShopId, (typeof SHOPS)[ShopId]][]) {
    const material = assets.surface(id === "objects" ? "facade_objects" : "facade_tools");
    const openings: Opening[] = [
      { x0: shop.doorX - 0.6, x1: shop.doorX + 0.6, y0: 0, y1: doorH },
      { x0: shop.windowX0, x1: shop.windowX1, y0: winY0, y1: winY1 },
    ];
    wallWithOpenings(builder, material, shop.x0, shop.x1, zN - t, zN, FACADE_HEIGHT[id], openings, 2.5);
    buildRecess(builder, alley, shop.doorX - 0.6, shop.doorX + 0.6, 0, doorH, zN - t, 0.35);
    buildRecess(builder, alley, shop.windowX0, shop.windowX1, winY0, winY1, zN - t, 0.9);
    // Closed metal door; the shop opens as an overlay at the door.
    builder.box(metal, [1.2, doorH, 0.06], [shop.doorX, doorH / 2, zN - t - 0.3], { tile: 1.2 });
    addWindowGlass(scene, (shop.windowX0 + shop.windowX1) / 2, (winY0 + winY1) / 2, shop.windowX1 - shop.windowX0, winY1 - winY0, zN - 0.02);

    const sign = createSign(id === "objects" ? text("world.objects") : text("world.tools"), {
      width: 3.2,
      height: 0.62,
      background: id === "objects" ? "#1d2b35" : "#2b1d18",
      color: "#f2ede4",
      accent: "#e0b03a",
    });
    placeFlat(scene, sign, shop.doorX, 3.25, zN + 0.02);
  }

  // sTressT building: the facade is also the rage room's front wall.
  const rageFacade = assets.surface("facade_rage");
  const rx0 = SHOPS.objects.x1;
  const rx1 = SHOPS.tools.x0;
  const door: Opening = { x0: ROOM_DOOR.x - ROOM_DOOR.width / 2, x1: ROOM_DOOR.x + ROOM_DOOR.width / 2, y0: 0, y1: ROOM_DOOR.height };
  wallWithOpenings(builder, rageFacade, rx0, rx1, zN - t / 2, zN, FACADE_HEIGHT.rage, [door], 2.5);
  const logo = createSign("s[T]ress[T]", { width: 3.6, height: 0.9, background: "#121315", color: "#f2ede4", accent: "#e0b03a" });
  placeFlat(scene, logo, 0, 3.4, zN + 0.02);
  const tagline = createSign(text("world.rage"), { width: 1.6, height: 0.3, background: "#121315", color: "#bdb7ab" });
  placeFlat(scene, tagline, 0, 2.72, zN + 0.02);

  // South: a continuous alley wall closes the street; ends are capped by walls.
  builder.box(alley, [2 * L, 7, t], [0, 3.5, zS + t / 2], { tile: 3 });
  builder.box(alley, [t, 5, zS - zN + 2 * t], [-L - t / 2, 2.5, (zS + zN) / 2], { tile: 3 });
  builder.box(alley, [t, 5, zS - zN + 2 * t], [L + t / 2, 2.5, (zS + zN) / 2], { tile: 3 });
  // Side walls between the facades and the end caps (keeps the street visually closed).
  builder.box(alley, [L - SHOPS.tools.x1, 5, t], [(L + SHOPS.tools.x1) / 2, 2.5, zN - t / 2], { tile: 3 });
  builder.box(alley, [L - SHOPS.tools.x1, 5, t], [-(L + SHOPS.tools.x1) / 2, 2.5, zN - t / 2], { tile: 3 });
  // Tall invisible blockers stop the player from climbing out over low props.
  builder.blocker([2 * L, 10, 0.2], [0, 5, zS + 0.1]);

  // Street furniture (static, instanced per model).
  for (const x of [-13.5, -4.2, 4.2, 13.5]) props.place("street_lamp", [x, 2.3, zN + 0.41], 0, { collider: false });
  for (const x of [-9, 0, 9]) props.place("street_lamp", [x, 2.5, zS - 0.41], 180, { collider: false });
  props.place("covered_car", [5.5, -STREET.roadDepth, 2.3], 90);
  props.place("trash_can", [-5, 0, zS - 0.35], 180);
  props.place("trash_can", [15.5, 0, zN + 0.35], 10);
  props.place("fire_hydrant", [4.9, 0, -4.1], 0);
  props.place("utility_box", [12.5, 0, zS - 0.25], 180);
  props.place("manhole", [-3, -STREET.roadDepth, 0.6], 0, { collider: false });
  props.place("manhole", [11, -STREET.roadDepth, -1.2], 30, { collider: false });
  for (const z of [-2.2, 0, 2.2]) {
    props.place("road_barrier", [-L + 1.2, -STREET.roadDepth, z], 90);
    props.place("road_barrier", [L - 1.2, -STREET.roadDepth, z], 90);
  }
  props.place("shutter_window", [-7, 0, zS - 0.16], 180, { collider: false });
  props.place("shutter_window", [9.5, 0, zS - 0.16], 180, { collider: false });
  props.place("shutter_door", [-13.5, 0, zS - 0.16], 180, { collider: false });
  props.place("aircon_unit", [-11, 2.6, zS - 0.2], 180, { collider: false });
  props.place("aircon_unit", [2.5, 2.9, zS - 0.2], 180, { collider: false });
  props.place("aircon_unit", [14, 2.5, zS - 0.2], 180, { collider: false });

  // Shop windows show the goods.
  const toolWindowZ = zN - t - 0.55;
  const toolX = (SHOPS.tools.windowX0 + SHOPS.tools.windowX1) / 2;
  props.place("baseball_bat", [toolX - 1.3, 0.85, toolWindowZ], 90, { collider: false });
  props.place("sledgehammer", [toolX - 0.4, 0.85, toolWindowZ], 90, { collider: false });
  props.place("crowbar", [toolX + 0.5, 0.85, toolWindowZ], 90, { collider: false });
  props.place("hammer", [toolX + 1.2, 0.85, toolWindowZ], 0, { collider: false });
  props.place("pipe_wrench", [toolX + 1.7, 0.85, toolWindowZ], 0, { collider: false });
  const objX = (SHOPS.objects.windowX0 + SHOPS.objects.windowX1) / 2;
  const objZ = zN - t - 0.5;
  props.place("crt_tv", [objX - 1.3, 0.8, objZ], 20, { collider: false });
  props.place("ceramic_vase_03", [objX - 0.2, 0.8, objZ], 0, { collider: false });
  props.place("garden_gnome", [objX + 0.5, 0.8, objZ], -15, { collider: false });
  props.place("antique_vase", [objX + 1.3, 0.8, objZ], 0, { collider: false });

  builder.flush();
  await props.build();
  scene.add(createSky());

  return [
    { id: "objects", position: [SHOPS.objects.doorX, 0, zN + 0.6] },
    { id: "tools", position: [SHOPS.tools.doorX, 0, zN + 0.6] },
  ];
}

/** A shallow box behind an opening so doors and windows look into a space, not the void. */
function buildRecess(builder: StaticBuilder, material: Material, x0: number, x1: number, y0: number, y1: number, zFront: number, depth: number): void {
  const w = x1 - x0;
  const h = y1 - y0;
  const cx = (x0 + x1) / 2;
  const back = zFront - depth;
  builder.box(material, [w + 0.2, h + 0.2, 0.1], [cx, (y0 + y1) / 2, back - 0.05], { tile: 2, collider: y0 === 0 });
  builder.box(material, [w, 0.1, depth], [cx, y0 - 0.05, zFront - depth / 2], { tile: 2, collider: false });
  builder.box(material, [w, 0.1, depth], [cx, y1 + 0.05, zFront - depth / 2], { tile: 2, collider: false });
  builder.box(material, [0.1, h, depth], [x0 - 0.05, (y0 + y1) / 2, zFront - depth / 2], { tile: 2, collider: false });
  builder.box(material, [0.1, h, depth], [x1 + 0.05, (y0 + y1) / 2, zFront - depth / 2], { tile: 2, collider: false });
}

function addWindowGlass(scene: Scene, x: number, y: number, w: number, h: number, z: number): void {
  const glass = new Mesh(
    new PlaneGeometry(w, h),
    new MeshStandardMaterial({ color: 0x9fb4c0, transparent: true, opacity: 0.18, roughness: 0.05, metalness: 0.2, depthWrite: false }),
  );
  placeFlat(scene, glass, x, y, z);
}

function placeFlat(scene: Scene, object: Object3D, x: number, y: number, z: number): void {
  object.position.set(x, y, z);
  object.updateMatrix();
  object.matrixAutoUpdate = false;
  scene.add(object);
}

/** Gradient sky dome: one draw call, no textures. */
function createSky(): Mesh {
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    uniforms: {},
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 horizon = vec3(0.86, 0.78, 0.68);
        vec3 zenith = vec3(0.36, 0.52, 0.72);
        gl_FragColor = vec4(mix(horizon, zenith, pow(h, 0.6)), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new Mesh(new SphereGeometry(90, 16, 8), material);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

