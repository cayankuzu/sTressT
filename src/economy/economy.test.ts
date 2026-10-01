import { describe, expect, it } from "vitest";
import { GAME } from "../config/gameConfig";
import { COLLECTIBLE_IDS, MAX_TIER, OBJECTS, TOOLS } from "../data/catalog";
import { checksum } from "../save/storage";
import { migrateLegacy, newSave, validateSaveData } from "../save/schema";
import {
  checkInvariants,
  claimFoundItem,
  cleanupPool,
  collectObject,
  comboMultiplier,
  equipTool,
  firstBreakBonus,
  grantReward,
  pickUpTool,
  pruneLedger,
  purchaseObject,
  purchaseTool,
  rewardWithCombo,
  stageReward,
} from "./economy";
import { defaultProgress, type ProgressState } from "./state";

const withCredits = (credits: number): ProgressState => ({ ...defaultProgress(), credits });
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe("economy", () => {
  it("pays a reward exactly once per key", () => {
    const first = ok(grantReward(withCredits(10), "brk:obj_000001:destroyed", 12.9));
    expect(first.state.credits).toBe(22);
    expect(first.state.statistics.creditsEarned).toBe(12);
    expect(grantReward(first.state, "brk:obj_000001:destroyed", 12)).toEqual({ ok: false, reason: "already_rewarded" });
    expect(ok(grantReward(first.state, "brk:obj_000001:broken", 3)).state.credits).toBe(25);
  });

  it("rejects negative, NaN and infinite rewards", () => {
    for (const bad of [-5, NaN, Infinity]) expect(grantReward(withCredits(0), "k:x", bad).ok).toBe(false);
  });

  it("delivers a bought tool to the bench; it is owned only once picked up", () => {
    const price = TOOLS.baseball_bat!.price;
    expect(purchaseTool(withCredits(price - 1), "baseball_bat")).toEqual({ ok: false, reason: "insufficient_funds", missing: 1 });
    const bought = ok(purchaseTool(withCredits(price), "baseball_bat"));
    expect(bought.state.credits).toBe(0);
    expect(bought.state.ownedTools).not.toContain("baseball_bat");
    expect(bought.state.toolDeliveries).toEqual([{ id: bought.deliveryId, toolId: "baseball_bat" }]);
    // Spam-clicking BUY: the second purchase is refused, nothing is charged twice.
    expect(purchaseTool({ ...bought.state, credits: 9999 }, "baseball_bat")).toEqual({ ok: false, reason: "awaiting_pickup" });
    const picked = ok(pickUpTool(bought.state, bought.deliveryId));
    expect(picked.state.ownedTools).toContain("baseball_bat");
    expect(picked.state.equippedToolId).toBe("baseball_bat");
    expect(picked.state.toolDeliveries).toEqual([]);
    expect(pickUpTool(picked.state, bought.deliveryId).ok).toBe(false);
    expect(purchaseTool({ ...picked.state, credits: 9999 }, "baseball_bat")).toEqual({ ok: false, reason: "already_owned" });
    expect(purchaseTool(withCredits(9999), "laser_sword").ok).toBe(false);
  });

  it("does not mutate the input state", () => {
    const start = withCredits(1000);
    purchaseTool(start, "baseball_bat");
    purchaseObject(start, "crt_tv");
    grantReward(start, "x:y", 5);
    expect(start.credits).toBe(1000);
    expect(start.toolDeliveries).toEqual([]);
    expect(start.rewardLedger).toEqual([]);
  });

  it("equips only owned tools", () => {
    expect(equipTool(defaultProgress(), "sledgehammer").ok).toBe(false);
    const bought = ok(purchaseTool(withCredits(5000), "sledgehammer"));
    expect(equipTool(bought.state, "sledgehammer").ok).toBe(false);
    const owned = ok(pickUpTool(bought.state, bought.deliveryId)).state;
    expect(ok(equipTool(owned, "sledgehammer")).state.equippedToolId).toBe("sledgehammer");
  });

  it("gives every bought object a new id, never reused", () => {
    const price = OBJECTS.crt_tv!.price;
    const a = ok(purchaseObject({ ...withCredits(price * 2), ownedTools: ["fists", "sledgehammer"] }, "crt_tv"));
    const b = ok(purchaseObject(a.state, "crt_tv"));
    expect(a.objectId).not.toBe(b.objectId);
    expect(b.state.credits).toBe(0);
    expect(purchaseObject(b.state, "crt_tv")).toEqual({ ok: false, reason: "insufficient_funds", missing: price });
    expect(purchaseObject(withCredits(9999), "nope").ok).toBe(false);
  });

  it("only sells what the player's tools can break (a tool waiting on the bench counts)", () => {
    const rich = withCredits(99999);
    expect(purchaseObject(rich, "tea_cup").ok).toBe(true);
    expect(purchaseObject(rich, "wooden_chair")).toEqual({ ok: false, reason: "tool_required" });
    expect(purchaseObject({ ...rich, ownedTools: ["fists", "baseball_bat"] }, "wooden_chair").ok).toBe(true);
    expect(purchaseObject({ ...rich, toolDeliveries: [{ id: "dlv_000001", toolId: "baseball_bat" }] }, "wooden_chair").ok).toBe(true);
    expect(purchaseObject({ ...rich, ownedTools: ["fists", "baseball_bat"] }, "marble_bust").ok).toBe(false);
    // Toys never break, so they need no tool.
    expect(purchaseObject(rich, "rubber_duck").ok).toBe(true);
  });

  it("pays the first-break bonus once per kind and the collection bonus once, with the last kind", () => {
    const first = ok(collectObject(defaultProgress(), "tea_cup"));
    expect(first.amount).toBe(firstBreakBonus(OBJECTS.tea_cup!));
    expect(first.state.credits).toBe(first.amount);
    expect(collectObject(first.state, "tea_cup")).toEqual({ ok: false, reason: "already_collected" });
    expect(collectObject(first.state, "rubber_duck").ok).toBe(false);
    let s = defaultProgress();
    let completes = 0;
    for (const id of COLLECTIBLE_IDS) {
      const r = ok(collectObject(s, id));
      if (r.complete) {
        completes++;
        expect(r.bonus).toBe(GAME.economy.collectionBonus);
      } else expect(r.bonus).toBe(0);
      s = r.state;
    }
    expect(completes).toBe(1);
    expect(checkInvariants(s)).toEqual([]);
  });

  it("claims a street find only once", () => {
    const once = ok(claimFoundItem(defaultProgress(), "found_road_chair"));
    expect(claimFoundItem(once.state, "found_road_chair")).toEqual({ ok: false, reason: "already_claimed" });
  });

  it("delivers objects left in the former storage of an old save, never twice", () => {
    const save = newSave("pro_0123456789abcdef", 0, "T", "sav_0123456789abcdef") as unknown as Record<string, unknown>;
    const progress = save.progress as Record<string, unknown>;
    progress.storage = [
      { id: "obj_000007", definitionId: "tea_cup", origin: "found" },
      { id: "obj_000007", definitionId: "tea_cup", origin: "found" },
      { id: "obj_000008", definitionId: "no_such_object", origin: "purchased" },
    ];
    const v = validateSaveData(save);
    expect(v?.returning).toEqual([{ id: "obj_000007", definitionId: "tea_cup", origin: "found" }]);
    expect(v?.progress.counters.object).toBe(7);
    expect("storage" in (v?.progress ?? {})).toBe(false);
    // A save written after the delivery has the object in the world: nothing comes again.
    expect(validateSaveData(newSave("pro_0123456789abcdef", 0, "T", "sav_0123456789abcdef"))?.returning).toBeUndefined();
  });

  it("prunes ledger keys of things that no longer exist", () => {
    let s = defaultProgress();
    s = ok(grantReward(s, "brk:obj_000001:broken", 1)).state;
    s = ok(grantReward(s, "cln:obj_000002.d1", 1)).state;
    const pruned = pruneLedger(s, new Set(["obj_000001"]));
    expect(pruned.rewardLedger).toEqual(["brk:obj_000001:broken"]);
  });

  it("keeps its invariants", () => {
    expect(checkInvariants(defaultProgress())).toEqual([]);
    expect(checkInvariants({ ...defaultProgress(), credits: -1 })).not.toEqual([]);
    expect(checkInvariants({ ...defaultProgress(), credits: 1.5 })).not.toEqual([]);
    expect(checkInvariants({ ...defaultProgress(), rewardLedger: ["a:b", "a:b"] })).not.toEqual([]);
  });
});

