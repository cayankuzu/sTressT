import RAPIER from "@dimforge/rapier3d";
import { AudioManager } from "../audio/AudioManager";
import { Box3, Color, Euler, MathUtils, PerspectiveCamera, Quaternion, Scene, Vector3, type WebGLRenderer } from "three";
import { COLLISION, GAME, groups } from "../config/gameConfig";
import { detectQuality, QUALITY, type QualitySettings } from "../config/quality";
import type { Assets } from "../core/assets";
import { EventBus } from "../core/events";
import type { Action, Input } from "../core/input";
import { getObject, getTool, MATERIALS, OBJECTS, TOOL_IDS } from "../data/catalog";
import type { MaterialType, ObjectDefinition } from "../data/types";
import type { Destructible } from "../destruction/Destructible";
import type { Fragment } from "../destruction/Debris";
import { DestructionSystem, type StageEvent } from "../destruction/DestructionSystem";
import { cheapestObjectPrice } from "../economy/economy";
import type { Physics } from "../engine/physics";
import { PhysicsDebugView } from "../engine/physicsDebug";
import { createEnvironment, fitToWindow, ResolutionGovernor, ShadowScheduler } from "../engine/renderer";
import { Particles } from "../fx/Particles";
import { ArrangeMode, doorClearance } from "../player/ArrangeMode";
import { CameraShake } from "../player/CameraShake";
import { GrabSystem, type GrabTarget } from "../player/GrabSystem";
import { KickSystem } from "../player/KickSystem";
import { PlayerController } from "../player/PlayerController";
import { ToolSystem } from "../player/ToolSystem";
import { Viewmodel } from "../player/Viewmodel";
import { MAX_PROFILES, type ProfileStore, randomId } from "../save/profiles";
import type { SaveManager } from "../save/SaveManager";
import { type Mode, newSave, type SaveData, SCHEMA_VERSION, migrateLegacy } from "../save/schema";
import type { Settings } from "../save/settings";
import { type Payout, Session } from "../session/Session";
import { createDebugOverlay, type DebugOverlay } from "../ui/debugOverlay";
import { Hud, type ModeBarItem } from "../ui/hud";
import { formatCredits, formatDate, formatDuration, objectName, setLanguage, t, type TextKey, toolName } from "../ui/i18n";
import { storageView } from "../ui/inventory";
import { type ShopKind, ShopView } from "../ui/shop";
import { Thumbnails } from "../ui/thumbnails";
import type { UI } from "../ui/ui";
import { ToolBench } from "../world/deliveries";
import { isInRoom, OBJECT_DROP, RECOVERY, ROOM, ROOM_DOOR, ROOM_ENTRY, SPAWN, STREET } from "../world/layout";
import { Lighting } from "../world/lighting";
import { buildRageRoom, type RageRoomShell } from "../world/rageRoom";
import { buildStreet, type StreetSpot } from "../world/street";
import { buildTrashContainer, type TrashContainer } from "../world/trash";
import { Progress } from "./Progress";

/** title: main menu over the street. playing: in control. menu/paused: an overlay freezes the world. */
type GameState = "title" | "playing" | "paused" | "menu";

const MAX_FRAME_SECONDS = 0.1;
/** A big object breaking slows time for a heartbeat (real seconds / time scale). */
const SLOW_MO_SECONDS = 0.14;
const SLOW_MO_SCALE = 0.3;
const SLOW_MO_MIN_VALUE = 200;
const UP = new Vector3(0, 1, 0);
const METAL_TOOLS = new Set(["hammer", "pipe_wrench", "crowbar", "sledgehammer", "frying_pan"]);
const MODES: Mode[] = ["arrange", "break", "cleanup"];
const MODE_BAR_SECONDS = 4;
const TARGET_REACH = 3.2;
const SPRINT_FOV = 5;
const AIM_FILTER = groups(0xffff, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS | COLLISION.DEBRIS_SMALL);

/** Dust colour per material: the lightened interior colour. */
const DUST: Record<MaterialType, Color> = Object.fromEntries(
  Object.entries(MATERIALS).map(([m, def]) => [m, new Color(def.interiorColor).lerp(new Color(0xd8d4cc), 0.45)]),
) as Record<MaterialType, Color>;

/** Seconds between picking up the last tool and the demo-complete screen. */
const DEMO_END_DELAY = 1.5;
const DROP_BOX = new Box3();
const OBJECT_BOX = new Box3();

export type GameContext = {
  renderer: WebGLRenderer;
  physics: Physics;
  assets: Assets;
  quality: QualitySettings;
  input: Input;
  ui: UI;
  profiles: ProfileStore;
  saves: SaveManager;
  /** No mouse/trackpad detected (touch-only device): the menu says so. */
  noMouse: boolean;
};

type ActiveSave = { saveId: string; profileId: string; slot: number; name: string; createdAt: number };

/** Top-level orchestrator: owns the scene, the state machine and the frame loop. */
export class Game {
  readonly events = new EventBus();
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(GAME.player.fov, 1, 0.03, 120);
  private state: GameState = "title";
  private mode: Mode = "arrange";
  private player!: PlayerController;
  private lighting!: Lighting;
  private room!: RageRoomShell;
  private trash!: TrashContainer;
  private bench!: ToolBench;
  /** Bought objects still being built (async): they count as owned for the safety net. */
  private deliveriesInFlight = 0;
  /** Sidewalk spots taken by deliveries whose bodies do not exist yet. */
  private readonly dropReservations = new Set<Box3>();
  private spots: StreetSpot[] = [];
  private destruction!: DestructionSystem;
  private tools!: ToolSystem;
  private grab!: GrabSystem;
  private arrange!: ArrangeMode;
  private viewmodel!: Viewmodel;
  private thumbs!: Thumbnails;
  readonly progress: Progress;
  private session!: Session;
  private hud!: Hud;
  private debug!: DebugOverlay;
  /** Collider view (F2); only exists in dev builds or with ?debug=1. */
  private colliders: PhysicsDebugView | null = null;
  private governor!: ResolutionGovernor;
  private shadows!: ShadowScheduler;
  private shop: ShopView | null = null;
  /** Keeps thumbnail generation running while storage is open. */
  private shopThumbs = false;
  private readonly shake = new CameraShake();
  private particles!: Particles;
  private kick!: KickSystem;
  private slowMo = 0;
  readonly audio = new AudioManager();
  private stepDistance = 0;
  private readonly lastFeet = new Vector3();
  private doorWasLocked = false;
  private location: "street" | "room" = "street";
  private lastLook = { x: 0, y: 0 };
  private last = 0;
  private titleTime = 0;
  private active: ActiveSave | null = null;
  private playtime = 0;
  /** Seconds until the demo-complete screen opens (-1 = not pending). */
  private demoEndTimer = -1;
  private loading = false;
  private modeBar: { highlight: Mode; timer: number } | null = null;
  /** Clean-up progress since the last break session ended. */
  private cleanup = { disposed: 0, earned: 0, announced: false };
  private breakEndTimer = -1;
  private baseFov: number = GAME.player.fov;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly aimDir = new Vector3();

  constructor(private readonly ctx: GameContext) {
    this.progress = new Progress(this.events);
  }

  private get settings(): Settings {
    return this.ctx.profiles.settings;
  }

  // ================================================================ setup

