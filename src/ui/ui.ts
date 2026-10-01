import type { SlotSummary } from "../save/schema";
import type { Language, Settings } from "../save/settings";
import { button, h } from "./dom";
import { formatCredits, formatDate, formatDuration, t } from "./i18n";

export type LoadingView = { setProgress(loaded: number, total: number): void; setError(message: string): void };

export type MainMenuInfo = {
  profileName: string | null;
  /** Shown under CONTINUE (which slot, when). Null = nothing to continue. */
  continueInfo: string | null;
  storageWarning: boolean;
  noMouse: boolean;
};

export type MainMenuHandlers = { onContinue(): void; onNewGame(): void; onSavedGames(): void; onSettings(): void; onProfiles(): void };

export type ProfileEntry = { id: string; name: string; active: boolean };
export type ProfileHandlers = { select(id: string): void; create(name: string): void; remove(id: string): void; back: (() => void) | null };

export type SlotHandlers = { load(slot: number): void; start(slot: number): void; remove(slot: number): void; back(): void };

export type PauseHandlers = { onResume(): void; onSave(): void; onEndBreak(): void; onSettings(): void; onMainMenu(): void };

export type SettingsHandlers = {
  change(patch: Partial<Settings>): void;
  fullscreen(): void;
  back(): void;
};

function logo(): HTMLElement {
  return h("h1", { class: "logo" }, "s", h("span", { text: "T" }), "ress", h("span", { text: "T" }));
}

/** Owns the DOM layer: a persistent HUD plus at most one modal overlay at a time. */
export class UI {
  readonly hudLayer: HTMLElement;
  private overlay: HTMLElement | null = null;

  constructor(readonly root: HTMLElement) {
    this.hudLayer = h("div", { class: "hud" });
    root.append(this.hudLayer);
  }

  get hasOverlay(): boolean {
    return this.overlay !== null;
  }

  setOverlay(el: HTMLElement | null): void {
    this.overlay?.remove();
    this.overlay = el;
    if (!el) return;
    this.root.append(el);
    // Keyboard users land on the first action.
    el.querySelector<HTMLElement>("input, button:not(:disabled)")?.focus({ preventScroll: true });
  }

  loading(): LoadingView {
    const bar = h("div");
    const status = h("p", { class: "muted", text: t("app.loading") });
    this.setOverlay(h("div", { class: "screen solid" }, logo(), h("div", { class: "progress" }, bar), status));
    return {
      setProgress(loaded, total) {
        bar.style.width = `${total > 0 ? Math.round((loaded / total) * 100) : 0}%`;
        status.textContent = t("app.loadingAssets", { loaded, total });
      },
      setError(message) {
        status.textContent = message;
        status.classList.add("error");
      },
    };
  }

  fatal(message: string): void {
    this.setOverlay(h("div", { class: "screen solid" }, logo(), h("p", { class: "error", text: message })));
  }

  mainMenu(info: MainMenuInfo, handlers: MainMenuHandlers): void {
    const cont = button(t("menu.continue"), handlers.onContinue, "primary");
    cont.disabled = !info.continueInfo;
    const contWrap = h("div", { class: "menu-continue" }, cont, info.continueInfo ? h("span", { class: "muted small", text: info.continueInfo }) : null);
    const profile = info.profileName
      ? h("button", { class: "profile-chip", attrs: { type: "button", title: t("menu.switchProfile") }, onClick: () => handlers.onProfiles() }, h("span", { class: "profile-label", text: t("menu.profile") }), h("span", { class: "profile-name", text: info.profileName }))
      : null;
    this.setOverlay(
      h(
        "div",
        { class: "screen dim main-menu" },
        profile,
        logo(),
        h("p", { class: "tagline", text: t("app.tagline") }),
        h("div", { class: "menu" }, contWrap, button(t("menu.newGame"), handlers.onNewGame, info.continueInfo ? "ghost" : "primary"), button(t("menu.savedGames"), handlers.onSavedGames), button(t("menu.settings"), handlers.onSettings)),
        info.storageWarning ? h("p", { class: "notice-warn", text: t("app.noStorage") }) : null,
        info.noMouse ? h("p", { class: "notice-warn", text: t("app.noMouse") }) : controlsHint(),
      ),
    );
  }

