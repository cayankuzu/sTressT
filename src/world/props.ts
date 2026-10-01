import RAPIER, { type World } from "@dimforge/rapier3d";
import { Euler, InstancedMesh, Matrix4, Quaternion, type Scene, Vector3 } from "three";
import { GROUPS } from "../config/gameConfig";
import type { Assets } from "../core/assets";

type PropPlacement = {
  position: [number, number, number];
  rotationY: number;
  scale: number;
  collider: boolean;
};

/**
 * Static decorative props. Every placement of the same model becomes one InstancedMesh per
 * material, so six street lamps still cost a single draw call.
 */
export class PropPlacer {
  private placements = new Map<string, PropPlacement[]>();

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
    private readonly assets: Assets,
  ) {}

  place(modelId: string, position: [number, number, number], rotationYDeg = 0, options: { scale?: number; collider?: boolean } = {}): void {
    let list = this.placements.get(modelId);
    if (!list) {
      list = [];
      this.placements.set(modelId, list);
    }
    list.push({ position, rotationY: (rotationYDeg * Math.PI) / 180, scale: options.scale ?? 1, collider: options.collider ?? true });
  }

  async build(castShadow = true): Promise<void> {
    const matrix = new Matrix4();
    const quat = new Quaternion();
    const pos = new Vector3();
    const scale = new Vector3();
    await Promise.all(
      [...this.placements].map(async ([modelId, list]) => {
        const model = await this.assets.model(modelId);
        for (const part of model.parts) {
          const mesh = new InstancedMesh(part.geometry, part.material, list.length);
          list.forEach((p, i) => {
            quat.setFromEuler(new Euler(0, p.rotationY, 0));
            matrix.compose(pos.set(...p.position), quat, scale.setScalar(p.scale));
            mesh.setMatrixAt(i, matrix);
          });
          mesh.castShadow = castShadow;
          mesh.receiveShadow = true;
          mesh.matrixAutoUpdate = false;
          mesh.computeBoundingSphere();
          this.scene.add(mesh);
        }
        for (const p of list) {
          if (!p.collider) continue;
          const half = model.size.clone().multiplyScalar(p.scale / 2);
          quat.setFromEuler(new Euler(0, p.rotationY, 0));
          const body = this.world.createRigidBody(
            RAPIER.RigidBodyDesc.fixed()
              .setTranslation(p.position[0], p.position[1] + half.y, p.position[2])
              .setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }),
          );
          this.world.createCollider(RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z).setCollisionGroups(GROUPS.world), body);
        }
      }),
    );
    this.placements.clear();
  }
}