  async init(): Promise<void> {
    const { renderer, physics, assets, quality, ui } = this.ctx;
    setLanguage(this.settings.language);
    this.scene.environment = createEnvironment(renderer);
    this.scene.environmentIntensity = 0.55;
    this.lighting = new Lighting(this.scene, quality);
    this.destruction = new DestructionSystem(this.scene, physics.world, assets, this.events);
    const [spots, room, trash, bench] = await Promise.all([
      buildStreet(this.scene, physics.world, assets),
      buildRageRoom(this.scene, physics.world, assets),
      buildTrashContainer(this.scene, physics.world, assets, t("world.trash")),
      ToolBench.build(this.scene, physics.world, assets),
    ]);
    this.spots = spots;
    this.room = room;
    this.trash = trash;
    this.bench = bench;
    this.destruction.disposalVolume = trash.volume;

    this.player = new PlayerController(physics.world, this.camera, this.ctx.input);
    this.player.teleport(SPAWN.position, SPAWN.yaw);
    this.player.onLand = (speed) => {
      if (this.state === "playing") this.audio.land(speed);
    };
    this.tools = new ToolSystem(physics.world, this.camera, this.destruction, this.events, this.player.collider);
    this.tools.canAttack = () => this.state === "playing" && this.mode === "break" && !this.grab.holding && !this.modeBar;
    this.tools.playerVelocity = () => this.player.worldVelocity;
    this.grab = new GrabSystem(physics.world, this.camera, this.destruction, this.player.collider);
    this.grab.gentle = () => this.mode !== "break";
    this.player.gentle = () => this.mode !== "break";
    this.grab.onGrab = (target) => this.onGrab(target);
    this.grab.onThrow = () => {
      this.progress.stat("objectsThrown");
      this.session.stats.objectsThrown++;
    };
    this.arrange = new ArrangeMode(this.scene, physics.world, this.camera, this.destruction, this.player.collider);
    this.arrange.roomHasSpace = () => this.objectsInRoom() < GAME.session.roomCapacity;
    this.arrange.onCommit = (obj, fromStorage) => {
      if (fromStorage) this.progress.unstore(obj.instanceId);
      this.saves.request();
    };
    this.arrange.onCancelStorage = (obj) => this.destruction.despawn(obj.instanceId);
    this.arrange.onStore = (obj) => this.storeObject(obj);
    this.tools.onHit = (report) => {
      if (report.hit) this.shake.add(this.tools.tool.shake * (report.level === "heavy" ? 0.55 : report.level === "medium" ? 0.4 : 0.25));
    };
    this.particles = new Particles(this.scene, quality.particleScale);
    this.kick = new KickSystem(physics.world, this.camera, this.destruction, this.player.collider);
    this.kick.canKick = () => this.state === "playing" && (this.mode === "break" || this.mode === "cleanup") && !this.grab.holding && this.tools.stage === "idle" && !this.modeBar;
    this.kick.onStart = () => this.audio.swing(GAME.kick.effectiveMass, GAME.kick.windup + GAME.kick.active);
    this.kick.onKick = (hit) => {
      if (hit) this.shake.add(0.32);
    };
    this.viewmodel = new Viewmodel(assets, this.scene.environment);
    this.thumbs = new Thumbnails(renderer, assets, this.scene.environment);

    this.hud = new Hud(ui.hudLayer);
    this.hud.setVisible(false);
    this.session = new Session({
      reward: (key, amount) => this.progress.reward(key, amount),
      payout: (p) => this.showPayout(p),
      stress: (value) => this.hud.setStress(this.mode === "break" ? value : null),
      combo: (count, multiplier) => this.hud.setCombo(count, multiplier),
      cleared: () => {
        this.audio.roomCleared();
        this.progress.stat("roomsCleared");
        this.events.emit("ROOM_COMPLETED", { bonus: 0 });
        // Let the last pieces fly for a moment, then the door opens for the clean-up.
        this.breakEndTimer = GAME.session.clearedPause;
      },
    });
    this.destruction.onStage = (e) => this.onStage(e);
    this.destruction.onFeedback = (f) => {
      const toolSound = f.source !== "tool" ? undefined : f.toolId ? getTool(f.toolId).sound : "impactPunch_heavy";
      this.audio.impact(f.material, f.energy, f.point, f.broke, toolSound);
      this.emitImpactParticles(f.material, f.energy, f.point, f.normal ?? UP, f.source, f.broke, f.toolId);
      // Big nearby collisions shake the camera a little too (a cabinet falling next to you).
      if (f.source === "collision" && f.energy > 60) {
        const d = f.point.distanceTo(this.camera.position);
        if (d < 4) this.shake.add(Math.min(0.35, f.energy / 900) * (1 - d / 4));
      }
    };
    this.destruction.onDebris = (majors) => {
      if (this.session.active) this.session.stats.debrisCreated += majors;
      if (majors > 0) this.updateModeHud();
    };
    this.destruction.onDisposed = (frag) => this.onDisposed(frag);
    this.destruction.onLost = () => this.updateModeHud();
    this.destruction.onObjectLost = (obj) => this.recoverObject(obj);
    this.destruction.onObjectGone = () => this.saves.request();
    this.events.on("ATTACK_STARTED", () => this.audio.swing(this.tools.tool.effectiveMass, this.tools.tool.windup + this.tools.tool.active));
    this.events.on("REWARD_GRANTED", ({ amount }) => this.audio.reward(amount >= 30));
    this.events.on("OBJECT_DESTROYED", ({ definitionId }) => {
      if ((OBJECTS[definitionId]?.value ?? 0) >= SLOW_MO_MIN_VALUE) this.slowMo = SLOW_MO_SECONDS;
    });
    this.events.on("LOCATION_CHANGED", ({ location }) => this.audio.setLocation(location));
    ui.root.addEventListener("click", (e) => {
      if ((e.target as HTMLElement | null)?.closest?.(".btn, .shop-row")) this.audio.uiClick();
    });
    this.events.on("CREDITS_CHANGED", ({ credits }) => {
      this.hud.setCredits(credits);
      this.shop?.update(this.progress.state, this.safetyAvailable());
    });
    this.progress.onChange = () => this.saves.request();

    const showDebug = import.meta.env.DEV || new URLSearchParams(location.search).has("debug");
    this.debug = createDebugOverlay(ui.hudLayer, renderer, physics.world, quality.tier, showDebug);
    if (showDebug) {
      this.colliders = new PhysicsDebugView(this.scene, physics.world);
      this.colliders.addVolume(trash.volume, 0x3dff7a);
      this.colliders.addVolume(doorClearance(), 0xffb02e);
    }
    this.shadows = new ShadowScheduler(renderer);
    this.governor = new ResolutionGovernor(renderer, quality, () => fitToWindow(renderer, this.camera));
    this.saves.onSaved = (ok, manual) => {
      if (manual) this.hud.showToast(ok ? t("toast.saved") : t("toast.saveFailed"), ok ? "good" : "warn", 2);
      else if (!ok) this.hud.showToast(t("toast.saveFailed"), "warn", 2.5);
    };
    this.applySettings();

    const fit = (): void => {
      fitToWindow(renderer, this.camera);
      this.particles.resize(window.innerHeight, this.camera.fov);
    };
    fit();
    window.addEventListener("resize", fit);
    document.addEventListener("fullscreenchange", fit);
    this.ctx.input.onLock((locked) => {
      if (!locked && this.state === "playing") this.pause();
    });
    // Another tab or window: stop the world instead of simulating (or swinging) unattended.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && this.autoPause) {
        this.pause();
        void this.saves.flush();
      }
    });
    window.addEventListener("pagehide", () => void this.saves.flush());
    renderer.domElement.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      renderer.setAnimationLoop(null);
      ui.fatal(t("app.contextLost"));
    });
    renderer.compile(this.scene, this.camera);
    this.particles.setCompileVisible(true);
    renderer.compile(this.scene, this.camera);
    this.particles.setCompileVisible(false);
  }

  private get saves(): SaveManager {
    return this.ctx.saves;
  }

  start(): void {
    this.last = performance.now();
    this.ctx.renderer.setAnimationLoop((now: number) => this.frame(now));
    if (import.meta.env.DEV) this.exposeDevHandle();
    void this.showMainMenu();
  }

  /** Resolution, shadow sharpness and dust change at once; anti-aliasing waits for the next load. */
  private applyQuality(quality: QualitySettings): void {
    this.governor.setQuality(quality);
    this.lighting.setShadowMapSize(quality.shadowMapSize);
    this.particles.setScale(quality.particleScale);
    this.shadows.invalidate(2);
  }

  private applySettings(): void {
    const s = this.settings;
    setLanguage(s.language);
    this.baseFov = s.fov;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.particles?.resize(window.innerHeight, s.fov);
    this.shake.scale = s.shake;
    if (this.player) this.player.headBobScale = s.headBob;
    this.audio.setVolumes(s.masterVolume, s.sfxVolume, s.musicVolume);
  }

  // ================================================================ menus

  private async showMainMenu(): Promise<void> {
    this.state = "title";
    this.shop = null;
    this.saves.provider = null;
    this.ctx.input.setUnlockedLook(false);
    this.ctx.input.unlock();
    this.hud.setVisible(false);
    const profile = this.ctx.profiles.active;
    if (!profile) {
      this.showProfiles(true);
      return;
    }
    const sums = await this.saves.summaries(profile.id);
    if (this.state !== "title") return;
    const target = this.continueSlot(sums, profile.lastSlot);
    const summary = target === null ? null : sums[target];
    this.ctx.ui.mainMenu(
      {
        profileName: profile.name,
        continueInfo: summary ? t("menu.continueInfo", { name: summary.name, when: formatDate(summary.updatedAt) }) : null,
        storageWarning: !this.saves.persistent,
        noMouse: this.ctx.noMouse,
      },
      {
        onContinue: () => target !== null && void this.loadSlot(target),
        onNewGame: () => void this.showSlots("new"),
        onSavedGames: () => void this.showSlots("saved"),
        onSettings: () => this.openSettings("title"),
        onProfiles: () => this.showProfiles(false),
      },
    );
  }

  /** The slot CONTINUE opens: the last one played if it still exists, else the most recent. */
  private continueSlot(sums: ({ updatedAt: number } | null)[], last: number | null): number | null {
    if (last !== null && sums[last]) return last;
    let best: number | null = null;
    sums.forEach((s, i) => {
      if (s && (best === null || s.updatedAt > (sums[best]?.updatedAt ?? 0))) best = i;
    });
    return best;
  }

  private showProfiles(welcome: boolean): void {
    this.state = "title";
    const store = this.ctx.profiles;
    this.ctx.ui.profiles(
      store.meta.profiles.map((p) => ({ id: p.id, name: p.name, active: p.id === store.meta.activeProfileId })),
      {
        select: (id) => {
          store.select(id);
          this.applySettings();
          void this.showMainMenu();
        },
        create: (name) => {
          const first = store.meta.profiles.length === 0;
          if (!store.create(name)) return;
          this.applySettings();
          if (first) void this.importLegacySave();
          void this.showMainMenu();
        },
        remove: (id) => {
          const p = store.meta.profiles.find((x) => x.id === id);
          if (!p) return;
          this.ctx.ui.confirm({
            title: t("profile.deleteTitle"),
            body: [t("profile.deleteBody", { name: p.name })],
            confirm: t("common.delete"),
            danger: true,
            onConfirm: () => {
              void (async () => {
                for (let slot = 0; slot < 3; slot++) await this.saves.remove(id, slot).catch(() => undefined);
                store.remove(id);
                this.showProfiles(store.meta.profiles.length === 0);
              })();
            },
            onCancel: () => this.showProfiles(welcome),
          });
        },
        back: welcome || !store.active ? null : () => void this.showMainMenu(),
      },
      { welcome, max: MAX_PROFILES },
    );
  }

  /** The very first profile inherits the old single save (pre-profile versions), if any. */
  private async importLegacySave(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem("stresst.save.v2") ?? localStorage.getItem("stresst.save");
    } catch {
      return;
    }
    const profile = this.ctx.profiles.active;
    if (!raw || !profile) return;
    try {
      const save = migrateLegacy(JSON.parse(raw), profile.id, 0, randomId("sav"), t("slots.defaultName", { n: 1 }));
      if (save && (await this.saves.write(save))) {
        localStorage.removeItem("stresst.save.v2");
        localStorage.removeItem("stresst.save");
        this.ctx.profiles.setLastSlot(0);
        void this.showMainMenu();
      }
    } catch (err) {
      console.warn("sTressT: old save could not be imported", err);
    }
  }

  private async showSlots(kind: "saved" | "new"): Promise<void> {
    const profile = this.ctx.profiles.active;
    if (!profile) return;
    const sums = await this.saves.summaries(profile.id);
    this.ctx.ui.slots(kind, sums, {
      load: (slot) => void this.loadSlot(slot),
      start: (slot) => {
        if (!sums[slot]) {
          void this.newGame(slot);
          return;
        }
        this.ctx.ui.confirm({
          title: t("slots.overwriteTitle", { n: slot + 1 }),
          body: [t("slots.overwriteBody")],
          confirm: t("slots.overwrite"),
          danger: true,
          onConfirm: () => void this.newGame(slot),
          onCancel: () => void this.showSlots(kind),
        });
      },
      remove: (slot) =>
        this.ctx.ui.confirm({
          title: t("slots.deleteTitle", { n: slot + 1 }),
          body: [t("slots.deleteBody")],
          confirm: t("common.delete"),
          danger: true,
          onConfirm: () => {
            void (async () => {
              await this.saves.remove(profile.id, slot).catch((err) => console.error(err));
              if (profile.lastSlot === slot) this.ctx.profiles.setLastSlot(null);
              void this.showSlots(kind);
            })();
          },
          onCancel: () => void this.showSlots(kind),
        }),
      back: () => void this.showMainMenu(),
    });
  }

  private async newGame(slot: number): Promise<void> {
    const profile = this.ctx.profiles.active;
    if (!profile || this.loading) return;
    const save = newSave(profile.id, slot, t("slots.defaultName", { n: slot + 1 }), randomId("sav"));
    await this.saves.write(save);
    await this.enterGame(save);
  }

  private async loadSlot(slot: number): Promise<void> {
    const profile = this.ctx.profiles.active;
    if (!profile || this.loading) return;
    const result = await this.saves.load(profile.id, slot);
    if (!result) {
      this.ctx.ui.confirm({ title: t("slots.loadFailed"), body: [], confirm: t("common.back"), onConfirm: () => void this.showSlots("saved"), onCancel: () => void this.showSlots("saved") });
      return;
    }
    await this.enterGame(result.save);
    if (result.recovered) this.hud.showToast(t("slots.recovered"), "warn", 4);
  }

  /** Tears the current world down and rebuilds the saved one, then hands control to the player. */
  private async enterGame(save: SaveData): Promise<void> {
    this.loading = true;
    this.ctx.ui.loading();
    try {
      this.saves.provider = null;
      this.grab.release();
      this.arrange.cancel();
      this.arrange.hide();
      this.closeModeBar();
      this.session.end();
      this.destruction.damageEnabled = false;
      this.destruction.clearWorld();
      this.bench.clear();
      this.progress.load(save.progress);
      this.hud.setCredits(save.progress.credits, true);
      await this.destruction.load(save.objects, save.debris);
      await this.bench.show(this.progress.state.toolDeliveries);
      this.active = { saveId: save.saveId, profileId: save.profileId, slot: save.slot, name: save.name, createdAt: save.createdAt };
      this.playtime = save.playtimeSeconds;
      this.ctx.profiles.setLastSlot(save.slot);
      this.mode = save.mode === "break" ? "cleanup" : save.mode;
      this.cleanup = { disposed: 0, earned: 0, announced: false };
      this.breakEndTimer = -1;
      this.room.door.setLocked(false);
      this.viewmodel.setLowered(true);
      await this.equip(this.progress.state.equippedToolId, false);
      this.player.teleport(SPAWN.position, SPAWN.yaw);
      this.ctx.physics.resetAccumulator();
      this.destruction.warmup(this.ctx.renderer, this.scene, this.camera);
      this.saves.reset();
      this.saves.provider = () => this.snapshot();
      this.events.emit("GAME_STARTED");
    } finally {
      this.loading = false;
    }
    await this.resume();
    this.updateModeHud();
    this.refreshToolHud();
    if (!this.progress.flag("tut_found")) {
      this.progress.setFlag("tut_found");
      this.hud.hint(t("tut.found"), 10);
    }
  }

  /** One complete, consistent snapshot of the running game (money and world from the same instant). */
  private snapshot(): SaveData | null {
    const active = this.active;
    if (!active) return null;
    const world = this.destruction.serialize();
    const live = new Set<string>([...world.objects.map((o) => o.id), ...world.debris.map((d) => d.id), ...this.progress.state.storage.map((s) => s.id), this.session.id]);
    this.progress.prune(live);
    const p = this.progress.state;
    return {
      schemaVersion: SCHEMA_VERSION,
      saveId: active.saveId,
      profileId: active.profileId,
      slot: active.slot,
      name: active.name,
      createdAt: active.createdAt,
      updatedAt: Date.now(),
      playtimeSeconds: this.playtime,
      mode: this.mode,
      progress: { ...p, statistics: { ...p.statistics }, counters: { ...p.counters } },
      objects: world.objects,
      debris: world.debris,
    };
  }

  private async play(): Promise<void> {
    this.audio.unlock();
    this.applySettings();
    await this.resume();
  }

  private async resume(): Promise<void> {
    this.audio.unlock();
    const locked = await this.ctx.input.lock();
    // A refused lock (Chrome refuses for about a second after Esc; embedded browsers may never
    // allow it) must not leave the player stuck or blind: play on with direct mouse look, and the
    // next click on the game captures the mouse.
    this.ctx.input.setUnlockedLook(!locked);
    if (!locked) this.hud.showToast(t("toast.captureMouse"), "info", 3);
    this.state = "playing";
    this.shop = null;
    this.shopThumbs = false;
    this.ctx.ui.setOverlay(null);
    this.hud.setVisible(true);
    this.ctx.physics.resetAccumulator();
    this.events.emit("GAME_RESUMED");
  }

  /** Opens an in-game overlay: the world freezes and the cursor is released. */
  private enterMenu(): void {
    this.state = "menu";
    this.ctx.input.releaseAll();
    this.ctx.input.setUnlockedLook(false);
    this.ctx.input.unlock();
    this.hud.setVisible(false);
    this.closeModeBar();
  }

  private showDemoComplete(): void {
    this.demoEndTimer = -1;
    const s = this.progress.state.statistics;
    this.enterMenu();
    this.saves.request(0);
    this.ctx.ui.demoComplete(
      [
        [t("demo.time"), formatDuration(this.playtime)],
        [t("demo.destroyed"), String(s.objectsDestroyed)],
        [t("demo.earned"), formatCredits(s.creditsEarned)],
        [t("demo.disposed"), String(s.debrisDisposed)],
        [t("demo.combo"), `×${s.highestCombo}`],
        [t("demo.thrown"), String(s.objectsThrown)],
      ],
      { onContinue: () => void this.resume(), onMainMenu: () => void this.quitToMenu() },
    );
  }

  private pause(): void {
    if (this.state !== "playing") return;
    // Pausing never leaves a half-done action behind.
    this.arrange.cancel();
    this.enterMenu();
    this.events.emit("GAME_PAUSED");
    this.showPauseMenu();
  }

  private showPauseMenu(): void {
    this.state = "paused";
    this.shop = null;
    this.ctx.ui.pause(
      { inBreak: this.mode === "break" },
      {
        onResume: () => void this.resume(),
        onSave: () => void this.saves.flush(true),
        onEndBreak: () => {
          this.setMode("cleanup");
          void this.resume();
        },
        onSettings: () => this.openSettings("pause"),
        onMainMenu: () => void this.quitToMenu(),
      },
    );
  }

  private async quitToMenu(): Promise<void> {
    this.grab.release();
    await this.saves.flush();
    this.active = null;
    await this.showMainMenu();
  }

  private openShop(kind: ShopKind): void {
    this.grab.release();
    this.arrange.cancel();
    this.enterMenu();
    this.shop = new ShopView(
      kind,
      this.progress.state,
      {
        buyTool: (id) => {
          const r = this.progress.buyTool(id);
          if (r.ok) {
            void this.bench.show(this.progress.state.toolDeliveries);
            if (!this.progress.flag("tut_tool")) {
              this.progress.setFlag("tut_tool");
              this.hud.hint(t("tut.tool"));
            }
          }
          this.shop?.update(this.progress.state, this.safetyAvailable());
          return r;
        },
        equipTool: (id) => {
          const r = this.progress.equipTool(id);
          if (r.ok) void this.equip(id);
          this.shop?.update(this.progress.state, this.safetyAvailable());
          return r;
        },
        buyObject: (id) => {
          const r = this.progress.buyObject(id);
          if (r.ok) {
            void this.deliverObject(r.objectId, id);
            if (!this.progress.flag("tut_object")) {
              this.progress.setFlag("tut_object");
              this.hud.hint(t("tut.object"));
            }
          }
          this.shop?.update(this.progress.state, this.safetyAvailable());
          return r;
        },
        safetyBox: () => {
          if (!this.safetyAvailable()) return;
          const r = this.progress.safetyObject();
          if (r.ok) void this.deliverObject(r.objectId, "cardboard_box");
          this.shop?.update(this.progress.state, this.safetyAvailable());
        },
        close: () => void this.resume(),
      },
      this.thumbs,
      this.safetyAvailable(),
    );
    this.events.emit("SHOP_OPENED", { shop: kind });
    this.ctx.ui.setOverlay(this.shop.el);
  }

  /** Never stuck: no credits for the cheapest item and nothing left anywhere to break. */
  private safetyAvailable(): boolean {
    if (this.progress.state.credits >= cheapestObjectPrice() || this.deliveriesInFlight > 0) return false;
    if (this.progress.state.storage.some((s) => OBJECTS[s.definitionId]?.capabilities.destructible)) return false;
    for (const obj of this.destruction.all()) if (obj.alive && obj.template.def.capabilities.destructible) return false;
    return true;
  }

  /** A bought object appears on the sidewalk in front of the Object Store, at a free spot. */
  private async deliverObject(objectId: string, definitionId: string): Promise<void> {
    this.deliveriesInFlight++;
    try {
      const template = await this.destruction.template(definitionId);
      const [sx, sy, sz] = template.size;
      const spot = this.findDropSpot(sx, sy, sz);
      const yaw = (Math.random() - 0.5) * 0.5;
      const reserved = new Box3().copy(DROP_BOX);
      this.dropReservations.add(reserved);
      try {
        await this.destruction.spawn({
          id: objectId,
          definitionId,
          origin: "purchased",
          position: spot,
          rotation: new Quaternion().setFromEuler(new Euler(0, yaw, 0)),
        });
      } finally {
        this.dropReservations.delete(reserved);
      }
    } finally {
      this.deliveriesInFlight--;
    }
    this.destruction.warmup(this.ctx.renderer, this.scene, this.camera);
    this.shop?.update(this.progress.state, this.safetyAvailable());
    this.saves.request(0.5);
  }

  private findDropSpot(sx: number, sy: number, sz: number): Vector3 {
    const world = this.ctx.physics.world;
    const shape = new RAPIER.Cuboid(sx / 2 + 0.04, sy / 2, sz / 2 + 0.04);
    const step = 0.55;
    // Sidewalk rows first, then the edge of the (car-free) road before anything gets piled.
    for (let z = OBJECT_DROP.z0 + sz / 2; z <= OBJECT_DROP.overflowZ - sz / 2 + 1e-3; z += step) {
      for (let x = OBJECT_DROP.x1 - sx / 2; x >= OBJECT_DROP.x0 + sx / 2 - 1e-3; x -= step) {
        let blocked = false;
        world.intersectionsWithShape(
          { x, y: sy / 2 + 0.03, z },
          { x: 0, y: 0, z: 0, w: 1 },
          shape,
          () => {
            blocked = true;
            return false;
          },
          RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
          groups(0xffff, COLLISION.WORLD | COLLISION.PROP | COLLISION.DEBRIS | COLLISION.PLAYER),
        );
        if (!blocked) {
          // The shop pauses physics, so objects bought in the same visit are not in the broad
          // phase yet: test against every object's mesh bounds as well.
          DROP_BOX.min.set(x - sx / 2 - 0.04, 0, z - sz / 2 - 0.04);
          DROP_BOX.max.set(x + sx / 2 + 0.04, sy, z + sz / 2 + 0.04);
          blocked = this.dropOverlaps();
        }
        if (!blocked) return new Vector3(x, 0.002, z);
      }
    }
    // Everything is taken: drop it on top of the pile (above anything already falling there).
    const cx = (OBJECT_DROP.x0 + OBJECT_DROP.x1) / 2;
    const cz = (OBJECT_DROP.z0 + OBJECT_DROP.z1) / 2;
    let y = 1.2;
    for (let i = 0; i < 12; i++, y += 0.6) {
      DROP_BOX.min.set(cx - sx / 2, y, cz - sz / 2);
      DROP_BOX.max.set(cx + sx / 2, y + sy, cz + sz / 2);
      if (!this.dropOverlaps()) break;
    }
    return new Vector3(cx, y, cz);
  }

  private dropOverlaps(): boolean {
    for (const obj of this.destruction.all()) if (OBJECT_BOX.setFromObject(obj.root).intersectsBox(DROP_BOX)) return true;
    for (const taken of this.dropReservations) if (taken.intersectsBox(DROP_BOX)) return true;
    return false;
  }

  private openSettings(from: "title" | "pause"): void {
    if (from === "pause") this.enterMenu();
    this.ctx.ui.settings(this.settings, {
      change: (patch) => {
        const language = this.settings.language;
        this.ctx.profiles.updateSettings(patch);
        this.applySettings();
        if (patch.quality) this.applyQuality(patch.quality === "auto" ? detectQuality() : QUALITY[patch.quality]);
        // Re-open in the new language right away.
        if (patch.language && patch.language !== language) this.openSettings(from === "pause" ? "pause" : "title");
      },
      fullscreen: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.().catch(() => undefined);
      },
      back: () => (from === "title" ? void this.showMainMenu() : this.showPauseMenu()),
    });
  }

  private openStorage(): void {
    this.enterMenu();
    this.shopThumbs = true;
    this.ctx.ui.setOverlay(
      storageView(this.progress.state.storage, this.objectsInRoom(), this.thumbs, {
        place: (id) => void this.placeFromStorage(id),
        close: () => void this.resume(),
      }),
    );
  }

  /** Spawns a stored object as a ghost in front of the player; it leaves storage only once placed. */
  private async placeFromStorage(id: string): Promise<void> {
    await this.resume();
    const item = this.progress.state.storage.find((s) => s.id === id);
    if (!item) return;
    this.camera.getWorldDirection(this.aimDir);
    const feet = this.player.feet;
    const [ox, , oz] = ROOM.origin;
    const x = MathUtils.clamp(feet.x + this.aimDir.x * 1.6, ox - ROOM.width / 2 + 0.6, ox + ROOM.width / 2 - 0.6);
    const z = MathUtils.clamp(feet.z + this.aimDir.z * 1.6, oz - ROOM.depth / 2 + 0.6, oz + ROOM.depth / 2 - 1.2);
    const obj = await this.destruction.spawn({ id: item.id, definitionId: item.definitionId, origin: item.origin, position: new Vector3(x, 0, z), rotation: new Quaternion() });
    this.arrange.begin(obj, true);
    this.destruction.warmup(this.ctx.renderer, this.scene, this.camera);
  }

  private storeObject(obj: Destructible): void {
    if (!obj.pristine) {
      this.hud.showToast(t("toast.cantStore"), "warn");
      return;
    }
    const r = this.progress.store(obj.instanceId, obj.definitionId, obj.origin);
    if (!r.ok) return;
    this.destruction.despawn(obj.instanceId);
    this.hud.showToast(t("toast.stored", { name: objectName(obj.definitionId) }), "good");
  }

  // ================================================================ modes

  /** Why `target` cannot be entered right now (null = it can). */
  private modeBlock(target: Mode): string | null {
    if (target === this.mode) return t("mode.blocked.same");
    if (target === "arrange" && this.mode === "break") return t("mode.blocked.fromBreak");
    if (target === "break") {
      if (this.location !== "room") return t("mode.blocked.outside");
      const front = STREET.northFacadeZ - STREET.facadeThickness;
      if (this.player.feet.z > front - 0.45 && Math.abs(this.player.feet.x - (ROOM.origin[0] + ROOM_DOOR.x)) < ROOM_DOOR.width) return t("mode.blocked.doorway");
      // Pieces too heavy to carry can only be made smaller here, so they count as breakable.
      if (!this.breakablesInRoom().length && !this.heavyPieces().length) return t("mode.blocked.empty");
    }
    return null;
  }

  private setMode(next: Mode): void {
    if (next === this.mode) return;
    const prev = this.mode;
    this.mode = next;
    this.arrange.cancel();
    this.arrange.hide();
    this.grab.release();
    this.breakEndTimer = -1;
    if (prev === "break") this.endBreak();
    if (next === "break") this.beginBreak();
    this.viewmodel.setLowered(next !== "break");
    this.room.door.setLocked(next === "break");
    this.events.emit("MODE_CHANGED", { mode: next });
    if (next === "arrange") this.hud.showToast(t("toast.arrange"), "info", 1.6);
    if (next === "cleanup" && prev !== "break") this.hud.showToast(t("toast.cleanup"), "info", 1.6);
    this.updateModeHud();
    this.refreshToolHud();
    this.saves.request(0.5);
  }

  private beginBreak(): void {
    const sessionId = this.progress.beginSession();
    this.session.begin(sessionId, this.breakablesInRoom().map((o) => o.template.def));
    this.destruction.damageEnabled = true;
    this.hud.showToast(t("toast.breakStart"), "warn", 1.8);
    if (!this.progress.flag("tut_break")) {
      this.progress.setFlag("tut_break");
      this.hud.hint(t("tut.break"), 7);
    }
  }

  private endBreak(): void {
    const stats = this.session.stats;
    this.session.end();
    this.destruction.damageEnabled = false;
    this.hud.setStress(null);
    // Clutter clears itself; the pieces worth carrying stay where they fell.
    this.destruction.debris.fadeClutter(GAME.debris.minorFadeSeconds);
    this.cleanup = { disposed: 0, earned: 0, announced: false };
    this.progress.stat("highestCombo", stats.highestCombo, "max");
    const pieces = this.remainingMajors().length;
    this.hud.summary(t("summary.break"), t("summary.breakLine", { objects: stats.objectsDestroyed, pieces, credits: formatCredits(stats.creditsEarned) }), 5);
    if (pieces > 0 && !this.progress.flag("tut_cleanup_done")) this.hud.hint(t("tut.cleanup"), 12);
  }

  private breakablesInRoom(): Destructible[] {
    const list: Destructible[] = [];
    for (const obj of this.destruction.all()) if (obj.alive && obj.template.def.capabilities.destructible && isInRoom(obj.currPos.x, obj.currPos.z)) list.push(obj);
    return list;
  }

  private objectsInRoom(): number {
    let n = 0;
    for (const obj of this.destruction.all()) if (obj.alive && !obj.transient && isInRoom(obj.currPos.x, obj.currPos.z)) n++;
    return n;
  }

  /** Collectible pieces still to be thrown away (heavy ones included: they must be broken smaller). */
  private remainingMajors(): Fragment[] {
    return this.destruction.debris.majors();
  }

  private heavyPieces(): Fragment[] {
    return this.destruction.debris.majors().filter((f) => f.mass > GAME.interaction.maxGrabMass);
  }

  private openModeBar(): void {
    const order = MODES;
    const next = order[(order.indexOf(this.mode) + 1) % order.length] as Mode;
    this.modeBar = { highlight: next, timer: MODE_BAR_SECONDS };
    this.renderModeBar();
  }

  private closeModeBar(): void {
    this.modeBar = null;
    this.hud?.hideModeBar();
  }

  private renderModeBar(): void {
    if (!this.modeBar) return;
    const items: ModeBarItem[] = MODES.map((id) => {
      const block = this.modeBlock(id);
      return { id, enabled: block === null, reason: id === this.mode ? null : block };
    });
    this.hud.showModeBar(items, this.mode, this.modeBar.highlight);
  }

  private chooseMode(target: Mode): void {
    const block = this.modeBlock(target);
    this.closeModeBar();
    if (target === this.mode) return;
    if (block) {
      this.hud.showToast(block, "warn", 1.8);
      return;
    }
    this.setMode(target);
  }

  /** TAB selector input. Returns true while the bar is open (it owns the inputs). */
  private handleModeBar(dt: number): boolean {
    const { input } = this.ctx;
    if (!this.modeBar) {
      if (input.pressed("mode") && !this.arrange.busy) this.openModeBar();
      return this.modeBar !== null;
    }
    const bar = this.modeBar;
    bar.timer -= dt;
    if (input.pressed("mode")) {
      bar.highlight = MODES[(MODES.indexOf(bar.highlight) + 1) % MODES.length] as Mode;
      bar.timer = MODE_BAR_SECONDS;
      this.renderModeBar();
    }
    for (let i = 0; i < MODES.length; i++) {
      if (input.pressed(`slot${i + 1}` as Action)) {
        this.chooseMode(MODES[i] as Mode);
        return true;
      }
    }
    if (input.pressed("interact") || input.pressed("attack")) {
      this.chooseMode(bar.highlight);
      return true;
    }
    if (input.pressed("kick") || bar.timer <= 0) this.closeModeBar();
    return true;
  }

  private updateModeHud(): void {
    if (!this.hud) return;
    if (this.state === "title") {
      this.hud.setMode(null);
      return;
    }
    if (this.mode === "break") this.hud.setMode("break", t("hud.doorLocked"), "danger");
    else if (this.mode === "cleanup") {
      const left = this.remainingMajors().length;
      const total = left + this.cleanup.disposed;
      this.hud.setMode("cleanup", total > 0 ? t("hud.cleanupCount", { done: this.cleanup.disposed, total }) : "", left === 0 && total > 0 ? "good" : "");
    } else this.hud.setMode("arrange", "");
    this.hud.setStress(this.mode === "break" ? this.session.stress : null);
  }

  private onStage(e: StageEvent): void {
    if (e.stage === "intact") return;
    if (e.stage === "destroyed") this.progress.stat("objectsDestroyed");
    else if (e.stage === "damaged") this.progress.stat("objectsDamaged");
    this.session.onStage(e.obj.instanceId, e.obj.template.def, e.stage, {
      oneHit: e.oneHit,
      generation: e.impact.generation,
      point: e.impact.point,
      toolName: e.impact.toolId ? toolName(e.impact.toolId) : undefined,
    });
    if (e.stage !== "damaged") this.saves.request();
  }

  private onDisposed(frag: Fragment): void {
    const amount = frag.cleanupValue > 0 ? Math.max(1, Math.round(frag.cleanupValue)) : 0;
    if (amount > 0 && this.progress.reward(`cln:${frag.id}`, amount)) this.cleanup.earned += amount;
    this.cleanup.disposed++;
    this.progress.stat("debrisDisposed");
    this.audio.disposal(frag.material, frag.currPos);
    if (!this.progress.flag("tut_cleanup_done")) {
      this.progress.setFlag("tut_cleanup_done");
      this.hud.hint(null);
    }
    if (this.remainingMajors().length === 0 && !this.cleanup.announced) {
      this.cleanup.announced = true;
      this.hud.summary(t("summary.clean"), t("summary.cleanLine", { pieces: this.cleanup.disposed, credits: formatCredits(this.cleanup.earned) }), 4);
      this.audio.roomCleared();
    }
    this.updateModeHud();
    this.saves.request();
  }

  private recoverObject(obj: Destructible): void {
    const inRoom = Math.abs(obj.currPos.x - ROOM.origin[0]) < ROOM.width && obj.currPos.z < STREET.northFacadeZ;
    const target = inRoom ? RECOVERY.room : RECOVERY.street;
    obj.placeAt(new Vector3(target[0], target[1] + 0.5, target[2]), new Quaternion());
    obj.body?.wakeUp();
    this.hud.showToast(t("toast.objectReturned", { name: objectName(obj.definitionId) }), "info");
  }

  // ================================================================ tools

  private async equip(toolId: string, announce = true): Promise<void> {
    this.tools.equip(toolId);
    this.refreshToolHud();
    if (announce) this.events.emit("TOOL_EQUIPPED", { toolId });
    await this.viewmodel.setTool(toolId, getTool(toolId));
  }

  private ownedToolIds(): string[] {
    return TOOL_IDS.filter((id) => this.progress.state.ownedTools.includes(id));
  }

  private refreshToolHud(): void {
    const owned = this.ownedToolIds().map((id) => ({ id, name: toolName(id), equipped: id === this.tools.toolId }));
    this.hud.setTool(toolName(this.tools.toolId), owned, this.mode !== "break");
  }

  private selectTool(id: string): void {
    if (id === this.tools.toolId || !this.progress.equipTool(id).ok) return;
    void this.equip(id);
  }

  // ================================================================ frame loop

  /** Dev only: simulate without rendering (balance harness). */
  private headless = false;
  /** Pause when the tab is hidden (switched off by automated test harnesses). */
  private autoPause = true;

  private frame(now: number): void {
    const realSeconds = Math.max(0, Math.min((now - this.last) / 1000, MAX_FRAME_SECONDS));
    this.last = now;
    // Slow motion only stretches the world simulation; input, UI and audio stay real-time.
    const timeScale = this.slowMo > 0 && this.state === "playing" ? SLOW_MO_SCALE : 1;
    this.slowMo = Math.max(0, this.slowMo - realSeconds);
    const frameSeconds = realSeconds;
    const worldSeconds = realSeconds * timeScale;
    const { input, physics, renderer } = this.ctx;

    if (this.state === "playing" && !this.loading) {
      this.playtime += frameSeconds;
      if (this.demoEndTimer > 0) {
        this.demoEndTimer -= frameSeconds;
        if (this.demoEndTimer <= 0 && !this.grab.holding && this.tools.stage === "idle") this.showDemoComplete();
        else if (this.demoEndTimer <= 0) this.demoEndTimer = 0.25;
      }
      this.handleInput(frameSeconds);
    }

    // Physics runs on the title backdrop and while playing; every overlay freezes the world.
    if ((this.state === "playing" || this.state === "title") && !this.loading) {
      physics.advance(
        worldSeconds,
        (dt) => {
          if (this.state === "playing") {
            this.player.fixedUpdate(dt);
            this.grab.fixedUpdate(dt);
          }
        },
        (dt) => this.destruction.afterStep(dt, physics.events),
      );
      if (this.state === "playing") {
        this.session.update(frameSeconds);
        if (this.breakEndTimer > 0) {
          this.breakEndTimer -= frameSeconds;
          if (this.breakEndTimer <= 0 && this.mode === "break") this.setMode("cleanup");
        }
      }
      this.room.door.update(frameSeconds);
    }
    this.destruction.render(physics.alpha(), worldSeconds);
    this.particles.update(worldSeconds);
    this.updateLocation();
    if (this.lighting.update(frameSeconds)) this.shadows.invalidate(1);

    if (this.state === "title") this.updateTitleCamera(frameSeconds);
    else {
      this.player.updateCamera(physics.alpha(), frameSeconds);
      this.shake.apply(this.camera, frameSeconds);
      const fov = this.baseFov + SPRINT_FOV * this.player.sprint;
      if (Math.abs(fov - this.camera.fov) > 0.05) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
    }
    this.viewmodel.setLowered(this.mode !== "break" || this.grab.holding);
    this.viewmodel.update(this.camera, this.tools.stage, this.tools.phase, this.tools.impact, this.player.horizontalSpeed, this.lastLook, frameSeconds);
    this.viewmodel.updateKick(this.camera, this.kick.stage, this.kick.phase);

    if (this.state === "playing") {
      this.updatePrompts();
      this.updateTargeting();
      this.updateFootsteps();
      this.saves.tick(frameSeconds);
    }
    this.camera.getWorldDirection(this.aimDir);
    this.audio.updateListener(this.camera, this.aimDir);
    if (this.room.door.locked !== this.doorWasLocked) {
      this.doorWasLocked = this.room.door.locked;
      this.audio.door(this.doorWasLocked, new Vector3(0, 1.2, -6.7));
    }
    if (this.shop || this.shopThumbs) void this.thumbs.pump();
    this.hud.update(frameSeconds);

    if (this.destruction.anyMoving || this.room.door.moving) this.shadows.invalidate(1);
    input.endFrame();
    // Dev balance/QA harnesses simulate minutes of play without drawing it.
    if (import.meta.env.DEV && this.headless) return;
    this.colliders?.update();
    // Draw-call counters cover the whole frame (world, shadow and tool passes), not the last pass.
    renderer.info.autoReset = false;
    renderer.info.reset();
    this.shadows.beforeRender(this.scene);
    renderer.render(this.scene, this.camera);
    if (this.state !== "title") {
      // Tool pass: drawn over the world with a fresh depth buffer so it never clips into walls.
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(this.viewmodel.scene, this.camera);
      renderer.autoClear = true;
    }
    this.governor.tick(frameSeconds);
    this.debug.tick(frameSeconds, this.debugText());
  }

  private debugText(): string {
    const d = this.destruction.debris;
    const all = d.all();
    const majors = all.filter((f) => f.kind === "major");
    const held = majors.filter((f) => f.state === "held").length;
    const hit = this.tools.lastHit;
    const look = this.grab.look();
    const target = look ? (look.target.kind === "object" ? `${look.target.obj.instanceId} ${look.target.obj.state.stage} hp ${Math.round(look.target.obj.state.health)}` : `${look.target.frag.id} ${look.target.frag.state} hp ${Math.round(look.target.frag.hp)} ${look.target.frag.mass.toFixed(1)}kg`) : "-";
    return [
      `${this.location} · mode ${this.mode} · session ${this.session.active ? this.session.id : "-"} · tool ${this.tools.toolId}`,
      `target ${target}`,
      hit ? `last hit ${hit.speed.toFixed(1)} m/s · ${Math.round(hit.energy)} J · ${hit.targets} target(s) · at ${hit.point.x.toFixed(2)},${hit.point.y.toFixed(2)},${hit.point.z.toFixed(2)}` : "last hit -",
      `debris ${all.length} (${d.activeCount} physical) · collectible ${majors.length} · held ${held} · cleanup ${this.cleanup.disposed}/${this.cleanup.disposed + this.remainingMajors().length}`,
      `credits ${this.progress.state.credits} · ledger ${this.progress.state.rewardLedger.length} · save ${this.active ? `${this.active.saveId.slice(0, 12)} slot ${this.active.slot + 1}` : "-"} · profile ${this.ctx.profiles.active?.id.slice(0, 12) ?? "-"} · saved ${this.saves.lastSavedAt ? new Date(this.saves.lastSavedAt).toLocaleTimeString() : "never"}${this.saves.persistent ? "" : " (memory only)"}`,
    ].join("\n");
  }

  private handleInput(dt: number): void {
    const { input } = this.ctx;
    const look = input.consumeLook();
    this.player.look(look.x, this.settings.invertY ? -look.y : look.y, GAME.player.lookSensitivity * this.settings.sensitivity);
    this.lastLook = look;
    this.player.captureInput();
    if (input.pressed("pause")) {
      this.pause();
      return;
    }
    if (input.pressed("debug")) this.debug.toggle();
    if (input.pressed("colliders")) this.colliders?.toggle();

    // The TAB selector owns the keys while it is open (movement still works).
    if (this.handleModeBar(dt)) {
      this.tools.update(dt, false);
      this.kick.update(dt, false);
      return;
    }

    const owned = this.ownedToolIds();
    owned.forEach((id, i) => {
      if (input.pressed(`slot${i + 1}` as Action)) this.selectTool(id);
    });
    const wheel = input.consumeWheel();
    if (wheel !== 0 && owned.length > 1 && this.tools.stage === "idle" && !this.arrange.busy) {
      const next = owned[(owned.indexOf(this.tools.toolId) + (wheel > 0 ? 1 : -1) + owned.length) % owned.length];
      if (next) this.selectTool(next);
    }

    const arranging = this.mode === "arrange" && this.location === "room";
    if (this.grab.holding) {
      // The hover box belongs to the object as it stood; once it is in the hands it must go.
      this.arrange.hide();
      this.handleHolding(arranging);
    } else if (arranging) {
      this.arrange.update(dt, input);
      if (input.pressed("inventory") && !this.arrange.busy) {
        this.openStorage();
        return;
      }
      if (!this.arrange.busy && input.pressed("interact")) this.interact();
    } else {
      if (this.arrange.busy) this.arrange.cancel();
      this.arrange.hide();
      if (input.pressed("interact")) this.interact();
    }
    this.player.speedScale = this.grab.holding ? Math.max(0.45, 1 - this.grab.heldMass * GAME.interaction.carrySlowdownPerKg) : 1;
    this.tools.update(dt, input.pressed("attack"));
    this.kick.update(dt, input.pressed("kick"));
  }

  /** Carrying something: LMB throws (or places, in arrange), E or RMB puts it down. */
  private handleHolding(arranging: boolean): void {
    const { input } = this.ctx;
    const held = this.grab.target;
    if (input.pressed("interact") || input.pressed("kick")) {
      this.grab.release();
      return;
    }
    if (!input.pressed("attack") || !held) return;
    if (arranging && held.kind === "object" && isInRoom(held.obj.currPos.x, held.obj.currPos.z)) {
      this.grab.release();
      this.arrange.begin(held.obj, false);
      return;
    }
    this.grab.throw(this.player.worldVelocity);
  }

  /** E: take a delivered tool, pick something up, or walk into a shop (in that order). */
  private interact(): void {
    this.camera.getWorldDirection(this.aimDir);
    const world = this.ctx.physics.world;
    const hit = world.castRay(new RAPIER.Ray(this.camera.position, this.aimDir), GAME.interaction.reach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, AIM_FILTER, this.player.collider);
    const delivery = hit ? this.bench.deliveryAt(hit.collider.handle) : null;
    if (delivery) {
      const r = this.progress.pickUpTool(delivery.id);
      if (r.ok) {
        void this.bench.show(this.progress.state.toolDeliveries);
        void this.equip(r.toolId);
        this.audio.pickup();
        this.hud.showToast(t("toast.toolPicked", { name: toolName(r.toolId) }), "good");
        // The last tool ends the demo (once): a moment to enjoy it, then the summary.
        if (TOOL_IDS.every((id) => this.progress.state.ownedTools.includes(id)) && !this.progress.flag("demo_complete")) {
          this.progress.setFlag("demo_complete");
          this.demoEndTimer = DEMO_END_DELAY;
        }
      }
      return;
    }
    const look = this.grab.look();
    if (look) {
      if (look.grabbable) this.grab.grab(look.target);
      else if (look.blocked === "heavy") this.hud.showToast(t("toast.tooHeavy", { kg: look.mass.toFixed(0) }), "warn", 1.4);
      return;
    }
    const spot = this.nearShop();
    if (spot) this.openShop(spot.id);
  }

  private onGrab(target: GrabTarget): void {
    this.progress.stat("objectsGrabbed");
    this.audio.pickup();
    if (target.kind === "object" && target.obj.foundItemId && !this.progress.state.claimedFoundItems.includes(target.obj.foundItemId)) {
      this.progress.claimFound(target.obj.foundItemId);
    }
  }

  /** The shop door the player is standing at and facing (not just near: the bench is close by). */
  private nearShop(): StreetSpot | null {
    if (this.location !== "street") return null;
    const feet = this.player.feet;
    this.camera.getWorldDirection(this.aimDir);
    for (const spot of this.spots) {
      this.tmp.set(spot.position[0], feet.y, spot.position[2] - 0.6);
      const dist = this.tmp.distanceTo(feet);
      if (dist > GAME.interaction.reach) continue;
      this.tmp.sub(feet).setY(0).normalize();
      const facing = this.tmp.x * this.aimDir.x + this.tmp.z * this.aimDir.z;
      if (facing > 0.55 || dist < 0.9) return spot;
    }
    return null;
  }

  /** Dust, chips, sparks and glints sized by the impact. Purely cosmetic (scaled by quality). */
  private emitImpactParticles(material: MaterialType, energy: number, point: Vector3, normal: Vector3, source: "tool" | "collision", broke: boolean, toolId?: string): void {
    const color = DUST[material];
    if (source === "collision") {
      if (energy > 15) this.particles.emit("dust", point, UP, color, Math.min(6, 1 + energy / 40), energy);
      if (broke) this.particles.emit("chips", point, UP, color, 6, energy);
      return;
    }
    this.particles.emit("dust", point, normal, color, 3 + Math.min(8, energy / 30), energy);
    this.particles.emit("chips", point, normal, color, 2 + Math.min(8, energy / 25), energy);
    if (material === "metal" && toolId && METAL_TOOLS.has(toolId) && energy > 40) this.particles.emit("sparks", point, normal, color, 6 + energy / 25, energy);
    if (material === "glass") this.particles.emit("glint", point, normal, color, 6, energy);
    if (broke) {
      this.particles.emit("dust", point, normal, color, 10, energy * 1.5);
      this.particles.emit("chips", point, normal, color, 10, energy * 1.5);
      if (material === "glass") this.particles.emit("glint", point, normal, color, 14, energy);
    }
  }

  private updateFootsteps(): void {
    const feet = this.player.feet;
    const moved = Math.hypot(feet.x - this.lastFeet.x, feet.z - this.lastFeet.z);
    this.lastFeet.copy(feet);
    if (!this.player.isGrounded || moved > 1) return;
    this.stepDistance += moved;
    const sprint = this.player.sprint > 0.5;
    // Crouched steps are shorter (and quieter); a sprint stride is longer.
    const crouched = this.player.isCrouched;
    if (this.stepDistance >= (sprint ? 0.85 : crouched ? 0.45 : 0.6)) {
      this.stepDistance = 0;
      this.audio.footstep(this.location === "room", sprint, crouched);
    }
  }

  private updateLocation(): void {
    const feet = this.player.feet;
    const location = isInRoom(feet.x, feet.z) ? "room" : "street";
    if (location === this.location) return;
    this.location = location;
    if (this.lighting.setLocation(location)) this.shadows.invalidate();
    if (location === "room" && this.state === "playing" && this.mode === "arrange" && !this.progress.flag("tut_arrange")) {
      this.progress.setFlag("tut_arrange");
      this.hud.hint(t("tut.arrange"), 9);
    }
    this.updateModeHud();
    this.events.emit("LOCATION_CHANGED", { location });
  }

  private updatePrompts(): void {
    if (this.modeBar) {
      this.hud.setPrompt(null);
      return;
    }
    const held = this.grab.target;
    if (held) {
      const nearBin = this.player.feet.distanceTo(this.trash.front) < 4;
      if (this.mode === "arrange" && this.location === "room" && held.kind === "object") this.hud.setPrompt("LMB", t("prompt.placeHeld"));
      else this.hud.setPrompt("LMB", held.kind === "fragment" && nearBin ? t("prompt.throwBin") : t("prompt.throw"));
      return;
    }
    if (this.mode === "arrange" && this.location === "room") {
      const a = this.arrange.state;
      if (a.placing) {
        this.hud.setPrompt(a.problem ? "" : "LMB", a.problem ? t(`prompt.invalid.${a.problem}` as TextKey) : t("prompt.place"));
        return;
      }
      if (a.hovered) {
        this.hud.setPrompt("LMB", `${objectName(a.hovered.definitionId).toLocaleUpperCase()} · ${t("prompt.arrangeHover")}`);
        return;
      }
    }
    this.camera.getWorldDirection(this.aimDir);
    const hit = this.ctx.physics.world.castRay(new RAPIER.Ray(this.camera.position, this.aimDir), GAME.interaction.reach, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, AIM_FILTER, this.player.collider);
    const delivery = hit ? this.bench.deliveryAt(hit.collider.handle) : null;
    if (delivery) {
      this.hud.setPrompt("E", t("prompt.pickTool", { name: toolName(delivery.toolId).toLocaleUpperCase() }));
      return;
    }
    const look = this.grab.look();
    if (look) {
      if (look.grabbable) {
        this.hud.setPrompt("E", look.target.kind === "object" ? t("prompt.carry", { name: objectName(look.target.obj.definitionId).toLocaleUpperCase() }) : t("prompt.grab"));
        return;
      }
      if (look.blocked === "heavyPiece") {
        this.hud.setPrompt("", t(this.mode === "break" ? "prompt.heavyPiece" : "prompt.heavyPieceMode"));
        return;
      }
      if (look.blocked === "heavy") {
        this.hud.setPrompt("", t("prompt.tooHeavy"));
        return;
      }
    }
    const spot = this.nearShop();
    if (spot) {
      this.hud.setPrompt("E", spot.id === "tools" ? t("prompt.enterTools") : t("prompt.enterObjects"));
      return;
    }
    if (this.mode === "arrange" && this.location === "room") {
      this.hud.setPrompt("I", t("prompt.arrangeIdle"));
      return;
    }
    this.hud.setPrompt(null);
  }

  /** Crosshair feedback and the health bar of whatever breakable object is under the crosshair. */
  private updateTargeting(): void {
    this.camera.getWorldDirection(this.aimDir);
    const hit = this.ctx.physics.world.castRay(new RAPIER.Ray(this.camera.position, this.aimDir), TARGET_REACH, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, AIM_FILTER, this.player.collider);
    const owner = hit ? this.destruction.ownerOf(hit.collider) : undefined;
    const target = owner?.kind === "object" ? owner.obj : null;
    this.hud.setTargeted(!!target && !!hit && hit.timeOfImpact <= this.tools.tool.reach && this.tools.canAttack());

    // Show the bar for the aimed (damaged or breakable-now) object, or briefly for whatever was just hit.
    let shown = target && target.template.def.capabilities.destructible && (this.mode === "break" || target.healthRatio < 1) ? target : null;
    if (!shown) {
      for (const obj of this.destruction.all()) {
        if (obj.alive && obj.sinceHit < 1.5 && obj.template.def.capabilities.destructible) {
          shown = obj;
          break;
        }
      }
    }
    if (!shown || !shown.alive || (shown.healthRatio >= 1 && shown !== target)) {
      this.hud.setHealth(null);
      return;
    }
    this.tmp2.copy(shown.root.position).add(this.tmp.set(0, shown.template.size[1] + 0.12, 0));
    const screen = this.toScreen(this.tmp2);
    this.hud.setHealth(screen ? { name: objectName(shown.definitionId), ratio: shown.healthRatio, x: screen.x, y: screen.y } : null);
  }

  private toScreen(world: Vector3): { x: number; y: number } | null {
    const v = world.clone().project(this.camera);
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  }

  private showPayout(p: Payout): void {
    const at = p.point ? this.toScreen(new Vector3(...p.point)) : null;
    const x = at?.x ?? window.innerWidth / 2;
    const y = (at?.y ?? window.innerHeight / 2) - 20;
    const label = p.label ? t(`payout.${p.label}`) : "";
    this.hud.popup(`+${formatCredits(p.amount)}`, label, x, y);
    this.events.emit("REWARD_GRANTED", { amount: p.amount, reason: p.label || p.name, point: p.point });
  }

  /** Slow drift across the street behind the title menu. */
  private updateTitleCamera(dt: number): void {
    this.titleTime += dt;
    const tt = this.titleTime * 0.05;
    this.camera.position.set(Math.sin(tt) * 6, 1.9 + Math.sin(tt * 1.7) * 0.2, 4.2);
    this.camera.lookAt(Math.sin(tt) * 3, 2.1, -6.5);
  }

  // ================================================================ dev

  /** Dev-only console/automation handle: window.__stresst. Stripped from production builds. */
  private exposeDevHandle(): void {
    // Constant-folded away in production builds, taking the whole handle with it.
    if (!import.meta.env.DEV) return;
    let devReward = 0;
    (window as unknown as { __stresst: unknown }).__stresst = {
      game: this,
      destruction: this.destruction,
      tools: this.tools,
      progress: this.progress,
      session: this.session,
      saves: this.saves,
      profiles: this.ctx.profiles,
      teleport: (x: number, y: number, z: number, yaw = 0) => this.player.teleport([x, y, z], yaw),
      look: (yaw: number, pitch: number) => {
        this.player.yaw = yaw;
        this.player.pitch = MathUtils.clamp(pitch, -1.5, 1.5);
      },
      play: () => this.play(),
      newGame: (slot = 0) => this.newGame(slot),
      load: (slot = 0) => this.loadSlot(slot),
      menu: () => this.quitToMenu(),
      enterRoom: () => this.player.teleport(ROOM_ENTRY.position, ROOM_ENTRY.yaw),
      mode: (m: Mode) => this.chooseMode(m),
      startBreak: () => this.chooseMode("break"),
      shop: (kind: ShopKind) => this.openShop(kind),
      credits: (n: number) => this.progress.reward(`dev:${++devReward}`, n),
      equip: (id: string) => this.equip(id),
      pickUpAll: () => {
        for (const d of this.progress.state.toolDeliveries.slice()) this.progress.pickUpTool(d.id);
        void this.bench.show(this.progress.state.toolDeliveries);
      },
      grabTarget: (target: GrabTarget) => this.grab.grab(target),
      grip: (id: string, position: [number, number, number], rotation: [number, number, number], scale: number, offset?: [number, number, number]) => {
        getTool(id).viewmodel = { ...getTool(id).viewmodel, position, rotation, scale, offset };
        this.viewmodel.reset();
        void this.equip(id);
      },
      attack: () => this.ctx.input.setAction("attack", true),
      kick: () => this.ctx.input.setAction("kick", true),
      release: () => this.ctx.input.setAction("attack", false),
      key: (action: Action, down: boolean) => this.ctx.input.setAction(action, down),
      tap: (action: Action) => {
        this.ctx.input.setAction(action, true);
        this.frame(this.last + 1000 / 60);
        this.ctx.input.setAction(action, false);
      },
      /** Freezes the tool at a swing stage/phase and draws one frame (animation tuning). */
      pose: (stage: "idle" | "windup" | "active" | "recovery", phase: number) => {
        const r = this.ctx.renderer;
        r.setAnimationLoop(null);
        this.frame(this.last + 1000 / 60);
        this.viewmodel.update(this.camera, stage, phase, 0, 0, { x: 0, y: 0 }, 0);
        r.render(this.scene, this.camera);
        r.autoClear = false;
        r.clearDepth();
        r.render(this.viewmodel.scene, this.camera);
        r.autoClear = true;
      },
      /** Skips drawing so harnesses can simulate quickly. */
      headless: (on: boolean) => {
        this.headless = on;
      },
      /** Automated runs in a hidden pane: do not pause on visibility changes. */
      autoPause: (on: boolean) => {
        this.autoPause = on;
      },
      /** Runs frames synchronously at 60 fps (works even when the tab is hidden). */
      advance: (seconds: number) => {
        const frames = Math.max(1, Math.round(seconds * 60));
        for (let i = 0; i < frames; i++) this.frame(this.last + 1000 / 60);
      },
      defs: (): Record<string, ObjectDefinition> => OBJECTS,
      object: (id: string) => getObject(id),
    };
  }
}