describe("rewards", () => {
  it("splits an object's break value across the damaged, broken and destroyed stages", () => {
    for (const def of Object.values(OBJECTS)) {
      expect(stageReward(def, "damaged") + stageReward(def, "broken") + stageReward(def, "destroyed")).toBe(def.value);
    }
    expect(stageReward(OBJECTS.crt_tv!, "destroyed")).toBeGreaterThan(stageReward(OBJECTS.crt_tv!, "broken"));
  });

  it("pays better for every level up, so the next tool is always worth buying", () => {
    const roi = (tier: number): number => {
      const defs = Object.values(OBJECTS).filter((d) => d.capabilities.destructible && d.tier === tier && d.price > 0);
      return defs.reduce((sum, d) => sum + d.value / d.price, 0) / defs.length;
    };
    for (let tier = 2; tier <= MAX_TIER; tier++) expect(roi(tier), `level ${tier}`).toBeGreaterThan(roi(tier - 1));
  });

  it("always pays less for cleaning up than for breaking", () => {
    for (const def of Object.values(OBJECTS)) {
      if (!def.capabilities.destructible) continue;
      expect(cleanupPool(def)).toBeLessThan(stageReward(def, "broken") + stageReward(def, "destroyed"));
    }
  });

  it("earns back more than an object costs when it is broken and cleaned up", () => {
    for (const def of Object.values(OBJECTS)) {
      if (!def.capabilities.destructible || def.price <= 0) continue;
      expect(def.value + cleanupPool(def)).toBeGreaterThan(def.price);
    }
  });

  it("caps the combo multiplier", () => {
    expect(comboMultiplier(1)).toBe(1);
    expect(comboMultiplier(100)).toBeLessThanOrEqual(1.6);
    expect(rewardWithCombo(10, 0)).toBe(10);
    expect(rewardWithCombo(NaN, 3)).toBe(0);
  });
});

