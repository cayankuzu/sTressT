import type { World } from "@dimforge/rapier3d";
import type { WebGLRenderer } from "three";
import { h } from "./dom";

const REFRESH_SECONDS = 0.5;

export type DebugOverlay = { tick(frameSeconds: number, extra: string): void; toggle(): void };

/** FPS / draw-call / physics readout. Refreshes the DOM twice per second, never per frame. */
export function createDebugOverlay(parent: HTMLElement, renderer: WebGLRenderer, world: World, tier: string, visible: boolean): DebugOverlay {
  const el = h("pre", { class: "debug" });
  el.hidden = !visible;
  parent.append(el);
  let frames = 0;
  let elapsed = 0;
  let worst = 0;

  return {
    toggle() {
      el.hidden = !el.hidden;
    },
    tick(frameSeconds, extra) {
      frames++;
      elapsed += frameSeconds;
      worst = Math.max(worst, frameSeconds);
      if (elapsed < REFRESH_SECONDS || el.hidden) {
        if (elapsed >= REFRESH_SECONDS) {
          frames = 0;
          elapsed = 0;
          worst = 0;
        }
        return;
      }
      let awake = 0;
      world.bodies.forEach((body) => {
        if (body.isEnabled() && body.isDynamic() && !body.isSleeping()) awake++;
      });
      const { calls, triangles } = renderer.info.render;
      el.textContent =
        `FPS ${Math.round(frames / elapsed)} (worst ${(worst * 1000).toFixed(0)} ms)  ${tier} @ ${renderer.getPixelRatio().toFixed(2)}x\n` +
        `draws ${calls}  tris ${triangles}  bodies ${world.bodies.len()} (${awake} awake)` +
        (extra ? `\n${extra}` : "");
      frames = 0;
      elapsed = 0;
      worst = 0;
    },
  };
}
