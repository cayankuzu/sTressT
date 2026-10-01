import { Color, DirectionalLight, HemisphereLight, Object3D, type Scene, Vector3 } from "three";
import type { QualitySettings } from "../config/quality";
import { ROOM } from "./layout";

type Location = "street" | "room";

type Rig = { position: Vector3; target: Vector3; intensity: number; color: Color; extent: number; far: number; hemi: number; ground: Color };

const [ox, , oz] = ROOM.origin;
const RIGS: Record<Location, Rig> = {
  street: {
    position: new Vector3(-9, 16, 11),
    target: new Vector3(0, 0, -1),
    intensity: 2.6,
    color: new Color(0xfff0d8),
    extent: 20,
    far: 45,
    hemi: 1.1,
    ground: new Color(0x5a524a),
  },
  room: {
    position: new Vector3(ox + 1.2, 9, oz + 2.4),
    target: new Vector3(ox, 0, oz),
    intensity: 2.9,
    color: new Color(0xf6f8ff),
    extent: 5.2,
    far: 14,
    // Indoors the hemisphere "ground" colour stands in for light bouncing off the floor.
    hemi: 1.35,
    ground: new Color(0x9a958c),
  },
};

/**
 * One shadow-casting key light plus a hemisphere fill. Walking through the door moves the key
 * from "low sun over the street" to "overhead fluorescent key" (reads like the eye adapting),
 * so every pixel pays for exactly one directional light and one shadow map.
 */
export class Lighting {
  readonly key: DirectionalLight;
  readonly hemi: HemisphereLight;
  private location: Location = "street";
  private blend = 0;

  constructor(scene: Scene, quality: QualitySettings) {
    this.hemi = new HemisphereLight(0xdde6f2, RIGS.street.ground, RIGS.street.hemi);
    scene.add(this.hemi);
    this.key = new DirectionalLight(0xffffff, 1);
    this.key.target = new Object3D();
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    scene.add(this.key, this.key.target);
    this.applyShadowCamera(RIGS.street);
    this.apply();
  }

  /** Shadow sharpness from the quality tier (the map is rebuilt on the next shadow pass). */
  setShadowMapSize(size: number): void {
    if (this.key.shadow.mapSize.x === size) return;
    this.key.shadow.mapSize.set(size, size);
    this.key.shadow.map?.dispose();
    this.key.shadow.map = null;
  }

  private applyShadowCamera(rig: Rig): void {
    const cam = this.key.shadow.camera;
    cam.left = -rig.extent;
    cam.right = rig.extent;
    cam.top = rig.extent;
    cam.bottom = -rig.extent;
    cam.near = 0.5;
    cam.far = rig.far;
    cam.updateProjectionMatrix();
  }

  /** Returns true when the shadow setup changed (the shadow map must be redrawn). */
  setLocation(location: Location): boolean {
    if (location === this.location) return false;
    this.location = location;
    this.applyShadowCamera(RIGS[location]);
    return true;
  }

  /** Returns true while the light is still transitioning (shadows need refreshing). */
  update(dt: number): boolean {
    const target = this.location === "room" ? 1 : 0;
    if (this.blend === target) return false;
    const step = dt * 2.5;
    this.blend = this.blend < target ? Math.min(target, this.blend + step) : Math.max(target, this.blend - step);
    this.apply();
    return true;
  }

  private apply(): void {
    const b = this.blend;
    const s = RIGS.street;
    const r = RIGS.room;
    this.key.position.lerpVectors(s.position, r.position, b);
    this.key.target.position.lerpVectors(s.target, r.target, b);
    this.key.target.updateMatrixWorld();
    this.key.intensity = s.intensity + (r.intensity - s.intensity) * b;
    this.key.color.lerpColors(s.color, r.color, b);
    this.hemi.intensity = s.hemi + (r.hemi - s.hemi) * b;
    this.hemi.groundColor.lerpColors(s.ground, r.ground, b);
  }
}