describe("save data", () => {
  it("returns null for garbage and other versions", () => {
    for (const bad of [null, 42, "x", [], {}, { schemaVersion: 2 }]) expect(validateSaveData(bad)).toBeNull();
  });

  it("round-trips a new game", () => {
    const save = newSave("pro_0123456789abcdef", 1, "Test", "sav_0123456789abcdef");
    const back = validateSaveData(structuredClone(save));
    expect(back).not.toBeNull();
    expect(back?.objects.length).toBe(save.objects.length);
    expect(back?.progress).toEqual(save.progress);
  });

  it("sanitises invalid credits, tools, objects and duplicates", () => {
    const save = newSave("pro_0123456789abcdef", 0, "Test", "sav_0123456789abcdef") as unknown as Record<string, unknown>;
    const progress = save.progress as Record<string, unknown>;
    progress.credits = -50;
    progress.ownedTools = ["laser", "baseball_bat", "baseball_bat"];
    progress.equippedToolId = "laser";
    const objects = save.objects as Record<string, unknown>[];
    objects.push({ ...objects[0], definitionId: "unicorn", id: "bad_one" });
    objects.push({ ...objects[0] });
    objects.push({ ...objects[1], position: [NaN, 0, 0], id: "nan_pos" });
    const v = validateSaveData(save);
    expect(v?.progress.credits).toBe(0);
    expect(v?.progress.ownedTools).toEqual(["fists", "baseball_bat"]);
    expect(v?.progress.equippedToolId).toBe("fists");
    expect(v?.objects.length).toBe(objects.length - 3);
  });

  it("never resumes a break session after a reload", () => {
    const save = { ...newSave("pro_0123456789abcdef", 0, "T", "sav_0123456789abcdef"), mode: "break" };
    expect(validateSaveData(save)?.mode).toBe("cleanup");
  });

  it("keeps the id counter ahead of every existing object", () => {
    const save = newSave("pro_0123456789abcdef", 0, "T", "sav_0123456789abcdef");
    save.objects.push({ ...save.objects[0]!, id: "obj_000041" });
    expect(validateSaveData(save)?.progress.counters.object).toBe(41);
  });

  it("migrates an old single save keeping credits, tools and the layout", () => {
    const legacy = {
      version: 2,
      credits: 640,
      ownedTools: ["fists", "frying_pan"],
      equippedToolId: "frying_pan",
      objectInventory: { tea_cup: 2 },
      roomLayout: [
        { instanceId: "starter_vase", definitionId: "ceramic_vase_01", position: [0, 0, 1], rotationY: 0 },
        { instanceId: "crt_tv_001", definitionId: "crt_tv", position: [1, 0, 0], rotationY: 90 },
      ],
    };
    const save = migrateLegacy(legacy, "pro_0123456789abcdef", 0, "sav_0123456789abcdef", "Eski");
    expect(save?.progress.credits).toBe(640);
    expect(save?.progress.ownedTools).toContain("frying_pan");
    expect(save?.objects.map((o) => o.definitionId).sort()).toEqual(["ceramic_vase_01", "crt_tv"]);
    expect(save?.returning?.map((o) => o.definitionId)).toEqual(["tea_cup", "tea_cup"]);
  });

  it("detects any change with the checksum, including inside geometry", () => {
    const a = { x: 1, geo: new Float32Array([1, 2, 3]) };
    const b = { x: 1, geo: new Float32Array([1, 2, 3.0001]) };
    expect(checksum(a)).toBe(checksum({ geo: new Float32Array([1, 2, 3]), x: 1 }));
    expect(checksum(a)).not.toBe(checksum(b));
  });
});
