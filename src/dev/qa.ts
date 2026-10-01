// Dev-only QA harness (not referenced by the game, so never bundled). In the dev console:
//   const qa = await import("/src/dev/qa.ts");
//   await qa.objectAudit(["wooden_chair", "crt_tv"]);
// It drives the real game through window.__stresst: real swings, real grabs, real physics.
import { Quaternion, Vector3 } from "three";
import { GAME } from "../config/gameConfig";
import { canBreak, OBJECTS, TOOL_IDS, TOOLS, toolForTier } from "../data/catalog";
import { checkInvariants } from "../economy/economy";
import { soupStats } from "../destruction/geometry/soup";
import { ROOM, TRASH } from "../world/layout";

// The dev handle exposes the live game objects untyped on purpose.
type Handle = any;

const h = (): Handle => (window as unknown as { __stresst: Handle }).__stresst;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Point inside the room where every test object is spawned. */
const ARENA = new Vector3(0, 0.002, -10.6);
const [OX, , OZ] = ROOM.origin;

function tilt(q: { x: number; z: number }): number {
  return (Math.acos(Math.min(1, 1 - 2 * (q.x * q.x + q.z * q.z))) * 180) / Math.PI;
}

function aimAt(x: number, y: number, z: number): void {
  const c = h().game.camera.position;
  h().look(Math.atan2(-(x - c.x), -(z - c.z)), Math.atan2(y - c.y, Math.hypot(x - c.x, z - c.z)));
}

function insideRoom(p: { x: number; y: number; z: number }): boolean {
  return Math.abs(p.x - OX) < ROOM.width / 2 + 0.05 && p.z > OZ - ROOM.depth / 2 - 0.05 && p.z < OZ + ROOM.depth / 2 + 0.05 && p.y > -0.05 && p.y < ROOM.height + 0.05;
}

function finite(o: any): boolean {
  const b = o?.body;
  if (!b) return true;
  const t = b.translation();
  const v = b.linvel();
  return [t.x, t.y, t.z, v.x, v.y, v.z].every(Number.isFinite);
}

/** Fracture runs in a worker: let its results arrive between simulation bursts. */
/**
 * Harness runs play in a profile of their own ("QA"), never in a player's slots: switching to it
 * starts a fresh game in its third slot.
 */
async function qaGame(): Promise<void> {
  const H = h();
  const qa = H.profiles.meta.profiles.find((p: any) => p.name === "QA") ?? H.profiles.create("QA");
  if (!qa) throw new Error("no free profile for QA");
  if (H.profiles.active?.id === qa.id && H.game.state === "playing") return;
  H.profiles.select(qa.id);
  await H.newGame(2);
  await wait(800);
}

/**
 * Counts pauses while a harness runs. The pane is shared with the player: a click that captures
 * and releases the mouse pauses the game, and swings made while paused do nothing. A run with
 * pauses is not a valid result.
 */
function watchPauses(): () => number {
  const g = h().game;
  let pauses = 0;
  g.pause = (...args: unknown[]) => {
    pauses++;
    return Object.getPrototypeOf(g).pause.apply(g, args);
  };
  return () => {
    delete g.pause;
    return pauses;
  };
}

async function run(seconds: number): Promise<void> {
  const chunks = Math.max(1, Math.round(seconds / 0.25));
  for (let i = 0; i < chunks; i++) {
    h().advance(seconds / chunks);
    await wait(15);
  }
}

async function freshArena(definitionId: string): Promise<any> {
  const g = h().game;
  g.grab.release();
  g.arrange.cancel();
  if (g.mode !== "arrange") h().mode("arrange");
  h().destruction.clearWorld();
  h().teleport(0, 0, -7.6, 0);
  await run(0.3);
  const obj = await h().destruction.spawn({ id: `qa_${definitionId}`, definitionId, origin: "purchased", position: ARENA.clone(), rotation: new Quaternion() });
  await run(2);
  return obj;
}

/** Centre of the biggest part still standing (what a player would swing at), in world space. */
function remainingCentre(obj: any): Vector3 {
  let best: any = null;
  for (const p of obj.parts) if (!best || p.area > best.area) best = p;
  const min = best.stats.min as number[];
  const max = best.stats.max as number[];
  const local = new Vector3(((min[0] as number) + (max[0] as number)) / 2, Math.min(((min[1] as number) + (max[1] as number)) / 2, 1.2), ((min[2] as number) + (max[2] as number)) / 2);
  return local.applyQuaternion(obj.currQuat).add(obj.currPos);
}

