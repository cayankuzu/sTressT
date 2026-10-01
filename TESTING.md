# Testing

## Automated

```bash
npm run check   # typecheck + lint + unit tests + production build
npm test        # unit tests only (vitest)
```

| Suite | Covers |
| --- | --- |
| `src/data/catalog.test.ts` | Game data is internally consistent (every reference resolves, prices/tiers ordered, street finds valid, everything priced can be carried, the starter room is breakable with fists) |
| `src/destruction/damage.test.ts` | Damage model (angle, concentration, thresholds, chain-reaction falloff, no NaN/Infinity) and stage rules (each stage exactly once, never backwards) |
| `src/destruction/debrisRules.test.ts` | Major/minor classification within budget and world cap, the debris state machine (disposed is final), refracture limits and heavy pieces always breakable |
| `src/destruction/geometry/geometry.test.ts` | Slicing keeps area and winding, cut points are bit-identical, islands, deterministic fracture for every pattern, bodies with many detail islands still split, chipping, hull tops and bases kept to four corners |
| `src/economy/economy.test.ts` | Ledger idempotency, purchases and deliveries, tool pick-up, safety box, one-time street finds, old saves' storage delivered once, sessions, ledger pruning, refusals, no input mutation, invariants |
| `src/economy/simulate.test.ts` | Economy pacing for bad / average / good players; nobody gets stuck |
| `src/session/session.test.ts` | Exactly-once rewards, combo only across different objects, one clear bonus per session, one-hit and chain-reaction bonuses |
| `src/destruction/geometry/fracture.bench.test.ts` | Fracture timings on real models; skipped unless `BENCH=1` |

## QA harness (dev builds only)

`src/dev/qa.ts` plays the real game (real swings, grabs, throws and physics; only walking to a
spot is shortened with teleports). It is never imported by the game, so it is not bundled. In the
dev console:

```js
const qa = await import("/src/dev/qa.ts");
await qa.objectAudit();            // every object: pivot, rest, arrange, carry, throw, break with 3 tools
await qa.objectAudit(["mirror"]);  // or a few
await qa.controllerAudit();        // speeds, jump, landing, corners, leaving the map
await qa.inputAudit();             // input spam and interrupted actions
await qa.playthrough();            // find, carry, arrange, break, clean up, shop, deliver, save, load
await qa.feedbackAudit();          // every tool swings in the hands, kick boot, container popup and note
```

Every audit plays in a profile of its own named "QA" (created when missing) and never touches a
player's slots. The pane is shared with the player: a click that captures and releases the mouse
pauses the game, so the playthrough reports such a run as `INVALID` instead of a result.

Run long audits in batches of about 8 objects (the browser tool times out after 45 s). Results and
the bug log of the last pass are in [AUDIT.md](AUDIT.md).

Screenshots: the dev server accepts `POST /__qa/capture?name=shot.jpg` with a canvas data URL as
the body and writes the file to `qa-captures/` (git-ignored). Draw a frame and read the canvas in
the same task, since the WebGL buffer is not kept between frames.

## Dev handle (dev builds only)

`npm run dev`, open the console on <http://localhost:5180>, and drive the game through
`window.__stresst`. Pointer lock is optional in dev builds, so automated browsers can play.

| Call | Does |
| --- | --- |
| `newGame(slot)`, `load(slot)`, `menu()`, `play()` | Start or load a save slot of the active profile, back to the main menu |
| `enterRoom()`, `mode("arrange" \| "break" \| "cleanup")` | Walk into the room, switch mode (same rules as the TAB selector) |
| `teleport(x, y, z, yaw)`, `look(yaw, pitch)` | Place the player and camera |
| `equip(id)`, `credits(n)`, `shop("tools" \| "objects")`, `pickUpAll()` | Tools, money, shops, collect bench deliveries |
| `grabTarget(target)`, `attack()` / `release()`, `kick()`, `key(action, down)`, `tap(action)` | Input actions |
| `advance(seconds)` | Run frames synchronously at 60 fps (works in hidden tabs, where rAF stops). Fracture results come from a worker: `await` a short timeout between batches |
| `autoPause(false)` | Do not pause when the tab is hidden (automated runs in a hidden pane) |
| `pose(stage, phase)` | Freeze the tool at a swing stage (`windup`, `active`, `recovery`) for screenshots |
| `headless(true)` | Simulate without drawing (balance and soak harnesses) |
| `grip(id, position, rotation, scale, offset?)` | Live-tune a tool's first-person grip |
| `saves`, `profiles`, `progress`, `destruction`, `session` | The live systems, for inspection |

