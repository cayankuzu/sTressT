import { canBreak, MATERIALS, OBJECTS, objectsOfTier, TOOL_IDS, TOOLS, toolForTier } from "../data/catalog";
import type { MaterialType, ObjectCategory, ObjectDefinition, ToolDefinition } from "../data/types";
import { kineticEnergy } from "../destruction/damage";
import { majorPieceCount } from "../destruction/debrisRules";
import { cleanupPool, firstBreakBonus, unlockedTier } from "../economy/economy";
import type { ProgressState } from "../economy/state";
import type { Outcome } from "../game/Progress";
import { button, h } from "./dom";
import { formatCredits, objectDescription, objectName, t, type TextKey, toolDescription, toolName, toolTagline } from "./i18n";
import type { Thumbnails } from "./thumbnails";

export type ShopKind = "tools" | "objects";

export type ShopActions = {
  buyTool(id: string): Outcome;
  equipTool(id: string): Outcome;
  buyObject(id: string): Outcome;
  /** Free cardboard box when the player has neither credits nor anything to break. */
  safetyBox(): void;
  close(): void;
};

const CATEGORIES: (ObjectCategory | "all")[] = ["all", "fragile", "electronics", "furniture", "statues", "toys"];

const MAX_ENERGY = Math.max(...Object.values(TOOLS).map((tl) => kineticEnergy(tl.effectiveMass, tl.swingSpeed)));
const MAX_FORCE = Math.max(...Object.values(TOOLS).map((tl) => tl.effectiveMass * tl.swingSpeed));
const MAX_RATE = Math.max(...Object.values(TOOLS).map((tl) => 1 / (tl.windup + tl.active + tl.recovery)));
const MAX_REACH = Math.max(...Object.values(TOOLS).map((tl) => tl.reach));
/** Ignores repeat clicks on BUY for a moment (each click is still validated by the economy). */
const CLICK_LOCK_MS = 350;

function grade(value: number, [low, mid, high]: [number, number, number]): string {
  if (value < low) return t("tier.low");
  if (value < mid) return t("tier.medium");
  if (value < high) return t("tier.high");
  return t("tier.premium");
}

function statBar(label: string, ratio: number): HTMLElement {
  const fill = h("div", { class: "bar-fill" });
  fill.style.transform = `scaleX(${Math.max(0.04, Math.min(1, ratio))})`;
  return h("div", { class: "stat" }, h("span", { class: "stat-label", text: label }), h("div", { class: "bar" }, fill));
}

const matName = (m: MaterialType): string => t(`mat.${m}`);

/** Shop overlay for both street shops. Pure view: every change goes through `actions`. */
export class ShopView {
  readonly el: HTMLElement;
  private readonly list = h("div", { class: "shop-list", attrs: { role: "listbox" } });
  private readonly detail = h("div", { class: "shop-detail" });
  private readonly creditsEl = h("div", { class: "shop-credits" });
  private readonly nav = h("nav", { class: "shop-cats" });
  private selected: string;
  private category: ObjectCategory | "all" = "all";
  private notice = "";
  private lockedUntil = 0;