/** Stands the player `dist` metres in front of what is left of the object and aims at it. */
function faceObject(obj: any, dist: number): void {
  const c = remainingCentre(obj);
  h().teleport(c.x, 0, c.z + dist + obj.template.size[2] / 2, 0);
  h().advance(1 / 60);
  aimAt(c.x, c.y, c.z);
  h().advance(1 / 60);
}

export type ObjectRow = Record<string, unknown>;

/** One full pass over one object definition. */
async function auditOne(id: string, tools: string[]): Promise<ObjectRow> {
  const H = h();
  const g = H.game;
  const def = OBJECTS[id];
  if (!def) return { id, error: "unknown" };
  const row: ObjectRow = { id, mat: def.material, kg: def.mass };
  let obj = await freshArena(id);
  const t = obj.template;
  const st = soupStats(t.soup);
  row.size = t.size.map(r2).join("x");
  // Pivot: base at y = 0 and centred in x/z (within 15% of the footprint).
  row.pivot = Math.abs(st.min[1]) < 0.01 && Math.abs(t.center[0]) < t.size[0] * 0.15 + 0.01 && Math.abs(t.center[2]) < t.size[2] * 0.15 + 0.01 ? "ok" : `off(${r2(st.min[1])},${r2(t.center[0])},${r2(t.center[2])})`;
  row.parts = obj.parts.length;
  row.bodyKg = r2(obj.body.mass());

  // Rest and wake stability.
  const p0 = obj.body.translation();
  row.restTilt = r2(tilt(obj.body.rotation()));
  row.restSleep = obj.body.isSleeping();
  obj.body.wakeUp();
  let vmax = 0;
  for (let i = 0; i < 180; i++) {
    H.advance(1 / 60);
    const v = obj.body.linvel();
    vmax = Math.max(vmax, Math.hypot(v.x, v.y, v.z));
  }
  const p1 = obj.body.translation();
  row.wake = `${r2(tilt(obj.body.rotation()))}°/${r2(vmax)}m/s/${r2(Math.hypot(p1.x - p0.x, p1.z - p0.z))}m`;

  // Arrange: pick, move 1 m, commit; nothing may jump.
  g.arrange.begin(obj);
  H.teleport(1.0, 0, -9.0, 0);
  H.advance(1 / 60);
  aimAt(1.0, 0, -10.4);
  H.advance(2 / 60);
  const problem = g.arrange.state.problem;
  H.tap("attack");
  const committed = !g.arrange.busy;
  if (!committed) g.arrange.cancel();
  let jump = 0;
  for (let i = 0; i < 120; i++) {
    H.advance(1 / 60);
    const v = obj.body.linvel();
    jump = Math.max(jump, Math.hypot(v.x, v.y, v.z));
  }
  row.arrange = committed ? (jump > 0.3 ? `JUMP ${r2(jump)}` : "ok") : `refused:${problem}`;

  // Carry and drop (E), then throw (LMB) in cleanup mode.
  if (def.capabilities.grabbable && def.mass <= GAME.interaction.maxCarryMass) {
    faceObject(obj, 0.7);
    H.tap("interact");
    H.advance(0.4);
    const held = !!g.grab.holding;
    if (held) {
      for (let i = 0; i < 40; i++) {
        H.look(i * 0.08, -0.2);
        H.advance(1 / 60);
      }
      H.tap("interact");
      await run(2);
    }
    row.carry = held ? (finite(obj) && insideRoom(obj.body.translation()) ? "ok" : "BAD") : "FAIL";
    H.mode("cleanup");
    // Throw from a known spot: wherever the carry test dropped it does not matter here.
    obj.placeAt(ARENA.clone(), new Quaternion());
    H.destruction.settle(() => obj.body);
    await run(1);
    faceObject(obj, 0.7);
    H.tap("interact");
    H.advance(0.4);
    if (g.grab.holding) {
      H.teleport(0, 0, -8.0, 0);
      H.advance(1 / 60);
      H.look(0, 0.15);
      H.advance(0.2);
      H.tap("attack");
      let speed = 0;
      for (let i = 0; i < 20; i++) {
        H.advance(1 / 60);
        const v = obj.body.linvel();
        speed = Math.max(speed, Math.hypot(v.x, v.y, v.z));
      }
      await run(2.5);
      row.throw = `${r2(speed)}m/s ${insideRoom(obj.body.translation()) ? "in" : "OUT"}`;
    } else row.throw = "no grab";
    H.mode("arrange");
  } else row.carry = row.throw = "n/a";

  // Break with each tool, from a fresh copy every time.
  if (def.capabilities.destructible) {
    // Only tools of the object's level or higher can hurt it; the level's own tool is always tried.
    const usable = tools.filter((tool) => canBreak(TOOLS[tool]?.tier ?? 1, def));
    if (!usable.includes(toolForTier(def.tier))) usable.unshift(toolForTier(def.tier));
    for (const tool of usable) {
      obj = await freshArena(id);
      H.equip(tool);
      await run(0.3);
      H.mode("break");
      H.advance(0.2);
      let swings = 0;
      let hits = 0;
      const applyHit = H.destruction.applyHit;
      H.destruction.applyHit = (c: any, imp: any) => {
        if (H.destruction.ownerOf(c)?.obj?.instanceId === obj.instanceId) hits++;
        return applyHit.call(H.destruction, c, imp);
      };
      try {
        while (swings < 40 && H.destruction.get(obj.instanceId)?.alive) {
          const o = H.destruction.get(obj.instanceId);
          if (!o) break;
          faceObject(o, 0.55);
          H.attack();
          H.advance(0.05);
          H.release();
          for (let i = 0; i < 90 && g.tools.stage !== "idle"; i++) H.advance(1 / 60);
          swings++;
          await wait(5);
        }
      } finally {
        delete H.destruction.applyHit;
      }
      // Pieces at their peak (clutter fades once the room is cleared), then where they settle.
      let peak = 0;
      for (let i = 0; i < 8; i++) {
        await run(0.25);
        peak = Math.max(peak, H.destruction.debris.all().filter((f: any) => f.parentId === obj.instanceId).length);
      }
      await run(6);
      const pieces = H.destruction.debris.all().filter((f: any) => f.parentId === obj.instanceId);
      const majors = pieces.filter((f: any) => f.kind === "major" && f.state !== "disposed");
      const awake = majors.filter((f: any) => f.body && !f.body.isSleeping()).length;
      const outside = pieces.filter((f: any) => f.body && (!insideRoom(f.body.translation()) || !finite({ body: f.body })));
      const out = outside.length;
      if (out) row[`${tool}Out`] = outside.map((f: any) => `${f.kind}@${Object.values(f.body.translation()).map((v: any) => r2(v as number)).join(",")}`).join(" ");
      const heavy = majors.filter((f: any) => f.mass > GAME.interaction.maxGrabMass).length;
      const destroyed = !H.destruction.get(obj.instanceId);
      row[tool] = destroyed
        ? `${swings}sw/${hits}hit ${majors.length}maj/${peak}pc${heavy ? ` ${heavy}HEAVY` : ""}${awake ? ` ${awake}awake` : ""}${out ? ` ${out}OUT` : ""}`
        : `alive@${swings}sw/${hits}hit`;
      H.mode("cleanup");
      H.advance(0.2);
    }
  }
  return row;
}

