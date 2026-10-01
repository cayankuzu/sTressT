import { GAME } from "../config/gameConfig";
import { OBJECTS } from "../data/catalog";
import type { StoredObject } from "../economy/state";
import { button, h } from "./dom";
import { objectName, t } from "./i18n";
import type { Thumbnails } from "./thumbnails";

/** Storage: intact objects taken out of the room. Picking one starts placing it in the room. */
export function storageView(items: StoredObject[], inRoom: number, thumbs: Thumbnails, actions: { place(id: string): void; close(): void }): HTMLElement {
  const full = inRoom >= GAME.session.roomCapacity;
  const list = h("div", { class: "inv-grid" });
  for (const item of items) {
    const def = OBJECTS[item.definitionId];
    if (!def) continue;
    const thumb = h("div", { class: "thumb" });
    void thumbs.get(def.model).then((canvas) => {
      const c = h("canvas", { attrs: { width: String(canvas.width), height: String(canvas.height), "aria-hidden": "true" } });
      c.getContext("2d")?.drawImage(canvas, 0, 0);
      thumb.replaceChildren(c);
    });
    const place = button(t("storage.place"), () => actions.place(item.id), "primary");
    place.disabled = full;
    list.append(h("div", { class: "inv-item" }, thumb, h("span", { class: "row-name", text: objectName(item.definitionId) }), place));
  }
  const el = h(
    "div",
    { class: "screen dim" },
    h(
      "div",
      { class: "dialog wide", attrs: { role: "dialog", "aria-label": t("storage.title") } },
      h("h2", { class: "dialog-title", text: t("storage.title") }),
      h("p", { class: `muted small${full ? " error" : ""}`, text: t("storage.capacity", { n: inRoom, max: GAME.session.roomCapacity }) }),
      items.length === 0 ? h("p", { class: "muted", text: t("storage.empty") }) : null,
      list,
      h("div", { class: "dialog-actions" }, button(t("common.close"), actions.close, "primary")),
    ),
  );
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") actions.close();
  });
  return el;
}