Teleporting while holding something drops it (the "stuck" rule): move the object to the player, not
the player with the object.

## Manual QA checklist

Results of the last full pass (Chromium, Windows 11, Intel UHD, dev and production builds):

| Area | Check | Result |
| --- | --- | --- |
| Boot | Loads with no console errors in dev and production; wasm and worker load as separate files; dev handle absent from production | Pass |
| Menus | Profile creation, main menu (Continue / New game / Saved games / Settings), 3 slots, pause menu without a shop | Pass |
| Persistence | Credits, objects, damage marks, broken parts, debris poses and disposed pieces identical after reload; nothing restores on TAB, Esc, door or re-entry | Pass |
| Save safety | Corrupt primary save → backup loaded; profiles isolated; legacy save imported into slot 1 | Pass |
| New game | All 14 starter objects stand upright and asleep | Pass |
| Modes | TAB selector; break refused outside, in the doorway or with nothing breakable; arrange refused during a break; door locked during a break | Pass |
| Arrange | Ghost never pushes neighbours; objects on top travel with it (table with cup and bottle, cabinet with TV); vase on a box, TV on a cabinet, cup on a chair; nothing moves faster than 0.25 m/s after a commit; invalid spots cannot be committed | Pass |
| Stability | Every starter object, street find, bottle and cup on four spots of the table: woken, all stay standing (≤ 2.4°) | Pass |
| Pushing | Walking and running into vase, chair, box and table in arrange mode: nudged ≤ 0.4 m, nothing launched, cup and bottle on the table stay up; carried chair swept past a vase: vase ≤ 0.16 m/s | Pass |
| Breaking | Stages, credits, combo, marks on every hit, re-fracture keeps cleanup value, per-object piece budget | Pass |
| Heavy pieces | "Too heavy" prompt; break mode allowed for them; they always split smaller | Pass, after fix (see below) |
| Cleanup | Thrown piece into the container from 3 m pays once; rim bounce and outside-wall contact do not count; intact object in the container is not disposed | Pass |
| Shops | Tools on the bench, objects on the sidewalk, no overlap when buying many at once, duplicate tool refused, burst clicks buy once, safety box once | Pass, after fixes (see below) |
| Soak | 12 break-and-clean cycles: body, collider, geometry and texture counts stay flat | Pass |
| Window | Resize keeps aspect and canvas size; hidden tab pauses | Pass |
| Debug | `?debug=1` overlay and F2 collider view in production | Pass |
| Crouch | Eyes 1.62 → 0.95 m, 1.8 m/s; stays down and cannot jump under a 1.25 m slab; stands when free | Pass |
| Settings | Invert Y flips the look; quality changes resolution, shadows and dust at once | Pass |
| Audio | Room reverb send 0.31 indoors, 0.06 outdoors; carpet steps in the room, concrete outside | Pass |
| Demo end | Last tool picked up from the bench → summary after 1.5 s; continue resumes; not shown again after load | Pass |
| Playthrough | `qa.playthrough()` three times: every step passes, save/load identical, invariants hold, no errors | Pass |
| Objects | `qa.objectAudit()` over all 40 objects: no errors, no piece outside the room or in the floor | Pass |
| Browsers | Firefox, Safari | **Not yet run** |
| Hardware | A real low-end PC (2–4 cores, old iGPU) | **Not yet run**; approximated with `?q=low` and CPU throttling |

### Bugs found and fixed in QA

