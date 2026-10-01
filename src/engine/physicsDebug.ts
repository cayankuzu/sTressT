import type { World } from "@dimforge/rapier3d";
import { Box3, Box3Helper, BufferAttribute, BufferGeometry, Color, Group, LineBasicMaterial, LineSegments, type Scene } from "three";

/**
 * Debug-only collision view (F2 with ?debug=1, always available in dev): every collider as Rapier
 * draws it (player capsule included), plus labelled volumes such as the disposal box. Costs
 * nothing while off; while on, the line buffer is rebuilt every frame.
 */
export class PhysicsDebugView {
  private readonly group = new Group();
  private readonly geometry = new BufferGeometry();
  private readonly lines: LineSegments;
  private capacity = 0;
  enabled = false;

  constructor(
    private readonly scene: Scene,
    private readonly world: World,
  ) {
    this.lines = new LineSegments(this.geometry, new LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.group.add(this.lines);
    this.group.name = "physics-debug";
  }

  /** A fixed volume drawn as a box (e.g. the container's disposal volume). */
  addVolume(box: Box3, color: number): void {
    const helper = new Box3Helper(new Box3().copy(box), new Color(color));
    (helper.material as LineBasicMaterial).depthTest = false;
    helper.renderOrder = 999;
    this.group.add(helper);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    if (this.enabled) this.scene.add(this.group);
    else this.scene.remove(this.group);
  }

  update(): void {
    if (!this.enabled) return;
    const { vertices, colors } = this.world.debugRender();
    const count = vertices.length / 3;
    if (count > this.capacity) {
      this.capacity = Math.ceil(count * 1.25);
      this.geometry.setAttribute("position", new BufferAttribute(new Float32Array(this.capacity * 3), 3));
      this.geometry.setAttribute("color", new BufferAttribute(new Float32Array(this.capacity * 4), 4));
    }
    const position = this.geometry.getAttribute("position") as BufferAttribute;
    const color = this.geometry.getAttribute("color") as BufferAttribute;
    (position.array as Float32Array).set(vertices);
    (color.array as Float32Array).set(colors);
    position.needsUpdate = true;
    color.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
  }
}