export async function objectAudit(ids: string[] = Object.keys(OBJECTS), tools = ["fists", "baseball_bat", "sledgehammer"]): Promise<ObjectRow[]> {
  const H = h();
  H.autoPause(false);
  await qaGame();
  H.headless(true);
  H.credits(100000);
  for (const t of tools) H.progress.buyTool(t);
  H.pickUpAll();
  const rows: ObjectRow[] = [];
  try {
    for (const id of ids) {
      try {
        rows.push(await auditOne(id, tools));
      } catch (err) {
        const stack = String((err as Error).stack ?? "").split(String.fromCharCode(10)).slice(1, 6).join(" | ");
        rows.push({ id, error: `${String(err)} @ ${stack}` });
      }
    }
  } finally {
    H.headless(false);
  }
  return rows;
}


/** Movement: speeds, jump, fall, corners, and attempts to leave the map. */
export async function controllerAudit(): Promise<Record<string, unknown>> {
  const H = h();
  const g = H.game;
  await qaGame();
  H.autoPause(false);
  H.headless(true);
  const out: Record<string, unknown> = {};
  const p = g.player;
  const speedOver = (run: boolean): number => {
    H.teleport(0, 0, 2, Math.PI / 2);
    H.advance(0.2);
    if (run) H.key("run", true);
    H.key("forward", true);
    H.advance(1);
    const a = p.feet.clone();
    H.advance(1);
    const d = p.feet.distanceTo(a);
    H.key("forward", false);
    H.key("run", false);
    H.advance(0.5);
    return r2(d);
  };
  out.walk = speedOver(false);
  out.run = speedOver(true);
  // Jump height and landing.
  H.teleport(0, 0, 2, 0);
  H.advance(0.3);
  const y0 = p.feet.y;
  let top = y0;
  H.tap("jump");
  for (let i = 0; i < 90; i++) {
    H.advance(1 / 60);
    top = Math.max(top, p.feet.y);
  }
  out.jump = r2(top - y0);
  let landed = 0;
  const onLand = p.onLand;
  p.onLand = (s: number) => {
    landed = s;
    onLand(s);
  };
  H.teleport(0, 4, 2, 0);
  H.advance(2);
  p.onLand = onLand;
  out.fallLanding = `${r2(landed)}m/s grounded=${p.isGrounded}`;
  // Corners of the room: walk into each, then walk back out.
  const corners: [number, number][] = [
    [-3.8, -12.6],
    [3.8, -12.6],
    [-3.8, -7.0],
    [3.8, -7.0],
  ];
  const stuck: string[] = [];
  for (const [x, z] of corners) {
    H.teleport(x * 0.7, 0, -9.8 + (z + 9.8) * 0.7, 0);
    H.advance(0.2);
    const yaw = Math.atan2(-(x - p.feet.x), -(z - p.feet.z));
    H.look(yaw, 0);
    H.key("run", true);
    H.key("forward", true);
    H.advance(2);
    H.key("forward", false);
    H.key("back", true);
    H.advance(1);
    H.key("back", false);
    H.key("run", false);
    const f = p.feet;
    if (Math.hypot(f.x - x, f.z - z) < 0.6) stuck.push(`${x},${z}`);
  }
  out.cornerStuck = stuck.length ? stuck.join(" ") : "none";
  // Leaving the map: run at every boundary, also from the top of the container.
  const escapes: string[] = [];
  const tries: [number, number, number, number][] = [
    [0, 0, 5.5, Math.PI],
    [-2.0, 1.25, 5.88, Math.PI],
    [17, 0, 0, -Math.PI / 2],
    [-17, 0, 0, Math.PI / 2],
    [0, 0, -5.8, 0],
  ];
  for (const [x, y, z, yaw] of tries) {
    H.teleport(x, y, z, yaw);
    H.advance(0.2);
    H.look(yaw, 0);
    H.key("run", true);
    H.key("forward", true);
    for (let i = 0; i < 6; i++) {
      H.tap("jump");
      H.advance(0.5);
    }
    H.key("forward", false);
    H.key("run", false);
    const f = p.feet;
    const inStreet = Math.abs(f.x) < 18.2 && f.z > -6.6 && f.z < 6.6;
    const inRoom = Math.abs(f.x) < 4.1 && f.z < -6.4 && f.z > -12.9;
    if (!inStreet && !inRoom) escapes.push(`${r2(f.x)},${r2(f.y)},${r2(f.z)}`);
  }
  out.escapes = escapes.length ? escapes.join(" ") : "none";
  H.headless(false);
  return out;
}

