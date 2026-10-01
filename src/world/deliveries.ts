import RAPIER, { type Collider, type World } from "@dimforge/rapier3d";
import { Box3, Group, Mesh, Quaternion, type Scene, Vector3 } from "three";
import { GROUPS } from "../config/gameConfig";
import type { Assets } from "../core/assets";
import { getTool } from "../data/catalog";
import type { ToolDelivery } from "../economy/state";
import { StaticBuilder } from "./architecture";
import { TOOL_BENCH } from "./layout";

const SLOTS = 6;

type Shown = { delivery: ToolDelivery; group: Group; collider: Collider };

/**
 * The delivery bench in front of the Tool Shop. A bought tool lies here, physically, until the
 * player walks up and takes it (E); only then is it owned. Each tool has its own small collider
 * so the crosshair can point at exactly that tool.
 */
export class ToolBench {
  private shown: Shown[] = [];
  private byHandle = new Map<number, Shown>();
  private token = 0;

  private constructor(
    private readonly scene: Scene,
    private readonly world: World,
    private readonly assets: Assets,
  ) {}

  static async build(scene: Scene, world: World, assets: Assets): Promise<ToolBench> {
    const builder = new StaticBuilder(scene, world);
    const top = assets.surface("metal_plate");
    const frame = assets.surface("alley_wall");
    const { x, z, width: w, depth: d, height: h } = TOOL_BENCH;
    builder.box(top, [w, 0.05, d], [x, h - 0.025, z], { tile: 1, castShadow: true });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) builder.box(frame, [0.06, h - 0.05, 0.06], [x + sx * (w / 2 - 0.06), (h - 0.05) / 2, z + sz * (d / 2 - 0.06)], { collider: false, castShadow: true });
    }
    builder.box(frame, [w - 0.1, 0.04, d - 0.1], [x, 0.2, z], { collider: false });
    // The legs collide as one block: debris and the player stop at the bench, never under it.
    builder.blocker([w, h - 0.05, d], [x, (h - 0.05) / 2, z]);
    builder.flush();
    return new ToolBench(scene, world, assets);
  }

  /** Shows exactly these deliveries on the bench (called whenever they change). */
  async show(deliveries: ToolDelivery[]): Promise<void> {
    const token = ++this.token;
    const wanted = new Set(deliveries.map((d) => d.id));
    for (const s of this.shown.slice()) if (!wanted.has(s.delivery.id)) this.removeShown(s);
    const { x, z, width: w, height: h } = TOOL_BENCH;
    for (const [i, delivery] of deliveries.slice(0, SLOTS).entries()) {
      if (this.shown.some((s) => s.delivery.id === delivery.id)) continue;
      const tool = getTool(delivery.toolId);
      const model = await this.assets.model(tool.model);
      if (token !== this.token) return;
      const group = new Group();
      const inner = new Group();
      for (const part of model.parts) {
        const mesh = new Mesh(part.geometry, part.material);
        mesh.castShadow = true;
        inner.add(mesh);
      }
      // Lay the tool flat along the bench: its long axis (handle to head) points along +X.
      const long = new Vector3(...(tool.viewmodel.long ?? [0, 1, 0])).normalize();
      inner.quaternion.copy(new Quaternion().setFromUnitVectors(long, new Vector3(1, 0, 0)));
      inner.scale.setScalar(tool.viewmodel.scale);
      group.add(inner);
      // Centre it on its slot, resting on the bench top.
      inner.updateMatrixWorld(true);
      const box = new Box3().setFromObject(inner);
      const length = box.max.x - box.min.x;
      inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
      const slotX = x - w / 2 + (w / SLOTS) * (i + 0.5);
      group.position.set(slotX, h, z);
      group.rotation.y = 0.12 * (i % 2 === 0 ? 1 : -1);
      this.scene.add(group);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(slotX, h + 0.06, z));
      const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(Math.max(0.12, length / 2), 0.05, 0.1).setCollisionGroups(GROUPS.world), body);
      const shown = { delivery, group, collider };
      this.shown.push(shown);
      this.byHandle.set(collider.handle, shown);
    }
  }

  /** The delivery whose tool the crosshair ray hit, if any. */
  deliveryAt(colliderHandle: number): ToolDelivery | null {
    const s = this.byHandle.get(colliderHandle);
    return s && s.collider.handle === colliderHandle ? s.delivery : null;
  }

  private removeShown(s: Shown): void {
    this.scene.remove(s.group);
    this.byHandle.delete(s.collider.handle);
    const body = s.collider.parent();
    if (body) this.world.removeRigidBody(body);
    this.shown = this.shown.filter((x) => x !== s);
  }

  clear(): void {
    this.token++;
    for (const s of this.shown.slice()) this.removeShown(s);
  }
}
