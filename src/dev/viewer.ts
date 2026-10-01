// Dev-only contact sheet of every processed model: shows size, pivot and facing (+Z arrow).
// Open /viewer.html (optionally ?role=prop|tool|static or ?id=crt_tv). Not part of the production build.
import { ArrowHelper, Color, DirectionalLight, HemisphereLight, Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Assets } from "../core/assets";
import { MODELS } from "../data/catalog";
import { createEnvironment } from "../engine/renderer";

const params = new URLSearchParams(location.search);
const role = params.get("role");
const only = params.get("id");
const ids = Object.keys(MODELS).filter((id) => (!role || MODELS[id]?.role === role) && (!only || id === only));

const canvas = document.querySelector<HTMLCanvasElement>("#c")!;
const labels = document.querySelector<HTMLDivElement>("#labels")!;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new Scene();
scene.background = new Color(0x2a2b2f);
scene.environment = createEnvironment(renderer);
scene.environmentIntensity = 0.6;
scene.add(new HemisphereLight(0xffffff, 0x444444, 1));
const sun = new DirectionalLight(0xffffff, 1.5);
sun.position.set(3, 6, 4);
scene.add(sun);

const camera = new PerspectiveCamera(45, 1, 0.01, 200);
const controls = new OrbitControls(camera, canvas);
const assets = new Assets(4);

const cols = Math.ceil(Math.sqrt(ids.length));
const cell = only ? 0 : 2.2;
const anchors: { el: HTMLDivElement; pos: Vector3 }[] = [];

await Promise.all(
  ids.map(async (id, i) => {
    const model = await assets.model(id);
    const x = (i % cols) * cell;
    const z = Math.floor(i / cols) * cell;
    const fit = only ? 1 : Math.min(1, 1.6 / Math.max(model.size.x, model.size.y, model.size.z));
    for (const part of model.parts) {
      const mesh = new Mesh(part.geometry, part.material);
      mesh.position.set(x, 0, z);
      mesh.scale.setScalar(fit);
      scene.add(mesh);
    }
    scene.add(new ArrowHelper(new Vector3(0, 0, 1), new Vector3(x, 0.02, z), 0.6, 0x3fa9ff, 0.12, 0.06));
    const el = document.createElement("div");
    el.textContent = `${id}  ${model.size.toArray().map((v) => v.toFixed(2)).join("×")}${fit < 1 ? ` (×${fit.toFixed(2)})` : ""}`;
    labels.appendChild(el);
    anchors.push({ el, pos: new Vector3(x, -0.1, z + 0.9) });
  }),
);

const extent = only ? 1.5 : cols * cell;
controls.target.set(only ? 0 : extent / 2 - cell / 2, 0.3, only ? 0 : extent / 2 - cell / 2);
camera.position.set(controls.target.x, extent * 0.9, controls.target.z + extent * 0.75);

const v = new Vector3();
renderer.setAnimationLoop(() => {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  controls.update();
  renderer.render(scene, camera);
  for (const a of anchors) {
    v.copy(a.pos).project(camera);
    a.el.style.left = `${((v.x + 1) / 2) * w}px`;
    a.el.style.top = `${((1 - v.y) / 2) * h}px`;
  }
});
