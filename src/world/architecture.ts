import RAPIER, { type World } from "@dimforge/rapier3d";
import { BoxGeometry, BufferGeometry, Euler, type Material, Matrix4, Mesh, Quaternion, type Scene, Vector3 } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GROUPS } from "../config/gameConfig";

type BoxOptions = {
  rotationY?: number;
  /** Texture tile size in metres (UVs are world-scaled so all surfaces share one material). */
  tile?: number;
  collider?: boolean;
  castShadow?: boolean;
};

type Bucket = { material: Material; geometries: BufferGeometry[]; castShadow: boolean };

/**
 * Collects static boxes, bakes their transforms, and merges everything sharing a material into
 * one mesh: the whole street/room shell costs a handful of draw calls.
 */
export class StaticBuilder {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
  ) {}

  box(material: Material, size: [number, number, number], center: [number, number, number], options: BoxOptions = {}): void {
    const { rotationY = 0, tile = 1, collider = true, castShadow = false } = options;
    const [sx, sy, sz] = size;
    const geometry = new BoxGeometry(sx, sy, sz);
    scaleBoxUvs(geometry, sx, sy, sz, tile);
    const matrix = new Matrix4().compose(
      new Vector3(...center),
      new Quaternion().setFromEuler(new Euler(0, rotationY, 0)),
      new Vector3(1, 1, 1),
    );
    geometry.applyMatrix4(matrix);
    this.add(material, geometry, castShadow);

    if (collider) {
      const q = new Quaternion().setFromEuler(new Euler(0, rotationY, 0));
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(center[0], center[1], center[2]).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setFriction(0.8).setCollisionGroups(GROUPS.world),
        body,
      );
    }
  }

  /** Invisible collision-only box (street bounds, door blockers...). */
  blocker(size: [number, number, number], center: [number, number, number]): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...center));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2).setCollisionGroups(GROUPS.world), body);
  }

  add(material: Material, geometry: BufferGeometry, castShadow = false): void {
    const key = `${material.uuid}:${castShadow}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { material, geometries: [], castShadow };
      this.buckets.set(key, bucket);
    }
    bucket.geometries.push(geometry);
  }

  /** Merges all buckets into meshes and adds them to the scene. */
  flush(): Mesh[] {
    const meshes: Mesh[] = [];
    for (const bucket of this.buckets.values()) {
      const merged = mergeGeometries(bucket.geometries.map((g) => (g.index ? g.toNonIndexed() : g)));
      for (const g of bucket.geometries) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new Mesh(merged, bucket.material);
      mesh.receiveShadow = true;
      mesh.castShadow = bucket.castShadow;
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      meshes.push(mesh);
    }
    this.buckets.clear();
    return meshes;
  }
}

/** BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 vertices each). */
function scaleBoxUvs(geometry: BoxGeometry, sx: number, sy: number, sz: number, tile: number): void {
  const uv = geometry.getAttribute("uv");
  const faces: [number, number][] = [
    [sz, sy],
    [sz, sy],
    [sx, sz],
    [sx, sz],
    [sx, sy],
    [sx, sy],
  ];
  faces.forEach(([u, v], face) => {
    for (let i = 0; i < 4; i++) {
      const idx = face * 4 + i;
      uv.setXY(idx, (uv.getX(idx) * u) / tile, (uv.getY(idx) * v) / tile);
    }
  });
  uv.needsUpdate = true;
}
