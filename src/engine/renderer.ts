import {
  NeutralToneMapping,
  PCFShadowMap,
  PMREMGenerator,
  type PerspectiveCamera,
  type Scene,
  type Texture,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { QualitySettings } from "../config/quality";

/** Throws when WebGL is unavailable; the caller shows a fallback message. */
export function createRenderer(canvas: HTMLCanvasElement, quality: QualitySettings): WebGLRenderer {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: quality.antialias,
    alpha: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  // Shadows are re-rendered only when something moves (see ShadowScheduler).
  renderer.shadowMap.autoUpdate = false;
  return renderer;
}

/** Image-based lighting from a procedural room: realistic reflections with zero downloads. */
export function createEnvironment(renderer: WebGLRenderer): Texture {
  const pmrem = new PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return env;
}

export function fitToWindow(renderer: WebGLRenderer, camera: PerspectiveCamera): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  // `false`: keep the CSS size at 100% and only resize the drawing buffer.
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

/**
 * Dynamic resolution: when frames get slow the render buffer shrinks a little (invisible at
 * 60 fps), and grows back once there is headroom. Gameplay never changes.
 */
export class ResolutionGovernor {
  private sampleTime = 0;
  private samples = 0;
  private goodSeconds = 0;
  private ratio: number;
  /** Average frame time measured right before the last downscale (to verify it helped). */
  private beforeDownscale = 0;
  /** Seconds during which the governor holds still (the slowness was not GPU-bound). */
  private hold = 0;

  constructor(
    private readonly renderer: WebGLRenderer,
    private quality: QualitySettings,
    private readonly onChange: () => void,
  ) {
    this.ratio = renderer.getPixelRatio();
  }

  /** A new quality tier from Settings: the resolution moves into its range at once. */
  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.beforeDownscale = 0;
    this.hold = 0;
    this.goodSeconds = 0;
    // Start from the tier's best resolution; the governor lowers it again if frames suffer.
    this.set(Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio));
  }

  get pixelRatio(): number {
    return this.ratio;
  }

  tick(frameSeconds: number): void {
    this.sampleTime += frameSeconds;
    this.samples++;
    if (this.sampleTime < 1) return;
    const avg = this.sampleTime / this.samples;
    this.sampleTime = 0;
    this.samples = 0;

    const max = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    if (this.hold > 0) {
      this.hold--;
      return;
    }
    // The last downscale didn't speed anything up: the browser is throttling frames (background
    // pane, power saver) or we are CPU-bound. Restore the resolution and stop fiddling for a while.
    if (this.beforeDownscale > 0) {
      const helped = avg < this.beforeDownscale * 0.93;
      if (!helped) {
        this.set(Math.min(max, this.ratio + 0.1));
        this.hold = 15;
      }
      this.beforeDownscale = 0;
      if (!helped) return;
    }
    if (avg > 1 / 50 && this.ratio > this.quality.minPixelRatio) {
      this.beforeDownscale = avg;
      this.set(Math.max(this.quality.minPixelRatio, this.ratio - 0.1));
      this.goodSeconds = 0;
    } else if (avg < 1 / 58) {
      this.goodSeconds++;
      if (this.goodSeconds >= 3 && this.ratio < max) {
        this.set(Math.min(max, this.ratio + 0.05));
        this.goodSeconds = 0;
      }
    } else {
      this.goodSeconds = 0;
    }
  }

  private set(ratio: number): void {
    this.ratio = Math.round(ratio * 100) / 100;
    this.renderer.setPixelRatio(this.ratio);
    this.onChange();
  }
}

/** Re-renders the shadow map only while something in the scene is moving. */
export class ShadowScheduler {
  private dirtyFrames = 2;

  constructor(private readonly renderer: WebGLRenderer) {}

  /** Request shadow refresh for the next few frames (movement, spawn, reset...). */
  invalidate(frames = 2): void {
    this.dirtyFrames = Math.max(this.dirtyFrames, frames);
  }

  beforeRender(_scene: Scene): void {
    if (this.dirtyFrames > 0) {
      this.renderer.shadowMap.needsUpdate = true;
      this.dirtyFrames--;
    }
  }
}
