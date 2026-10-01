import {
  BufferAttribute,
  type BufferGeometry,
  Box3,
  type Material,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { getModel, TEXTURES } from "../data/catalog";

/** One material's worth of triangles of a model, in model space (pivot at bottom centre). */
export type ModelPart = { geometry: BufferGeometry; material: MeshStandardMaterial; name: string };
export type LoadedModel = { id: string; parts: ModelPart[]; size: Vector3 };

type Progress = (loaded: number, total: number) => void;

/** Linear albedo fraction added as ambient on architecture (matches the IBL the props receive). */
const SURFACE_AMBIENT = 0.32;

/** Loads and caches game models and tiling texture sets; tracks progress for the loading screen. */
export class Assets {
  private gltf = new GLTFLoader();
  private textures = new TextureLoader();
  private models = new Map<string, Promise<LoadedModel>>();
  private textureSets = new Map<string, MeshLambertMaterial>();
  private total = 0;
  private loaded = 0;
  private progressListener: Progress | null = null;

  constructor(private readonly anisotropy: number) {}

  onProgress(listener: Progress | null): void {
    this.progressListener = listener;
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.total++;
    this.progressListener?.(this.loaded, this.total);
    return promise.finally(() => {
      this.loaded++;
      this.progressListener?.(this.loaded, this.total);
    });
  }

  model(id: string): Promise<LoadedModel> {
    let promise = this.models.get(id);
    if (!promise) {
      promise = this.track(this.loadModel(id));
      this.models.set(id, promise);
      // A failed load must not poison the cache forever.
      promise.catch(() => this.models.delete(id));
    }
    return promise;
  }

  private async loadModel(id: string): Promise<LoadedModel> {
    const entry = getModel(id);
    const gltf = await this.gltf.loadAsync(`${import.meta.env.BASE_URL}${entry.file}`);
    gltf.scene.updateMatrixWorld(true);
    const parts: ModelPart[] = [];
    gltf.scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const geometry = (node.geometry as BufferGeometry).clone();
      geometry.applyMatrix4(node.matrixWorld);
      normalizeAttributes(geometry);
      const material = toStandard(node.material as Material);
      for (const tex of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap]) {
        if (tex) tex.anisotropy = this.anisotropy;
      }
      parts.push({ geometry, material, name: material.name });
    });
    if (parts.length === 0) throw new Error(`Model "${id}" has no meshes`);
    const box = new Box3();
    for (const part of parts) {
      part.geometry.computeBoundingBox();
      if (part.geometry.boundingBox) box.union(part.geometry.boundingBox);
    }
    return { id, parts, size: box.getSize(new Vector3()) };
  }

  /**
   * Tiling material for architecture (walls, floors, street). Geometry using it must carry
   * world-space UVs in metres divided by `tileSize` (see architecture.ts).
   *
   * These surfaces are rough (concrete, brick, rubber) and cover most of the screen, so they use
   * Lambert shading plus an albedo-weighted ambient term standing in for image-based lighting:
   * measured ~40% cheaper per pixel than full PBR and visually indistinguishable on rough surfaces.
   */
  surface(id: string): MeshLambertMaterial {
    const cached = this.textureSets.get(id);
    if (cached) return cached;
    const entry = TEXTURES[id];
    if (!entry) throw new Error(`Unknown texture set "${id}"`);
    const base = `${import.meta.env.BASE_URL}${entry.base}`;
    const load = (suffix: string, srgb: boolean): Texture => {
      const tex = this.textures.load(`${base}_${suffix}.webp`, undefined, undefined, () => {
        // A missing texture falls back to the material's flat colour; the game stays playable.
        console.warn(`sTressT: texture ${base}_${suffix}.webp failed to load`);
      });
      tex.wrapS = tex.wrapT = RepeatWrapping;
      tex.anisotropy = this.anisotropy;
      if (srgb) tex.colorSpace = SRGBColorSpace;
      return tex;
    };
    const map = load("diff", true);
    const material = new MeshLambertMaterial({
      name: id,
      map,
      normalMap: load("nor", false),
      aoMap: load("arm", false),
      emissiveMap: map,
    });
    material.emissive.setScalar(SURFACE_AMBIENT);
    this.textureSets.set(id, material);
    return material;
  }
}

/** Every model part carries exactly position/normal/uv so fragments can share batched buffers. */
function normalizeAttributes(geometry: BufferGeometry): void {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") geometry.deleteAttribute(name);
  }
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  if (!geometry.getAttribute("uv")) {
    const count = geometry.getAttribute("position").count;
    geometry.setAttribute("uv", new BufferAttribute(new Float32Array(count * 2), 2));
  }
}

function toStandard(material: Material): MeshStandardMaterial {
  if (material instanceof MeshStandardMaterial) return material;
  const standard = new MeshStandardMaterial({ name: material.name });
  material.dispose();
  return standard;
}
