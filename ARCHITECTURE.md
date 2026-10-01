# Architecture

Vanilla TypeScript on three.js (WebGL2) and Rapier (WebAssembly). One orchestrator (`Game`) owns
every system; systems talk to each other through constructor-injected callbacks and a small typed
event bus (`core/events.ts`), never through globals.

```
main.ts ── boot: profiles (localStorage), language, quality, renderer, physics (wasm), assets,
   │        SaveManager (IndexedDB slots), UI shell
   └── Game (game/Game.ts): state machine, modes, frame loop
         ├── world/        street, rage room (door shutter), trash container (disposal volume),
         │                 tool bench (deliveries), lighting rig, signs, props
         ├── player/       PlayerController (kinematic capsule), ToolSystem, KickSystem,
         │                 GrabSystem, ArrangeMode (ghost placement), Viewmodel, CameraShake
         ├── destruction/  DestructionSystem ─ Destructible ─ Debris ─ FractureJobs (worker)
         ├── session/      Session: one break session's rewards, combo, stress meter
         ├── game/Progress in-memory progress; the only path that changes credits (economy/)
         ├── save/         schema v3, SaveManager (slots, backup, checksum), profiles, settings
         ├── audio/        AudioManager (WebAudio, voice budget)
         ├── fx/           Particles
         ├── engine/       renderer, physics, collider debug view
         └── ui/           i18n (TR/EN), HUD, menus, shops, debug overlay
```

## States and modes

- **State** (`title | playing | paused | menu`): every overlay (pause, shop, confirm) is
  `menu` or `paused`, which freezes physics, input and the session. Physics keeps running behind
  the title screen as a live backdrop.
- **Mode** (`arrange | break | cleanup`), picked with the TAB selector. `modeBlock()` says why a
  mode is refused (break only inside the room, away from the doorway, with something breakable,
  heavy pieces included; arrange never during a break). `setMode()` is the only place that locks
  the door, lowers the tool and turns `DestructionSystem.damageEnabled` on (break only).
- The world is never reset. `enterGame()` clears the scene and rebuilds it from a save; nothing
  else restores objects.

## Frame loop (`Game.frame`)

