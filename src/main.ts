import "./style.css";
import { detectQuality, QUALITY } from "./config/quality";
import { Assets } from "./core/assets";
import { Input } from "./core/input";
import { initPhysics, type Physics } from "./engine/physics";
import { createRenderer } from "./engine/renderer";
import { Game } from "./game/Game";
import { ProfileStore } from "./save/profiles";
import { SaveManager } from "./save/SaveManager";
import { openSlotStore } from "./save/storage";
import { setLanguage, t } from "./ui/i18n";
import { UI } from "./ui/ui";

function requireElement<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`sTressT: missing element ${selector}`);
  return el;
}

async function boot(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>("#game");
  const profiles = new ProfileStore();
  setLanguage(profiles.settings.language);
  const ui = new UI(requireElement<HTMLElement>("#ui"));
  const loading = ui.loading();
  const savedQuality = profiles.settings.quality;
  const quality = savedQuality === "auto" ? detectQuality() : QUALITY[savedQuality];
  // Keyboard + mouse game: any device with a mouse or trackpad (desktop, or a tablet/phone with one connected).
  const noMouse = !matchMedia("(any-pointer: fine)").matches;

  let renderer;
  try {
    renderer = createRenderer(canvas, quality);
  } catch (err) {
    console.error(err);
    ui.fatal(t("app.noWebgl"));
    return;
  }

  let physics: Physics;
  try {
    physics = await initPhysics();
  } catch (err) {
    console.error(err);
    ui.fatal(t("app.noPhysics"));
    return;
  }

  const saves = new SaveManager(await openSlotStore(), profiles);
  const assets = new Assets(quality.anisotropy);
  assets.onProgress((loaded, total) => loading.setProgress(loaded, total));
  const input = new Input(canvas);
  const game = new Game({ renderer, physics, assets, quality, input, ui, profiles, saves, noMouse });
  try {
    await game.init();
  } catch (err) {
    console.error(err);
    loading.setError(t("app.assetsFailed"));
    return;
  }
  assets.onProgress(null);
  game.start();
}

boot().catch((err: unknown) => {
  console.error(err);
  const root = document.querySelector<HTMLElement>("#ui");
  if (root) root.textContent = "sTressT failed to start. See the console for details.";
});
