import type { PerspectiveCamera } from "three";

const MAX_OFFSET = 0.014;
const MAX_ROLL = 0.012;
const MAX_PITCH = 0.018;
const DECAY = 3.2;

/**
 * Trauma-based camera shake: impulses add trauma (capped at 1), the visible shake is trauma²,
 * so small hits barely register and nothing can ever disorient the player.
 */
export class CameraShake {
  private trauma = 0;
  private time = 0;
  /** 0..1, from settings (0 disables). */
  scale = 1;

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  apply(camera: PerspectiveCamera, dt: number): void {
    if (this.trauma <= 0) return;
    this.time += dt;
    this.trauma = Math.max(0, this.trauma - DECAY * dt);
    const s = this.trauma * this.trauma * this.scale;
    const t = this.time * 38;
    camera.position.x += Math.sin(t * 1.3) * MAX_OFFSET * s;
    camera.position.y += Math.sin(t * 1.7 + 1.1) * MAX_OFFSET * s;
    camera.rotation.x += Math.sin(t * 1.1 + 2.3) * MAX_PITCH * s;
    camera.rotation.z += Math.sin(t * 0.9 + 0.7) * MAX_ROLL * s;
  }
}