/** Input spam and interrupted actions: the state machines must stay sane. */
export async function inputAudit(): Promise<Record<string, unknown>> {
  const H = h();
  const g = H.game;
  await qaGame();
  H.autoPause(false);
  H.headless(true);
  const out: Record<string, unknown> = {};
  const errors: string[] = [];
  const onError = (e: ErrorEvent): void => {
    errors.push(String(e.message));
  };
  window.addEventListener("error", onError);
  try {
    // E spam next to a grabbable object.
    await H.newGame(2);
    await wait(500);
    H.advance(1);
    const vase = H.destruction.get("starter_vase");
    const c = vase.currPos;
    H.teleport(c.x, 0, c.z + 0.9, 0);
    H.advance(0.1);
    aimAt(c.x, 0.2, c.z);
    H.advance(0.05);
    for (let i = 0; i < 31; i++) H.tap("interact");
    H.advance(0.3);
    out.eSpam = `holding=${!!g.grab.holding} objects=${[...H.destruction.all()].length}`;
    g.grab.release();
    // TAB spam and mode bar.
    H.teleport(0, 0, -9, 0);
    H.advance(0.3);
    for (let i = 0; i < 25; i++) H.tap("mode");
    H.advance(5);
    out.tabSpam = `bar=${!!g.modeBar} mode=${g.mode}`;
    // LMB spam in break mode.
    H.mode("break");
    H.advance(0.2);
    for (let i = 0; i < 40; i++) H.tap("attack");
    H.advance(2);
    out.lmbSpam = `stage=${g.tools.stage}`;
    // Pause spam: pause/resume alternately, ending resumed.
    for (let i = 0; i < 20; i++) {
      g.pause();
      await g.resume();
    }
    out.pauseSpam = `state=${g.state} overlays=${document.querySelectorAll(".overlay:not([hidden])").length}`;
    // Interrupted: grab then pause then resume.
    H.mode("cleanup");
    H.advance(0.2);
    const cup = H.destruction.get("starter_cup");
    const cc = cup?.currPos;
    if (cc) {
      H.teleport(cc.x, 0, cc.z + 0.8, 0);
      H.advance(0.1);
      aimAt(cc.x, cc.y + 0.03, cc.z);
      H.advance(0.05);
      H.tap("interact");
      H.advance(0.2);
      const held = !!g.grab.holding;
      g.pause();
      await g.resume();
      H.advance(0.3);
      out.grabPause = `held=${held} after=${!!g.grab.holding} cupOk=${finite(cup)}`;
      // Grab then change mode: must let go cleanly.
      H.mode("arrange");
      H.advance(0.3);
      out.grabMode = `holding=${!!g.grab.holding} cupOk=${finite(cup)}`;
    }
    // Swing then pause mid-swing.
    H.mode("break");
    H.advance(0.2);
    H.attack();
    H.advance(0.08);
    H.release();
    g.pause();
    const pausedStage = g.tools.stage;
    await g.resume();
    H.advance(1.5);
    out.swingPause = `${pausedStage}->${g.tools.stage}`;
    // Arrange placement then pause: the ghost must go back.
    H.mode("cleanup");
    H.advance(0.1);
    H.mode("arrange");
    H.advance(0.1);
    const chair = H.destruction.get("starter_chair");
    g.arrange.begin(chair);
    g.pause();
    await g.resume();
    H.advance(0.5);
    out.arrangePause = `busy=${g.arrange.busy} chairEnabled=${chair.body.isEnabled()}`;
    // Save and load straight after a throw.
    const box = H.destruction.get("starter_box");
    H.teleport(box.currPos.x, 0, box.currPos.z + 0.8, 0);
    H.advance(0.1);
    aimAt(box.currPos.x, 0.17, box.currPos.z);
    H.advance(0.05);
    H.tap("interact");
    H.advance(0.2);
    H.look(0, 0.2);
    H.advance(0.05);
    H.mode("cleanup");
    H.tap("attack");
    await H.saves.flush(true);
    await H.load(2);
    await wait(600);
    H.advance(2);
    const objs = [...H.destruction.all()];
    out.throwSaveLoad = `objects=${objs.length} allFinite=${objs.every(finite)} state=${g.state}`;
  } finally {
    window.removeEventListener("error", onError);
    H.headless(false);
  }
  out.errors = errors.length ? errors : "none";
  return out;
}