1. Clamp the real frame time (`MAX_FRAME_SECONDS`); slow motion scales world time only.
2. `handleInput`: look, mode selector (TAB), tool switching, arrange/grab, interact (bench, grab,
   shop door), then `ToolSystem.update` and `KickSystem.update` (attacks resolve here, as swept
   queries against the physics world, using the tool's speed relative to its target).
3. `physics.advance`: fixed 1/60 s steps (at most 3 per frame; a long stall is dropped, not
   replayed). Before each step: player controller and grab spring. After each step:
   `DestructionSystem.afterStep` (body bookkeeping, contact-force events → collision damage,
   settling of new bodies, debris sleep and limits, major pieces lost or in the container).
4. Session timers, door, interpolated render transforms (`alpha`), particles, location (street or
   room: ambience and lighting rig), camera, viewmodel.
5. HUD, prompts, footsteps, audio listener, thumbnail queue, deferred saves.
6. Render: world pass, then the viewmodel pass after `clearDepth()` (tools never clip into walls).
   The shadow map renders only when something moved. The resolution governor adjusts afterwards.

## Destruction pipeline

```
objects.json + model ──► Template (once per definition)
   soup of triangles per material, islands → up to 10 Parts with hull colliders
        │ spawn (instance)
        ▼
Destructible: one compound rigid body, per-part HP, stage state, dents, marks (crack/glass/scuff)
        │ applyImpact(impact)        ◄── ToolSystem / KickSystem / contact forces
        ▼
damage.ts computeDamage ──► stages.ts applyDamage (intact→damaged→broken→destroyed, once each)
        │
        ├─ damaged:  dent (deform.ts), crack decal
        ├─ broken:   structural part detaches → its own Debris body (synchronous, small)
        └─ destroyed: shatter → FractureJobs.run (Web Worker; synchronous fallback)
                         impact-biased recursive plane fracture by material pattern,
                         islands, tiny pieces merged, convex hull points
                      → DestructionSystem spawn queue (3 ms budget per frame)
                      → debrisRules.classifyPieces: major (collectible, saved) / minor / micro
                      → Debris: fragments in one BatchedMesh per material, physics bodies
                        until they sleep or the active cap (150) is reached
```

- Major pieces get permanent ids (`<object>.d<n>`, `<piece>.<k>`), hit points and a cleanup value
  (the object's cleanup pool, shared by area). A hard hit re-fractures a major piece in the worker;
  the value moves to its collectible children.
- `checkMajors()` runs after every step: a piece below the world or outside its box is lost; a piece
  whose centre has settled inside the container volume for 0.3 s (not held) is disposed, rewarded
  by Game through the ledger (`cln:<id>`), and faded out.
- New, loaded and re-placed bodies are settled: created awake with gravity off for three steps so
  their contacts form, then damped for a moment. One that is slow and actually touching a support
  sleeps at once, but only together with every awake neighbour: Rapier keeps integrating a body
  forced asleep next to an awake one, it sinks into it, and the solver then flings both apart.
- Hull colliders (`hullPoints` in `geometry/soup.ts`) keep the bottom and top faces at four
  corners each: Rapier 0.21 clips face contacts on faces with more corners (a cup on a round or
  chamfered table top rests on one point and tips over). The footprint is the four diagonal
  extremes of the base layer (tolerating a few millimetres out of level); the top is the
  largest quad inside the top outline, with the rest of the outline 5 mm lower as a bevel.

- Every hit carries an `attackId` so a single swing damages an object once. Chain reactions carry a
  `generation` that scales damage down and stops after two hops; resting objects are generation
  99 and the world is -1, so a falling shelf does not get the player's full multiplier.
- Interiors of cut surfaces are drawn with a backface shader patch in the material's interior
  colour (no extra geometry for the cut face).
- Templates: glass triangles always form parts of their own (`splitGlass`), and `restPose:
  "faceUp"` lays a thin panel on its back when the template is built.
- Fracture is deterministic per (instance, piece count, hit), from `core/rng.ts`. Small detail
  islands (knobs, screws) do not count as pieces; they are glued onto the nearest real piece.

## Economy, save and session

- `economy/state.ts` + `economy/economy.ts`: pure reducers (`grantReward`, `purchaseTool`,
  `pickUpTool`, `purchaseObject`, `grantSafetyObject`, `claimFoundItem`, `collectObject`,
  `beginSession`, `pruneLedger`, ...) returning `{ ok, state } | { ok: false, reason }`, plus
  invariant checks. Rewards go through an idempotent ledger keyed `brk:` / `cln:` / `clr:`; the
  collection (`progress.collection`, kinds destroyed once) pays its first-break bonus by
  membership, so it needs no ledger key.
- Levels (`data/catalog.ts`: `canBreak`, `bestTier`, `toolForTier`, `objectsOfTier`): tools and
  objects carry `tier` 1..7. `DestructionSystem` gates every damage path: a tool hit uses the
  tool's level, kicks/throws/collisions use `breakTier()` (the player's best owned tool), pieces
  use their object's level. A locked hit is applied with zero energy (push only) and reported
  through `onBlocked`; `purchaseObject` refuses levels the player's tools (bench included) cannot
  break.
- `economy/simulate.ts`: deterministic economy simulator (bad, average, good player); its tests
  guard the pacing and the "never stuck" rule.
- `game/Progress.ts` holds the progress in memory and applies reducers; every change asks the
  SaveManager for an autosave. It never writes storage itself.
- `save/schema.ts` (v3): `SaveData` = progress + world (`ObjectRecord`: pose, stage, health,
  parts, marks; `DebrisRecord`: piece geometry, pose, hp, depth, value) + mode, playtime, settings.
  Validation repairs or drops bad fields; older saves migrate.
- `save/SaveManager.ts`: one snapshot of money and world from the same moment, written
  sequentially to `installation/profile/slot`. Each slot keeps `primary` and `backup`, each with a
  checksum, in one IndexedDB transaction; loading falls back to the backup. Periodic save every
  60 s, flush on `pagehide`. A memory store is used when storage is blocked.
- `save/profiles.ts`: local profiles (max 5) and per-profile settings in localStorage.
- `session/Session.ts`: rewards per stage (exactly once), combo across different objects, stress
  meter and the clear bonus. It grants credits only through Progress.

## Rendering

- Static architecture is merged per material and drawn with Lambert (albedo also feeds a little
  emissive so dark corners stay readable); props use instancing; fragments use one BatchedMesh per
  material. Image-based light comes from a PMREM'd RoomEnvironment with neutral tone mapping.
- One shadow-casting directional key light whose rig lerps between the street and room setups.
- Shaders are compiled at startup and again when a new object type is placed, including a real
  draw in front of the camera (ANGLE compiles on first draw, not on `compile`), so the first break
  never hitches.
- Viewmodel: tools are positioned at a hand grip in camera space. Swings are three camera-space
  keys (cock, contact, follow-through) blended with quaternion slerp about the hand. The tool
  reaches contact exactly when the hit resolves, so hit-stop freezes it on the target.

## Physics

- Rapier 0.21 (non-compat build) with a custom wasm loader (`engine/rapierWasm.ts` and the
  `rapierWasm()` Vite plugin): the 3 MB wasm streams as its own file instead of being inlined as
  base64.
- Collision groups (`config/gameConfig.ts` → `GROUPS`) keep the player, props, debris, small debris
  and held objects from paying for pairs that never matter.
- Bodies being placed in arrange mode are disabled (`setEnabled(false)`): the ghost never pushes
  anything. Objects resting on it (contact normal up, recursively) are disabled and moved with it;
  anything else touching it is woken. Placement is validated with the ghost's real collider
  shapes (shape queries, lifted 12 mm off the support), including the player capsule.
- Melee targeting (`player/strike.ts`): the crosshair ray first; if it slips through a gap and
  hits the world, a sphere sweep the width of the striking surface picks a breakable it clips.
- Pieces never use continuous collision (on thin hulls it makes tunnelling worse). The room has a
  metre of invisible backing behind its walls, floor and ceiling, and `Debris.afterStep` puts a
  piece found inside the floor back on top. Collider creation falls back to a box if Rapier
  rejects a hull (it validates only at creation time).
- The player's kinematic body is pinned while idle (no input, no drift): a kinematic body given a
  new position every step wakes everything it touches. Teleports land just outside the
  controller's 2 cm skin. Crouching shrinks the capsule (`setHalfHeight`) and only stands up when a
  full-height capsule query is free.
- The character controller does not apply Rapier's own impulses (they hand the 80 kg player's
  momentum to a 4 kg chair). `PlayerController.pushObstacles` pushes by hand: horizontal, capped
  by speed share, force and (outside break mode) acceleration.
- A carried object gets dominance group -1 outside break mode, so it cannot shove other bodies.
- Rapier's JS-side body/collider lookup ignores the handle generation. Code that keeps a body or
  collider across frames checks identity (`bodies.get(h) === body`, `collider.handle === h`), never
  `contains(h)`.

## Dev tooling

- `window.__stresst` (dev builds only; compiled out of production): teleport, look, equip, attack,
  kick, credits, newGame/load/menu, mode, shop, pickUpAll, grabTarget, `advance(seconds)` (runs
  frames synchronously, even in a hidden tab), `autoPause(false)` (no pause on tab switch),
  `pose(stage, phase)` (freezes a swing frame), `headless(true)` (simulate without drawing).
- Debug overlay (dev, or `?debug=1` in production; toggle with ` or F1): FPS, draw calls, bodies,
  mode, session, target id/state/hp/mass, last hit, debris counts, credits, ledger, save and profile.
- Collider view (same builds, F2): every collider (player capsule included), the container's
  disposal volume and the doorway zone.
- `viewer.html`: contact sheet of every processed model, for checking pivots and scale.
- `?q=low|medium|high` forces a quality tier.