- **Breaking a laptop could throw `expected instance of RawShape`** (paper-thin screen shards): the
  object stayed half broken and an orphan body was left. Rapier builds a hull only when the collider
  is created and throws on flat points; thin pieces now keep their real thickness and any failed
  hull falls back to a thin box.
- **The player spawned or teleported 1-2 cm into the ground** (inside the controller's skin) and
  crawled or stuck for a moment. Teleports now land just outside the skin.
- **Swings slipped through gaps** (a broken chair's empty seat) and hit the floor although the
  crosshair was on the object; a bat could not finish a broken chair. A swing now connects with a
  breakable thing its striking surface clips on the way.
- **Continuous collision made thin shards fall through the floor** (2-4 of 16 alarm clock shards).
  Pieces no longer use it; a metre of invisible backing behind the room walls stops fast pieces,
  and a piece that slips into the floor is put back on top.
- **A player standing still kept nearby debris awake forever**: the kinematic body was re-positioned
  every step, and Rapier wakes whatever such a body touches. An idle player is now pinned in place.
- **Glass modelled together with its frame never shattered** (microwave door): glass triangles now
  always become a part of their own.
- **Objects flew off when placed in arrange mode.** A placed object was forced asleep while the
  object under it was awake; Rapier then let it sink into its support and the solver flung both
  (a box at 3.7 m/s). Sleep is now forced only for whole contact groups; otherwise bodies are damped
  until they sleep by themselves.
- **Cups and bottles on a table slowly tipped over once disturbed** (and the original clamp desk
  lamp could not stand at all). Rapier 0.21 clips face contacts on faces with more than four
  corners, so a table top with interior or many outline points held a cup on one point. Tops and
  bases are now four-corner faces (unit-tested). The desk lamp model was replaced by a free-standing
  one (Poly Haven "Industrial Pipe Lamp", CC0).
- **Moving a table left the cup and bottle on it floating, then falling.** Objects on top now move
  with it.
- **Walking into a chair launched it at 7 m/s** (Rapier's character impulses). Pushing is now
  bounded by the player's speed, a force and, outside break mode, an acceleration; a chair carried
  in arrange mode no longer knocks over a vase it swings past.
- **The overlap check used a box 2.5 cm smaller than the object**, so neighbours could be placed
  inside each other and pushed apart on landing. It now uses the real collider shapes.
- **Objects tipped over or rocked at the start of a new game.** Hull colliders now use exactly four
  footprint points (Rapier keeps four contact points), table tops keep their outline, grounded parts
  weigh more (low centre of mass), and new bodies settle before sleeping.
- **A TV placed on a cabinet sank into it; a cancelled mid-air placement floated.** Gravity is held
  until contacts exist, and a body only sleeps when supported from below.
- **Tools could not hit loose pieces.** Hits now resolve fragments as well as objects.
- **Heavy pieces could lock the cleanup.** With no object left in the room, break mode was refused,
  and a piece at the depth limit could never be split. Heavy pieces now count as breakable, ignore
  the depth limit and split into more parts.
- **Fracture ignored bodies with many detail islands** (knobs, screws): the islands counted as
  pieces, then were glued back, so a TV left one 14 kg chunk. Only real pieces count now.
- **Chips and detached parts used up the collectible budget**, leaving tiny splinters to carry and
  one huge final piece. Chips are never collectible; the budget is per object.
- **Objects bought in one shop visit could spawn inside each other** (physics is paused while the
  shop is open, so the free-spot query could not see them); the safety box could be taken twice
  while its delivery was loading. Deliveries now reserve their spot and count as owned at once.
- **Reset while holding an object crashed the physics (wasm panic)** (older build). Liveness checks
  compare identity because Rapier's JS lookup ignores the handle generation.
- **A pointer-lock request that never settles left the game behind its menu.** The request is now
  bounded (2 s).

## Balance method

`GAME_DESIGN.md` lists ideal hits-to-destroy per tool and object, computed from the same formula as
`damage.ts`. In-game checks (`headless(true)` plus scripted swings) show real play takes about 1.5–2×
the ideal count, mostly from hit angles. Re-run both after changing tool or material numbers.