/**
 * Scripted playthrough of the whole loop with real inputs (aiming and walking are shortened with
 * teleports): find, carry, arrange, break, clean up, shop, deliver, break again, save, load.
 */
export async function playthrough(): Promise<Record<string, unknown>> {
  const H = h();
  const g = H.game;
  H.autoPause(false);
  await qaGame();
  const pauses = watchPauses();
  const errors: string[] = [];
  const onError = (e: ErrorEvent): void => {
    errors.push(String(e.message));
  };
  window.addEventListener("error", onError);
  const out: Record<string, unknown> = {};
  const credits = (): number => H.progress.state.credits;
  const face = (p: { x: number; y: number; z: number }, dist: number, y = 0.3): void => {
    H.teleport(p.x, 0, p.z + dist, 0);
    H.advance(0.1);
    aimAt(p.x, p.y + y, p.z);
    H.advance(1 / 60);
  };
  /** Walks (really walks: carrying survives) through the given points. */
  const walk = (...points: [number, number][]): void => {
    for (const [x, z] of points) {
      for (let i = 0; i < 600; i++) {
        const f = g.player.feet;
        const dx = x - f.x;
        const dz = z - f.z;
        if (Math.hypot(dx, dz) < 0.3) break;
        H.look(Math.atan2(-dx, -dz), -0.25);
        H.key("forward", true);
        H.advance(1 / 60);
      }
      H.key("forward", false);
    }
    H.advance(0.2);
  };
  const disposeAll = async (): Promise<number> => {
    // Counted by the game itself: in a pile the aim may pick a different piece than planned.
    const before = g.cleanup.disposed;
    for (let guard = 0; guard < 40; guard++) {
      const piece = H.destruction.debris.majors().find((f: any) => f.mass <= GAME.interaction.maxGrabMass && f.state === "active");
      if (!piece) break;
      face(piece.currPos, 0.8, 0.05);
      H.tap("interact");
      H.advance(0.2);
      if (!g.grab.holding) {
        // Could not reach it (wedged under something): nudge it free and try again.
        piece.body?.setTranslation({ x: piece.currPos.x, y: 0.3, z: piece.currPos.z + 0.3 }, true);
        await run(0.5);
        continue;
      }
      // Out of the room on foot (teleporting would drop what is carried), to the container.
      if (g.location === "room") walk([0, -8.2], [0, -6.0]);
      walk([TRASH.x, TRASH.z - 1.6]);
      aimAt(TRASH.x, 1.45, TRASH.z);
      H.advance(0.4);
      H.tap("interact");
      await run(2);
    }
    return g.cleanup.disposed - before;
  };
  try {
    await H.newGame(2);
    await wait(800);
    H.headless(true);
    await run(1);
    const start = credits();

    // 1. A street find carried into the room and placed with the ghost.
    const box = H.destruction.get("found_road_box");
    face(box.currPos, 0.8, 0.17);
    H.tap("interact");
    H.advance(0.3);
    const carried = !!g.grab.holding;
    walk([0, -5.6], [0, -8.3]);
    aimAt(1.5, 0, -9.6);
    H.advance(0.05);
    H.tap("attack");
    H.advance(0.1);
    aimAt(1.5, 0, -9.6);
    H.advance(2 / 60);
    H.tap("attack");
    await run(1);
    out.findPlaced = carried && !g.arrange.busy && Math.abs(box.currPos.z + 9.6) < 0.4;

    // 2. Break everything in the room with fists.
    H.teleport(0, 0, -9, 0);
    H.advance(0.2);
    H.mode("break");
    H.advance(0.2);
    for (let guard = 0; guard < 200 && g.mode === "break"; guard++) {
      const target = g.breakablesInRoom()[0];
      if (!target) break;
      faceObject(target, 0.55);
      H.attack();
      H.advance(0.05);
      H.release();
      for (let i = 0; i < 60 && g.tools.stage !== "idle"; i++) H.advance(1 / 60);
      await wait(5);
    }
    await run(6);
    const afterBreak = credits();
    out.breakCredits = afterBreak - start;
    out.modeAfterBreak = g.mode;

    // 3. Clean up: every liftable piece into the container.
    if (g.mode !== "cleanup") H.mode("cleanup");
    const pieces = H.destruction.debris.majors().length;
    const disposed = await disposeAll();
    out.cleanup = `${disposed}/${pieces} pieces, +${credits() - afterBreak} CR`;

    // 4. Shop: buy the bat, take it from the bench.
    H.credits(Math.max(0, 300 - credits()));
    const bought = H.progress.buyTool("baseball_bat");
    await g.bench.show(H.progress.state.toolDeliveries);
    const handles = [...g.bench.byHandle.keys()];
    let spot: any = null;
    g.ctx.physics.world.colliders.forEach((c: any) => {
      if (handles.includes(c.handle)) spot = c.translation();
    });
    H.teleport(spot.x, 0, spot.z + 1, 0);
    H.advance(0.2);
    aimAt(spot.x, spot.y, spot.z);
    H.advance(0.05);
    H.tap("interact");
    await run(0.5);
    out.batTaken = bought.ok && H.progress.state.ownedTools.includes("baseball_bat") && H.progress.state.equippedToolId === "baseball_bat";

    // 5. Buy a chair, carry it in, break it with the bat, clean up.
    H.credits(200);
    const r = H.progress.buyObject("wooden_chair");
    await g.deliverObject(r.objectId, "wooden_chair");
    await run(1);
    const chair = H.destruction.get(r.objectId);
    face(chair.currPos, 0.8, 0.5);
    H.mode("arrange");
    H.tap("interact");
    H.advance(0.3);
    walk([chair.currPos.x, -3.0], [0, -5.6], [0, -8.3]);
    aimAt(-1.5, 0, -10.5);
    H.tap("attack");
    H.advance(0.1);
    aimAt(-1.5, 0, -10.5);
    H.advance(2 / 60);
    H.tap("attack");
    await run(1);
    H.teleport(0, 0, -9, 0);
    H.advance(0.2);
    H.mode("break");
    H.advance(0.2);
    let swings = 0;
    for (; swings < 20 && H.destruction.get(r.objectId)?.alive; swings++) {
      // Aim at what is left of it: a chair knocked over lies low, and a fixed height misses it.
      faceObject(H.destruction.get(r.objectId), 0.6);
      H.attack();
      H.advance(0.05);
      H.release();
      for (let i = 0; i < 60 && g.tools.stage !== "idle"; i++) H.advance(1 / 60);
      await wait(5);
    }
    await run(6);
    out.chairWithBat = `${swings} swings, destroyed=${!H.destruction.get(r.objectId)}, placedInRoom=${g.location === "room"}`;
    if (g.mode !== "cleanup") H.mode("cleanup");
    out.chairCleanup = `${await disposeAll()} pieces`;

    // 6. Save, load, compare.
    // The ledger is pruned to live ids when a save is taken: compare everything else.
    const before = { credits: credits(), objects: [...H.destruction.all()].length, majors: H.destruction.debris.majors().length, tools: H.progress.state.ownedTools.length };
    await H.saves.flush(true);
    await H.load(2);
    await wait(800);
    H.advance(1);
    const after = { credits: credits(), objects: [...H.destruction.all()].length, majors: H.destruction.debris.majors().length, tools: H.progress.state.ownedTools.length };
    out.saveLoad = JSON.stringify(before) === JSON.stringify(after) ? "identical" : `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`;
    const broken = checkInvariants(H.progress.state);
    out.invariants = broken.length ? broken : "ok";
  } finally {
    window.removeEventListener("error", onError);
    H.headless(false);
    const n = pauses();
    if (n > 0) out.INVALID = `the game was paused ${n} time(s) during the run (mouse captured and released in the pane): run it again`;
  }
  out.errors = errors.length ? errors : "none";
  return out;
}

