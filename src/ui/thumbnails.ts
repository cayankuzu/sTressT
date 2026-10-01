import {
  Box3,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  type Texture,
  Vector3,
  type WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import type { Assets } from "../core/assets";

const SIZE = 160;

/**
 * Renders a 3/4 product shot of any model once, into a small 2D canvas that the shop reuses.
 * Generation is queued and done one model per frame, so opening the shop never hitches.
 */
export class Thumbnails {
  private readonly target = new WebGLRenderTarget(SIZE, SIZE, { samples: 0 });
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.01, 50);
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly waiting = new Map<string, ((c: HTMLCanvasElement) => void)[]>();
  private readonly queue: string[] = [];
  private readonly pixels = new Uint8Array(SIZE * SIZE * 4);
  private busy = false;

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly assets: Assets,
    environment: Texture | null,
  ) {
    this.target.texture.colorSpace = SRGBColorSpace;
    this.scene.environment = environment;
    this.scene.environmentIntensity = 0.7;
    this.scene.add(new HemisphereLight(0xffffff, 0x3a3632, 1.3));
    const key = new DirectionalLight(0xffffff, 2);
    key.position.set(2, 3, 2.5);
    this.scene.add(key);
  }

  /** Resolves with a canvas holding the model's picture (cached after the first request). */
  get(modelId: string): Promise<HTMLCanvasElement> {
    const cached = this.cache.get(modelId);
    if (cached) return Promise.resolve(cached);
    return new Promise((resolve) => {
      const list = this.waiting.get(modelId);
      if (list) list.push(resolve);
      else {
        this.waiting.set(modelId, [resolve]);
        this.queue.push(modelId);
      }
    });
  }

  /** Call once per frame; renders at most one pending thumbnail. */
  async pump(): Promise<void> {
    if (this.busy || this.queue.length === 0) return;
    this.busy = true;
    const id = this.queue.shift() as string;
    try {
      const canvas = await this.render(id);
      this.cache.set(id, canvas);
      for (const resolve of this.waiting.get(id) ?? []) resolve(canvas);
    } catch (err) {
      console.warn(`sTressT: thumbnail for ${id} failed`, err);
    } finally {
      this.waiting.delete(id);
      this.busy = false;
    }
  }

  private async render(modelId: string): Promise<HTMLCanvasElement> {
    const model = await this.assets.model(modelId);
    const meshes = model.parts.map((p) => new Mesh(p.geometry, p.material));
    this.scene.add(...meshes);
    const box = new Box3();
    for (const m of meshes) box.expandByObject(m);
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    const dist = radius / Math.sin((this.camera.fov * Math.PI) / 360) * 1.05;
    this.camera.position.set(center.x + dist * 0.62, center.y + dist * 0.42, center.z + dist * 0.66);
    this.camera.lookAt(center);

    const previous = this.renderer.getRenderTarget();
    const clearAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(this.target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(this.target, 0, 0, SIZE, SIZE, this.pixels);
    this.renderer.setRenderTarget(previous);
    this.renderer.setClearColor(0x000000, clearAlpha);
    this.scene.remove(...meshes);

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const image = ctx.createImageData(SIZE, SIZE);
      // WebGL rows start at the bottom; flip while copying.
      for (let y = 0; y < SIZE; y++) image.data.set(this.pixels.subarray((SIZE - 1 - y) * SIZE * 4, (SIZE - y) * SIZE * 4), y * SIZE * 4);
      ctx.putImageData(image, 0, 0);
    }
    return canvas;
  }

  dispose(): void {
    this.target.dispose();
  }
}