  constructor(
    private readonly kind: ShopKind,
    private state: ProgressState,
    private readonly actions: ShopActions,
    private readonly thumbs: Thumbnails,
    private safetyAvailable: boolean,
  ) {
    this.selected = kind === "tools" ? (TOOL_IDS.find((id) => !state.ownedTools.includes(id)) ?? TOOL_IDS[0] ?? "fists") : (Object.keys(OBJECTS)[0] ?? "");
    const title = kind === "tools" ? t("shop.tools") : t("shop.objects");
    const sub = kind === "tools" ? t("shop.toolsSub") : t("shop.objectsSub");
    this.el = h(
      "div",
      { class: "screen dim shop-screen" },
      h(
        "div",
        { class: "shop", attrs: { role: "dialog", "aria-label": title } },
        h(
          "header",
          { class: "shop-head" },
          h("div", {}, h("h2", { class: "shop-title", text: title }), h("p", { class: "muted", text: sub })),
          this.creditsEl,
          button(t("common.close"), () => actions.close()),
        ),
        h("div", { class: `shop-body ${kind}` }, kind === "objects" ? this.nav : null, this.list, this.detail),
      ),
    );
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        actions.close();
      }
    });
    this.render();
  }

  update(state: ProgressState, safetyAvailable = this.safetyAvailable): void {
    this.state = state;
    this.safetyAvailable = safetyAvailable;
    this.render();
  }

  private render(): void {
    this.creditsEl.textContent = formatCredits(this.state.credits);
    if (this.kind === "objects") {
      this.nav.replaceChildren(
        ...CATEGORIES.map((c) => {
          const b = button(t(`cat.${c}`), () => {
            this.category = c;
            this.render();
          });
          b.classList.toggle("on", this.category === c);
          return b;
        }),
      );
    }
    // Objects are listed by level (toys, which never break, last), cheapest first within a level.
    const level = (id: string): number => (OBJECTS[id]?.capabilities.destructible ? (OBJECTS[id]?.tier ?? 1) : 99);
    const ids =
      this.kind === "tools"
        ? TOOL_IDS.filter((id) => id !== "fists")
        : Object.keys(OBJECTS)
            .filter((id) => (OBJECTS[id]?.price ?? 0) > 0 && (this.category === "all" || OBJECTS[id]?.category === this.category))
            .sort((a, b) => level(a) - level(b) || (OBJECTS[a]?.price ?? 0) - (OBJECTS[b]?.price ?? 0));
    if (!ids.includes(this.selected) && ids[0]) this.selected = ids[0];
    const safety = this.kind === "objects" && this.safetyAvailable ? this.safetyRow() : null;
    const rows: HTMLElement[] = [];
    let group = -1;
    for (const id of ids) {
      if (this.kind === "objects" && level(id) !== group) {
        group = level(id);
        rows.push(this.groupHeader(group));
      }
      rows.push(this.row(id));
    }
    this.list.replaceChildren(...(safety ? [safety] : []), ...rows);
    this.detail.replaceChildren(...(this.kind === "tools" ? this.toolDetail(this.selected) : this.objectDetail(this.selected)));
  }

  private safetyRow(): HTMLElement {
    const take = button(t("shop.safety"), () => {
      if (!this.unlocked()) return;
      this.actions.safetyBox();
    }, "primary");
    return h("div", { class: "shop-safety" }, h("p", { class: "muted small", text: t("shop.safetyInfo") }), take);
  }

  private thumb(modelId: string, big = false): HTMLElement {
    const slot = h("div", { class: big ? "thumb big" : "thumb" });
    void this.thumbs.get(modelId).then((canvas) => {
      const img = h("canvas", { attrs: { width: String(canvas.width), height: String(canvas.height), "aria-hidden": "true" } });
      img.getContext("2d")?.drawImage(canvas, 0, 0);
      slot.replaceChildren(img);
    });
    return slot;
  }

  /** "LEVEL 3 · BASEBALL BAT" above a level's objects; dimmed with a lock until that tool is bought. */
  private groupHeader(level: number): HTMLElement {
    if (level > 7) return h("div", { class: "shop-group", text: t("shop.groupToys") });
    const open = level <= unlockedTier(this.state);
    return h("div", { class: `shop-group${open ? "" : " locked"}`, text: `${open ? "" : "🔒 "}${t("shop.group", { n: level, tool: toolName(toolForTier(level)).toLocaleUpperCase() })}` });
  }

  /** Bought and broken at least once (the collection). */
  private collected(id: string): boolean {
    return this.state.collection.includes(id);
  }

  private toolBadge(id: string): string {
    if (this.state.equippedToolId === id) return t("shop.equipped");
    if (this.state.ownedTools.includes(id)) return t("shop.owned");
    if (this.state.toolDeliveries.some((d) => d.toolId === id)) return t("shop.awaiting");
    return "";
  }

  private row(id: string): HTMLElement {
    let name = "";
    let price = 0;
    let model = "";
    let badge = "";
    if (this.kind === "tools") {
      const tl = TOOLS[id] as ToolDefinition;
      name = toolName(id);
      price = tl.price;
      model = tl.model;
      badge = this.toolBadge(id);
    } else {
      const o = OBJECTS[id] as ObjectDefinition;
      name = objectName(id);
      price = o.price;
      model = o.model;
    }
    const o = this.kind === "objects" ? (OBJECTS[id] as ObjectDefinition) : null;
    const locked = !!o && o.capabilities.destructible && o.tier > unlockedTier(this.state);
    const affordable = this.state.credits >= price;
    const level = this.kind === "tools" ? (TOOLS[id] as ToolDefinition).tier : o?.capabilities.destructible ? o.tier : 0;
    const chip = level > 0 ? h("span", { class: "row-level", text: t("hud.level", { n: level }) }) : null;
    // A kind already broken once is marked as collected; a new kind shows its first-break bonus.
    const mark = o?.capabilities.destructible ? h("span", { class: `row-mark${this.collected(id) ? " done" : ""}`, text: this.collected(id) ? "✓" : "★", attrs: { title: this.collected(id) ? t("shop.collected") : t("shop.newKind") } }) : null;
    const row = h(
      "button",
      { class: `shop-row${id === this.selected ? " on" : ""}${locked ? " locked" : ""}`, attrs: { type: "button", role: "option", "aria-selected": String(id === this.selected) } },
      this.thumb(model),
      h("span", { class: "row-name" }, name, mark),
      chip,
      h("span", { class: `row-price${affordable || badge || locked ? "" : " short"}`, text: badge || (locked ? "🔒" : price === 0 ? t("shop.free") : formatCredits(price)) }),
    );
    row.addEventListener("click", () => {
      this.selected = id;
      this.notice = "";
      this.render();
    });
    return row;
  }

  private purchaseArea(price: number, done: boolean, primary: HTMLButtonElement): HTMLElement {
    const missing = price - this.state.credits;
    const info =
      !done && missing > 0
        ? h("p", { class: "missing" }, t("shop.need", { price: formatCredits(price), have: formatCredits(this.state.credits) }), h("strong", { text: t("shop.missing", { missing: formatCredits(missing) }) }))
        : null;
    return h("div", { class: "buy" }, h("div", { class: "price", text: price === 0 ? t("shop.free") : formatCredits(price) }), primary, info, this.notice ? h("p", { class: "notice", text: this.notice }) : null);
  }

  private toolDetail(id: string): HTMLElement[] {
    const tl = TOOLS[id];
    if (!tl) return [];
    const owned = this.state.ownedTools.includes(id);
    const equipped = this.state.equippedToolId === id;
    const waiting = this.state.toolDeliveries.some((d) => d.toolId === id);
    let primary: HTMLButtonElement;
    if (equipped || waiting) {
      primary = button(equipped ? t("shop.equipped") : t("shop.awaiting"), () => undefined);
      primary.disabled = true;
    } else if (owned) {
      primary = button(t("shop.owned"), () => this.act(() => this.actions.equipTool(id), toolName(id)), "primary");
    } else {
      primary = button(t("shop.buy"), () => this.act(() => this.actions.buyTool(id), t("shop.boughtTool", { name: toolName(id) })), "primary");
      primary.disabled = this.state.credits < tl.price;
    }
    const bonuses = (Object.entries(tl.affinity) as [MaterialType, number][])
      .filter(([, v]) => (v ?? 1) > 1)
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .map(([m]) => matName(m));
    const opens = objectsOfTier(tl.tier);
    return [
      this.thumb(tl.model, true),
      h("h3", { class: "detail-name", text: toolName(id) }),
      h("p", { class: "tagline-sm", text: toolTagline(id) }),
      h(
        "div",
        { class: "unlocks" },
        h("div", { class: "unlocks-head", text: `${t("shop.toolLevel", { n: tl.tier })} · ${t("shop.toolBreaks", { n: tl.tier })}` }),
        h("div", { class: "unlocks-label", text: t("shop.toolOpens", { n: opens.length }) }),
        h("div", { class: "unlocks-list", text: opens.map(objectName).join(" · ") }),
      ),
      h("p", { class: "detail-desc", text: toolDescription(id) }),
      h(
        "div",
        { class: "stats" },
        statBar(t("shop.stat.damage"), kineticEnergy(tl.effectiveMass, tl.swingSpeed) / MAX_ENERGY),
        statBar(t("shop.stat.force"), (tl.effectiveMass * tl.swingSpeed) / MAX_FORCE),
        statBar(t("shop.stat.speed"), 1 / (tl.windup + tl.active + tl.recovery) / MAX_RATE),
        statBar(t("shop.stat.reach"), tl.reach / MAX_REACH),
        statBar(t("shop.stat.precision"), Math.min(1, 0.012 / tl.contactRadius)),
      ),
      bonuses.length ? h("p", { class: "bonus" }, h("span", { class: "stat-label", text: t("shop.bestAgainst") }), bonuses.join(" · ")) : null,
      this.purchaseArea(tl.price, owned || waiting, primary),
    ].filter((e): e is HTMLElement => e !== null);
  }

  private objectDetail(id: string): HTMLElement[] {
    const o = OBJECTS[id];
    if (!o) return [];
    const breakable = o.capabilities.destructible;
    const locked = breakable && o.tier > unlockedTier(this.state);
    const need = toolName(toolForTier(o.tier));
    const primary = button(locked ? t("shop.needTool", { tool: need.toLocaleUpperCase() }) : t("shop.buy"), () => this.act(() => this.actions.buyObject(id), t("shop.boughtObject", { name: objectName(id) })), "primary");
    primary.disabled = locked || this.state.credits < o.price;
    const first = breakable && !this.collected(id) ? firstBreakBonus(o) : 0;
    const earn = Math.round(o.value + cleanupPool(o)) + first;
    const usable = TOOL_IDS.filter((tid) => this.state.ownedTools.includes(tid) && canBreak(TOOLS[tid]?.tier ?? 1, o)).map(toolName);
    const materials = new Set<MaterialType>([o.material, ...(o.zones ?? []).map((z) => z.material)]);
    const facts: [string, string][] = [
      ...(breakable
        ? ([
            [t("shop.fact.level"), `${o.tier} · ${t("shop.fact.needs", { tool: need })}`],
            [t("shop.fact.earn"), `${formatCredits(earn)} (${t("shop.fact.profit", { credits: formatCredits(earn - o.price) })})`],
          ] as [string, string][])
        : []),
      [t("shop.fact.material"), [...materials].map(matName).join(" / ")],
      [t("shop.fact.weight"), `${o.mass} kg`],
      [t("shop.fact.durability"), o.capabilities.destructible ? grade(o.health, [80, 250, 600]) : t("shop.unbreakable")],
      [t("shop.fact.value"), o.value > 0 ? formatCredits(o.value) : t("shop.toy")],
      [t("shop.fact.breaks"), o.capabilities.destructible ? t(`pattern.${MATERIALS[o.material].pattern}` as TextKey) : "—"],
      [t("shop.fact.pieces"), o.capabilities.destructible ? String(majorPieceCount(o)) : "—"],
    ];
    return [
      this.thumb(o.model, true),
      h("h3", { class: "detail-name", text: objectName(id) }),
      h("p", { class: "detail-desc", text: objectDescription(id) }),
      h("dl", { class: "facts" }, ...facts.flatMap(([k, v]) => [h("dt", { text: k }), h("dd", { text: v })])),
      breakable
        ? h(
            "p",
            { class: `collect-note${locked ? " locked" : first > 0 ? " new" : ""}` },
            locked
              ? t("shop.locked", { tool: need, n: o.tier })
              : first > 0
                ? t("shop.firstBonus", { credits: formatCredits(first) })
                : t("shop.collectedLine", { tools: usable.join(", ") }),
          )
        : null,
      h(
        "p",
        { class: "tags" },
        ...[t("shop.tag.carry"), o.capabilities.throwable ? t("shop.tag.throw") : null, o.capabilities.standable ? t("shop.tag.stand") : null]
          .filter((x): x is string => x !== null)
          .map((x) => h("span", { class: "tag", text: x })),
      ),
      this.purchaseArea(o.price, locked, primary),
    ].filter((e): e is HTMLElement => e !== null);
  }

  /** Purchases are single transactions: a double click inside the lock window is ignored. */
  private unlocked(): boolean {
    const now = performance.now();
    if (now < this.lockedUntil) return false;
    this.lockedUntil = now + CLICK_LOCK_MS;
    return true;
  }

  private act(fn: () => Outcome, success: string): void {
    if (!this.unlocked()) return;
    const result = fn();
    this.notice = result.ok ? success : t("shop.notPossible", { reason: t(`refusal.${result.reason}`) });
    // The caller pushes the new state via update(); render immediately for the notice.
    this.render();
  }
}
