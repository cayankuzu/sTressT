import { h } from "./dom";
import { formatCredits, t } from "./i18n";

type Popup = { el: HTMLElement; age: number; x: number; y: number };

export type ModeId = "arrange" | "break" | "cleanup";
export type ModeBarItem = { id: ModeId; enabled: boolean; reason: string | null };

const POPUP_LIFE = 1.1;

/**
 * Always-on gameplay HUD. Everything is cheap DOM text/transform updates, and only when a value
 * actually changes; popups, counters and timed panels animate in `update`.
 */
export class Hud {
  readonly el: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly stressWrap: HTMLElement;
  private readonly stressFill: HTMLElement;
  private readonly stressValue: HTMLElement;
  private readonly credits: HTMLElement;
  private readonly tool: HTMLElement;
  private readonly slots: HTMLElement;
  private readonly combo: HTMLElement;
  private readonly mode: HTMLElement;
  private readonly modeTitle: HTMLElement;
  private readonly modeSub: HTMLElement;
  private readonly tabHint: HTMLElement;
  private readonly modeBar: HTMLElement;
  private readonly health: HTMLElement;
  private readonly healthName: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly toast: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly hintEl: HTMLElement;
  private readonly popupLayer: HTMLElement;
  private popups: Popup[] = [];
  private promptKey = "";
  private promptText = "";
  private shownCredits = 0;
  private targetCredits = 0;
  private toastTimer = 0;
  private summaryTimer = 0;
  private hintTimer = 0;
  private modeKey = "";

  constructor(parent: HTMLElement) {
    this.crosshair = h("div", { class: "crosshair" });
    this.prompt = h("div", { class: "prompt" });
    this.prompt.hidden = true;
    this.stressFill = h("div", { class: "bar-fill" });
    this.stressValue = h("span", { class: "hud-value", text: "100%" });
    this.stressWrap = h("div", { class: "hud-stress" }, h("div", { class: "hud-label" }, `${t("hud.stress")} `, this.stressValue), h("div", { class: "bar" }, this.stressFill));
    this.stressWrap.hidden = true;
    this.credits = h("div", { class: "hud-credits", text: formatCredits(0) });
    this.tool = h("div", { class: "hud-tool-name" });
    this.slots = h("div", { class: "hud-slots" });
    this.combo = h("div", { class: "hud-combo" });
    this.combo.hidden = true;
    this.modeTitle = h("div", { class: "mode-title" });
    this.modeSub = h("div", { class: "mode-sub" });
    this.mode = h("div", { class: "hud-mode" }, this.modeTitle, this.modeSub);
    this.mode.hidden = true;
    this.tabHint = h("div", { class: "hud-tabhint" }, h("kbd", { text: "TAB" }), h("span", { text: t("hud.tabHint") }));
    this.tabHint.hidden = true;
    this.modeBar = h("div", { class: "hud-modebar", attrs: { role: "listbox" } });
    this.modeBar.hidden = true;
    this.healthName = h("div", { class: "hp-name" });
    this.healthFill = h("div", { class: "bar-fill" });
    this.health = h("div", { class: "hud-hp" }, this.healthName, h("div", { class: "bar thin" }, this.healthFill));
    this.health.hidden = true;
    this.toast = h("div", { class: "hud-toast" });
    this.toast.hidden = true;
    this.summaryEl = h("div", { class: "hud-summary" });
    this.summaryEl.hidden = true;
    this.hintEl = h("div", { class: "hud-hint" });
    this.hintEl.hidden = true;
    this.popupLayer = h("div", { class: "popup-layer" });
    this.el = h(
      "div",
      { class: "hud" },
      this.popupLayer,
      this.crosshair,
      this.prompt,
      this.stressWrap,
      this.credits,
      h("div", { class: "hud-tool" }, this.tool, this.slots),
      this.combo,
      this.mode,
      this.tabHint,
      this.modeBar,
      this.health,
      this.summaryEl,
      this.hintEl,
      this.toast,
    );
    parent.append(this.el);
  }

  setVisible(visible: boolean): void {
    this.el.hidden = !visible;
  }

  setTargeted(targeted: boolean): void {
    this.crosshair.classList.toggle("target", targeted);
  }

  /** Shows "[key] TEXT" under the crosshair; null hides it. */
  setPrompt(key: string | null, text = ""): void {
    if (key === this.promptKey && text === this.promptText) return;
    this.promptKey = key ?? "";
    this.promptText = text;
    this.prompt.hidden = key === null;
    this.prompt.replaceChildren(...(key !== null ? [key ? h("kbd", { text: key }) : null, text].filter((x): x is HTMLElement | string => x !== null) : []));
  }

  setStress(value: number | null): void {
    this.stressWrap.hidden = value === null;
    if (value === null) return;
    const pct = Math.max(0, Math.min(100, value));
    this.stressFill.style.transform = `scaleX(${pct / 100})`;
    this.stressValue.textContent = `${Math.ceil(pct)}%`;
  }

  setCredits(value: number, instant = false): void {
    this.targetCredits = value;
    if (instant) {
      this.shownCredits = value;
      this.credits.textContent = formatCredits(value);
    }
  }

  setTool(name: string, owned: { id: string; name: string; equipped: boolean }[], lowered: boolean): void {
    this.tool.textContent = name.toLocaleUpperCase();
    this.tool.classList.toggle("lowered", lowered);
    this.slots.replaceChildren(...owned.map((tl, i) => h("span", { class: tl.equipped ? "slot on" : "slot", text: String(i + 1), attrs: { title: tl.name } })));
  }