  profiles(list: ProfileEntry[], handlers: ProfileHandlers, opts: { welcome: boolean; max: number }): void {
    const input = h("input", { class: "text-input", attrs: { type: "text", maxlength: "20", placeholder: t("profile.name"), "aria-label": t("profile.name"), autocomplete: "off", spellcheck: "false" } });
    const create = button(t("profile.create"), () => {
      const name = input.value.trim();
      if (name) handlers.create(name);
      else input.focus();
    }, "primary");
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") create.click();
    });
    const full = list.length >= opts.max;
    input.disabled = full;
    create.disabled = full;
    const rows = list.map((p) =>
      h(
        "div",
        { class: `profile-row${p.active ? " on" : ""}` },
        h("span", { class: "profile-row-name", text: p.name }),
        p.active ? h("span", { class: "tag", text: t("profile.active") }) : button(t("profile.select"), () => handlers.select(p.id)),
        list.length > 1 || !p.active ? button(t("profile.delete"), () => handlers.remove(p.id), "danger") : null,
      ),
    );
    this.setOverlay(
      h(
        "div",
        { class: "screen dim" },
        h(
          "div",
          { class: "dialog wide", attrs: { role: "dialog", "aria-label": t("profile.title") } },
          h("h2", { class: "dialog-title", text: t("profile.title") }),
          opts.welcome ? h("p", { class: "muted", text: t("profile.welcome") }) : null,
          rows.length ? h("div", { class: "profile-list" }, ...rows) : null,
          h("div", { class: "profile-create" }, input, create),
          full ? h("p", { class: "muted small", text: t("profile.limit", { max: opts.max }) }) : null,
          handlers.back ? h("div", { class: "dialog-actions" }, button(t("profile.back"), handlers.back)) : null,
        ),
      ),
    );
  }

  slots(kind: "saved" | "new", summaries: (SlotSummary | null)[], handlers: SlotHandlers): void {
    const cards = summaries.map((s, slot) => {
      const title = h("div", { class: "slot-title" }, h("span", { class: "slot-num", text: t("slots.slot", { n: slot + 1 }) }), h("span", { class: "slot-name", text: s ? s.name : t("slots.empty") }));
      if (!s) {
        return h("div", { class: "slot-card empty" }, title, kind === "new" ? h("div", { class: "slot-actions" }, button(t("slots.start"), () => handlers.start(slot), "primary")) : null);
      }
      const facts: [string, string][] = [
        [t("slots.credits"), formatCredits(s.credits)],
        [t("slots.tools"), String(s.tools)],
        [t("slots.objects"), String(s.objects)],
        [t("slots.playtime"), formatDuration(s.playtimeSeconds)],
        [t("slots.lastPlayed"), formatDate(s.updatedAt)],
      ];
      const actions =
        kind === "saved"
          ? [button(t("slots.load"), () => handlers.load(slot), "primary"), button(t("slots.delete"), () => handlers.remove(slot), "danger")]
          : [button(t("slots.overwrite"), () => handlers.start(slot), "danger")];
      return h("div", { class: "slot-card" }, title, h("dl", { class: "slot-facts" }, ...facts.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])), h("div", { class: "slot-actions" }, ...actions));
    });
    const el = h(
      "div",
      { class: "screen dim" },
      h(
        "div",
        { class: "dialog slots-dialog", attrs: { role: "dialog", "aria-label": kind === "new" ? t("slots.titleNew") : t("slots.titleSaved") } },
        h("h2", { class: "dialog-title", text: kind === "new" ? t("slots.titleNew") : t("slots.titleSaved") }),
        h("div", { class: "slot-grid" }, ...cards),
        h("div", { class: "dialog-actions" }, button(t("common.back"), handlers.back)),
      ),
    );
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") handlers.back();
    });
    this.setOverlay(el);
  }

  pause(ctx: { inBreak: boolean }, handlers: PauseHandlers): void {
    this.setOverlay(
      h(
        "div",
        { class: "screen dim" },
        h("h2", { class: "tagline", text: t("pause.title") }),
        h(
          "div",
          { class: "menu" },
          button(t("pause.resume"), handlers.onResume, "primary"),
          button(t("pause.save"), handlers.onSave),
          ctx.inBreak ? button(t("pause.endBreak"), handlers.onEndBreak) : null,
          button(t("pause.settings"), handlers.onSettings),
          button(t("pause.mainMenu"), handlers.onMainMenu),
        ),
      ),
    );
  }

  /** End of the demo: the player's numbers, then back to the room or to the main menu. */
  demoComplete(stats: [string, string][], handlers: { onContinue(): void; onMainMenu(): void }): void {
    const el = h(
      "div",
      { class: "screen dim" },
      h(
        "div",
        { class: "dialog wide demo-end", attrs: { role: "dialog", "aria-label": t("demo.title") } },
        h("h2", { class: "dialog-title", text: t("demo.title") }),
        h("p", { class: "muted", text: t("demo.line") }),
        h("dl", { class: "demo-stats" }, ...stats.flatMap(([label, value]) => [h("dt", { text: label }), h("dd", { text: value })])),
        h("div", { class: "dialog-actions" }, button(t("pause.mainMenu"), handlers.onMainMenu), button(t("demo.continue"), handlers.onContinue, "primary")),
      ),
    );
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") handlers.onContinue();
    });
    this.setOverlay(el);
  }

  confirm(opts: { title: string; body: string[]; confirm: string; danger?: boolean; onConfirm(): void; onCancel(): void }): void {
    const el = h(
      "div",
      { class: "screen dim" },
      h(
        "div",
        { class: "dialog", attrs: { role: "alertdialog", "aria-label": opts.title } },
        h("h2", { class: "dialog-title", text: opts.title }),
        ...opts.body.map((line) => h("p", { class: "muted", text: line })),
        h("div", { class: "dialog-actions" }, button(t("common.cancel"), opts.onCancel), button(opts.confirm, opts.onConfirm, opts.danger ? "danger" : "primary")),
      ),
    );
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") opts.onCancel();
    });
    this.setOverlay(el);
  }

  settings(settings: Settings, handlers: SettingsHandlers): void {
    const slider = (label: string, value: number, min: number, max: number, step: number, format: (v: number) => string, apply: (v: number) => void): HTMLElement => {
      const out = h("output", { text: format(value) });
      const input = h("input", { attrs: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": label } });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = format(v);
        apply(v);
      });
      return h("label", { class: "setting" }, h("span", { text: label }), input, out);
    };
    const select = <T extends string>(label: string, value: T, options: [T, string][], apply: (v: T) => void): HTMLElement => {
      const el = h("select", { attrs: { "aria-label": label } });
      for (const [v, text] of options) {
        const opt = h("option", { text, attrs: { value: v } });
        if (v === value) opt.selected = true;
        el.append(opt);
      }
      el.addEventListener("change", () => apply(el.value as T));
      return h("label", { class: "setting" }, h("span", { text: label }), el, h("output", { text: "" }));
    };
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const el = h(
      "div",
      { class: "screen dim" },
      h(
        "div",
        { class: "dialog wide", attrs: { role: "dialog", "aria-label": t("settings.title") } },
        h("h2", { class: "dialog-title", text: t("settings.title") }),
        select<Language>(t("settings.language"), settings.language, [["tr", "Türkçe"], ["en", "English"]], (v) => handlers.change({ language: v })),
        slider(t("settings.master"), settings.masterVolume, 0, 1, 0.05, pct, (v) => handlers.change({ masterVolume: v })),
        slider(t("settings.sfx"), settings.sfxVolume, 0, 1, 0.05, pct, (v) => handlers.change({ sfxVolume: v })),
        slider(t("settings.ambience"), settings.musicVolume, 0, 1, 0.05, pct, (v) => handlers.change({ musicVolume: v })),
        slider(t("settings.sensitivity"), settings.sensitivity, 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`, (v) => handlers.change({ sensitivity: v })),
        select<"off" | "on">(
          t("settings.invertY"),
          settings.invertY ? "on" : "off",
          [
            ["off", t("settings.off")],
            ["on", t("settings.on")],
          ],
          (v) => handlers.change({ invertY: v === "on" }),
        ),
        slider(t("settings.fov"), settings.fov, 60, 100, 1, (v) => `${v}°`, (v) => handlers.change({ fov: v })),
        slider(t("settings.headBob"), settings.headBob, 0, 1, 0.05, pct, (v) => handlers.change({ headBob: v })),
        slider(t("settings.shake"), settings.shake, 0, 1, 0.05, pct, (v) => handlers.change({ shake: v })),
        select<Settings["quality"]>(
          t("settings.quality"),
          settings.quality,
          (["auto", "high", "medium", "low"] as const).map((q) => [q, t(`quality.${q}`)]),
          (v) => handlers.change({ quality: v }),
        ),
        h("p", { class: "muted small", text: t("settings.qualityNote") }),
        h("div", { class: "dialog-actions" }, button(t("settings.fullscreen"), handlers.fullscreen), button(t("common.back"), handlers.back, "primary")),
      ),
    );
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") handlers.back();
    });
    this.setOverlay(el);
  }
}

function controlsHint(): HTMLElement {
  const rows: [string, string][] = [
    ["WASD", t("controls.move")],
    ["MOUSE", t("controls.look")],
    ["LMB", t("controls.hit")],
    ["RMB", t("controls.kick")],
    ["E", t("controls.interact")],
    ["SPACE", t("controls.jump")],
    ["C", t("controls.crouch")],
    ["TAB", t("controls.modes")],
    ["1–7", t("controls.tools")],
    ["ESC", t("controls.pause")],
  ];
  return h("div", { class: "controls-hint" }, ...rows.flatMap(([key, label]) => [h("kbd", { text: key }), h("span", { text: label })]));
}