/**
 * What the physics checks cannot see: every tool really swings in the hands (fists take turns),
 * the kick shows the boot, and the street container answers both a piece (pay popup) and a whole
 * object (a toast saying why it stays).
 */
export async function feedbackAudit(): Promise<Record<string, unknown>> {
  const H = h();
  const g = H.game;
  H.autoPause(false);
  await qaGame();
  H.headless(true);
  const out: Record<string, unknown> = {};
  const popups: string[] = [];
  const toasts: string[] = [];
  const hud = g.hud;
  const popup = hud.popup;
  const toast = hud.showToast;
  hud.popup = (text: string, label: string, ...rest: unknown[]) => {
    popups.push(`${text} ${label}`);
    return popup.call(hud, text, label, ...rest);
  };
  hud.showToast = (text: string, ...rest: unknown[]) => {
    toasts.push(text);
    return toast.call(hud, text, ...rest);
  };
  try {
    H.credits(100000);
    for (const id of TOOL_IDS) if (!H.progress.state.ownedTools.includes(id)) H.progress.buyTool(id);
    H.pickUpAll();
    H.teleport(0, 0, -8.2, 0);
    H.look(0, 0);
    H.advance(0.3);
    H.mode("break");
    H.advance(0.6);
    const vm = g.viewmodel;
    /** Largest move (m) and turn (1 - |dot|) of a hand during one swing. */
    const swing = (hand: any): [number, number] => {
      // A kick or swing still running would swallow this one.
      for (let i = 0; i < 120 && (g.tools.stage !== "idle" || g.kick.stage !== "idle"); i++) H.advance(1 / 60);
      const p0 = hand.position.clone();
      const q0 = hand.quaternion.clone();
      let dp = 0;
      let dq = 0;
      H.attack();
      for (let i = 0; i < 80; i++) {
        H.advance(1 / 60);
        if (i === 2) H.release();
        dp = Math.max(dp, hand.position.distanceTo(p0));
        dq = Math.max(dq, 1 - Math.abs(hand.quaternion.dot(q0)));
      }
      for (let i = 0; i < 60 && g.tools.stage !== "idle"; i++) H.advance(1 / 60);
      return [dp, dq];
    };
    const tools: Record<string, string> = {};
    for (const id of TOOL_IDS) {
      await H.equip(id);
      H.advance(0.5);
      const [dp, dq] = swing(vm.holder);
      let row = `${r2(dp)}m/${r2(dq)}`;
      if (id === "fists") {
        const [lp] = swing(vm.leftHolder);
        row += ` left ${r2(lp)}m`;
        if (lp < 0.1) row += " LEFT STILL";
      }
      tools[id] = dp < 0.1 ? `STILL ${row}` : row;
    }
    out.tools = tools;
    H.kick();
    let boot = false;
    for (let i = 0; i < 40; i++) {
      H.advance(1 / 60);
      if (i === 2) H.key("kick", false);
      boot ||= vm.boot.visible;
    }
    out.kickBoot = boot ? "shown" : "NOT SHOWN";

    // A piece in the container: one popup with the cleanup label, as much as the credits went up.
    await H.equip("sledgehammer");
    H.advance(0.3);
    const vase = await H.destruction.spawn({ id: `qa_fb_vase_${Date.now()}`, definitionId: "ceramic_vase_01", origin: "purchased", position: new Vector3(0, 0.002, -9.6), rotation: new Quaternion() });
    await run(1);
    for (let s = 0; s < 8 && vase?.alive; s++) {
      faceObject(vase, 1.2);
      H.attack();
      H.advance(0.05);
      H.release();
      for (let i = 0; i < 90 && g.tools.stage !== "idle"; i++) H.advance(1 / 60);
    }
    await run(2);
    H.mode("cleanup");
    H.advance(0.3);
    const pieces = H.destruction.debris.majors().filter((f: any) => f.state === "active" && f.body);
    const before = H.progress.state.credits;
    popups.length = 0;
    pieces.forEach((f: any, i: number) => {
      f.body.setTranslation({ x: TRASH.x - 0.3 + (i % 3) * 0.3, y: TRASH.floorY + 0.4 + Math.floor(i / 3) * 0.2, z: TRASH.z }, true);
      f.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    });
    await run(3);
    const gained = H.progress.state.credits - before;
    const label = popups.filter((p) => p.endsWith(" TEMİZLİK") || p.endsWith(" CLEANUP"));
    out.binPiece = `${pieces.length} pieces, +${gained} credits, popups ${JSON.stringify(label)}${gained > 0 && label.length === 0 ? " NO POPUP" : ""}`;

    // A whole object in the container: it stays, and the player is told why.
    const whole = [...H.destruction.all()].find((o: any) => o.alive && o.template.def.mass < 5 && !H.destruction.disposalVolume.containsPoint(o.currPos) && o.currPos.z < 4);
    toasts.length = 0;
    whole.body.setTranslation({ x: TRASH.x, y: TRASH.floorY + 0.6, z: TRASH.z }, true);
    whole.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    await run(3);
    out.binWhole = `${whole.definitionId} alive=${whole.alive} toast=${toasts.length ? JSON.stringify(toasts[0]) : "NONE"}`;
  } finally {
    hud.popup = popup;
    hud.showToast = toast;
    H.headless(false);
  }
  return out;
}