  setCombo(count: number, multiplier: number): void {
    this.combo.hidden = count < 2;
    if (count < 2) return;
    this.combo.replaceChildren(h("span", { class: "combo-count", text: t("hud.combo", { n: count }) }), h("span", { class: "combo-mult", text: `${multiplier.toFixed(1)}×` }));
    this.combo.classList.remove("pulse");
    void this.combo.offsetWidth;
    this.combo.classList.add("pulse");
  }

  /** Small mode chip at the top: DÜZENLE / KIR / TEMİZLE plus one line of context. */
  setMode(mode: ModeId | null, sub = "", tone: "" | "danger" | "good" = ""): void {
    const key = `${mode}|${sub}|${tone}`;
    if (key === this.modeKey) return;
    this.modeKey = key;
    this.mode.hidden = mode === null;
    this.tabHint.hidden = mode === null;
    if (!mode) return;
    this.mode.dataset.mode = mode;
    this.modeTitle.textContent = t(`mode.${mode}`);
    this.modeSub.textContent = sub;
    this.modeSub.hidden = !sub;
    this.modeSub.className = `mode-sub${tone ? ` ${tone}` : ""}`;
  }

  /** The TAB selector: the three modes, the highlighted one, and why others are unavailable. */
  showModeBar(items: ModeBarItem[], current: ModeId, highlighted: ModeId): void {
    this.modeBar.hidden = false;
    const hl = items.find((i) => i.id === highlighted);
    this.modeBar.replaceChildren(
      h(
        "div",
        { class: "modebar-items" },
        ...items.map((item, i) =>
          h(
            "div",
            { class: `modebar-item${item.id === current ? " current" : ""}${item.id === highlighted ? " hl" : ""}${item.enabled ? "" : " off"}`, attrs: { role: "option", "aria-selected": String(item.id === highlighted) } },
            h("kbd", { text: String(i + 1) }),
            h("span", { text: t(`mode.${item.id}`) }),
          ),
        ),
      ),
      h("div", { class: `modebar-note${hl && !hl.enabled ? " off" : ""}`, text: hl && !hl.enabled && hl.reason ? hl.reason : t("modebar.hint") }),
    );
  }

  hideModeBar(): void {
    this.modeBar.hidden = true;
  }

  /** World-space health bar; null hides. x/y in CSS pixels. */
  setHealth(target: { name: string; ratio: number; x: number; y: number } | null): void {
    this.health.hidden = target === null;
    if (!target) return;
    if (this.healthName.textContent !== target.name) this.healthName.textContent = target.name;
    this.healthFill.style.transform = `scaleX(${Math.max(0, Math.min(1, target.ratio))})`;
    this.health.style.transform = `translate(${Math.round(target.x)}px, ${Math.round(target.y)}px) translate(-50%, -100%)`;
  }

  /** "+12 CR" popup drifting up from a screen position. */
  popup(text: string, label: string, x: number, y: number, small = false): void {
    const el = h("div", { class: small ? "popup small" : "popup" }, h("span", { class: "popup-amount", text }), label ? h("span", { class: "popup-label", text: label }) : null);
    this.popupLayer.append(el);
    this.popups.push({ el, age: 0, x, y });
    if (this.popups.length > 8) this.popups.shift()?.el.remove();
  }

  showToast(text: string, tone: "info" | "warn" | "good" = "info", seconds = 2.2): void {
    this.toast.textContent = text;
    this.toast.className = `hud-toast ${tone}`;
    this.toast.hidden = false;
    this.toastTimer = seconds;
  }

  /** A short, non-blocking result panel (break over, room clean). Control never stops. */
  summary(title: string, line: string, seconds = 5): void {
    this.summaryEl.replaceChildren(h("div", { class: "summary-head", text: title }), h("div", { class: "summary-line", text: line }));
    this.summaryEl.hidden = false;
    this.summaryEl.classList.remove("show");
    void this.summaryEl.offsetWidth;
    this.summaryEl.classList.add("show");
    this.summaryTimer = seconds;
  }

  /** One-line contextual tip (first-time help); null hides it. */
  hint(text: string | null, seconds = 9): void {
    this.hintEl.hidden = text === null;
    if (text) {
      this.hintEl.textContent = text;
      this.hintTimer = seconds;
    }
  }

  update(dt: number): void {
    if (this.shownCredits !== this.targetCredits) {
      const diff = this.targetCredits - this.shownCredits;
      const step = Math.sign(diff) * Math.max(1, Math.abs(diff) * Math.min(1, dt * 7));
      this.shownCredits = Math.abs(step) >= Math.abs(diff) ? this.targetCredits : this.shownCredits + step;
      this.credits.textContent = formatCredits(this.shownCredits);
    }
    for (let i = this.popups.length - 1; i >= 0; i--) {
      const p = this.popups[i] as Popup;
      p.age += dt;
      const k = p.age / POPUP_LIFE;
      if (k >= 1) {
        p.el.remove();
        this.popups.splice(i, 1);
        continue;
      }
      p.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y - k * 46)}px) translate(-50%, -50%)`;
      p.el.style.opacity = String(k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3);
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.hidden = true;
    }
    if (this.summaryTimer > 0) {
      this.summaryTimer -= dt;
      if (this.summaryTimer <= 0) this.summaryEl.hidden = true;
    }
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.hintEl.hidden = true;
    }
  }
}
