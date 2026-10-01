# sTressT

A first-person physics rage room for the web. Break things, earn credits, buy better tools and more
things to break, arrange the room the way you like, and break it all again.

This repository is the **web demo** (about 30 minutes of play). Game data lives in plain JSON so a
full version can be rebuilt in another engine (Godot) without re-deciding the design.

- Browsers on devices with a keyboard and mouse (PC, or a tablet with both connected). Verified in
  Chromium (Chrome/Edge); Firefox and Safari 16+ are supported targets but still need a manual
  pass. Touch-only devices are told that a keyboard and mouse are required.
- WebGL2 is required. There is no WebGPU path yet.

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:5180>. The port is fixed (`strictPort`) so it never collides silently with
another project.

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on port 5180, with the dev handle (`window.__stresst`) |
| `npm run build` | Type-check, then build the production bundle into `dist/` |
| `npm run preview` | Serve `dist/` locally (use `--port 5181` to keep the dev server running) |
| `npm run check` | Type-check, lint, unit tests and production build in one go |
| `npm test` | Unit tests (vitest) |
| `npm run lint` | oxlint over `src/` and `scripts/` |
| `npm run assets:prepare` | Re-download and re-process every third-party asset (see below) |

`dist/` is a static site: upload it to any static host (itch.io HTML5, GitHub Pages, Netlify, your
own server). The base path is relative (`./`), so it also works from a sub-folder. Serve `.wasm`
as `application/wasm` for the fastest start; other servers still work through a fallback.

Append `?q=low`, `?q=medium` or `?q=high` to the URL to force a quality tier (otherwise it is
detected, and can be changed in Settings).

## Controls

| Input | Action |
| --- | --- |
| Mouse | Look |
| W A S D / arrows | Move (Shift runs, Space jumps) |
| C (hold) | Crouch: lower, slower, quieter; stands up only where there is room |
| Left click | BREAK: swing the tool. Holding something: throw it. ARRANGE: pick up an object as a ghost, then place it |
| Right click / V | Kick; puts down what you hold; cancels a placement |
| E | Pick up and carry / put down; take a delivered tool from the bench; enter a shop at its door |
| TAB | Mode selector: 1 DÜZENLE (arrange), 2 KIR (break), 3 TEMİZLE (cleanup) |
| 1–9 / mouse wheel | Switch tools |
| Q / E (Shift: free) | Rotate while placing |
| Esc / P | Pause: resume, save, end break, settings, main menu |
| ` or F1, F2 | Debug overlay and collider view (dev builds or `?debug=1`) |

Settings: volumes, mouse sensitivity, invert mouse Y, field of view, head bob, impact shake,
graphics quality (applies at once) and language (Turkish / English).

The game captures the mouse (pointer lock) when you press Play or Resume. If the browser refuses
(Chrome does for about a second after Esc; some embedded browsers never allow it), the mouse
still turns the camera directly, and your next click on the game captures it.

## How it plays

1. **Street.** You start outside. The Tool Shop sells tools, the Object Store sells things to break,
   and the door in the middle is the rage room. A few things lie around the street for free.
2. **Deliveries.** Shops are entered on foot. Bought tools wait on the bench in front of the Tool
   Shop, bought objects on the sidewalk in front of the Object Store: pick them up and carry them.
3. **Arrange.** Place objects in the room with a ghost preview that snaps to surfaces and never
   pushes anything. Nothing can be damaged in this mode.
4. **Break.** TAB ▸ KIR locks the door. Objects pay at every stage (damaged, broken, destroyed),
   with combo, one-hit, chain-reaction, first-time and room-clear bonuses.
5. **Clean up.** TAB ▸ TEMİZLE opens the door. Carry the big pieces to the container across the
   road; each one that settles inside pays its share of the cleanup reward.

6. **Levels.** Every tool is a level (1 fists … 7 sledgehammer) and every object needs one: a tool
   below the object's level does nothing to it. The store sells what your tools can break and
   shows the rest locked; the HUD always shows the next tool to save for and the collection.
7. **Goals.** Getting the Sledgehammer ends the demo with your numbers (time, objects destroyed,
   credits, pieces thrown away, best combo, collection); then break every one of the 36 kinds of
   object for the collection bonus.

The room never resets: what you break stays broken until you clean it up. Progress (credits,
tools, every object and piece, damage) is saved automatically and from the pause menu, in up to
three slots per local profile (IndexedDB, with a checksummed backup).

## Project layout

```
src/
  config/       tuning constants (gameConfig.ts) and cosmetic quality tiers
  core/         input, event bus, deterministic RNG, asset loading
  data/         JSON game data (materials, tools, objects, starter room) + schema/validation
  destruction/  damage model, destructible objects, fracture (worker), debris
  economy/      pure reducers for credits, purchases, deliveries and rewards; economy simulator
  engine/       renderer, physics world, Rapier wasm loader
  fx/           particles
  game/         Game orchestrator (state machine, modes, frame loop) and Progress
  player/       movement, tools, kick, grab/throw, arrange mode, viewmodel, camera shake
  save/         save schema, migrations, slots with backup, profiles, settings
  session/      reward bookkeeping for one break session
  ui/           i18n (TR/EN), DOM overlays, HUD, shops
  world/        street, rage room, trash container, tool bench, lighting, signs, props
scripts/assets/ asset download/processing pipeline and its manifest
public/assets/  processed models, textures and sounds (generated)
```

More detail:

- [GAME_DESIGN.md](GAME_DESIGN.md): rules, tools, economy and pacing
- [ARCHITECTURE.md](ARCHITECTURE.md): how the code fits together
- [PERFORMANCE.md](PERFORMANCE.md): budgets and the techniques used to meet them
- [TESTING.md](TESTING.md): automated tests, the dev handle and the QA checklist
- [CHANGELOG.md](CHANGELOG.md): release notes (Turkish); the running version is shown on the main menu
- [AUDIT.md](AUDIT.md): the system audit and bug log (Turkish)
- [ASSET_LICENSES.md](ASSET_LICENSES.md): every third-party asset with its source and license

## Assets

All models, textures and sounds are third-party and free to use (CC0, plus a few CC-BY models whose
authors are credited in [ASSET_LICENSES.md](ASSET_LICENSES.md) and in the game). Nothing is modelled
from scratch. `scripts/assets/manifest.json` lists every asset with its source; `npm run
assets:prepare` downloads the originals into `assets-src/` (git-ignored), then simplifies,
re-pivots, re-textures (WebP) and compresses them into `public/assets/`, and regenerates
`src/data/generated/*.json` and `ASSET_LICENSES.md`.

## Tech

TypeScript (strict), [three.js](https://threejs.org) for rendering,
[Rapier](https://rapier.rs) (WebAssembly) for physics, Vite for building. No UI framework.

## Copyright

© 2026 MeMoDe. All rights reserved. sTressT is made and published by MeMoDe ("Powered by
MeMoDe"); its code, design and game data may not be copied or redistributed without permission.
Third-party models, textures and sounds keep their own licenses, listed in
[ASSET_LICENSES.md](ASSET_LICENSES.md).
