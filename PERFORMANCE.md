# Performance

**Goal:** a steady frame rate with no hitches on old and weak hardware (integrated GPUs, 4-core
laptops), without removing gameplay, objects, fragments or physics fidelity on any machine.
Quality tiers may only change things the player does not play with: render resolution, shadow-map
sharpness, anti-aliasing, texture filtering and the number of purely cosmetic dust particles.

## Budgets (per frame, 60 fps = 16.7 ms)

| Area | Budget | Measured (Intel UHD integrated GPU, dev build) |
| --- | --- | --- |
| Game logic + physics (CPU) | ≤ 4 ms | about 1 ms typical |
| World + viewmodel draw (GPU) | ≤ 8 ms | 2–7 ms |
| Spawning fracture results | ≤ 3 ms | hard-capped by the spawn queue |
| Fracture computation (main thread) | 0 ms | runs in a Web Worker |
| Shader compilation during play | 0 ms | everything is warmed at load |

Hard caps (identical on every tier): 150 simulated fragments (beyond that the oldest resting
clutter becomes static debris that stays visible; past 700 static pieces the oldest are removed),
30 collectible (major) pieces in the world and at most 5 per object, 18 pieces per break,
8 marks per object, 14 simultaneous sound voices, 3 physics steps per frame. Collectible pieces
are never frozen or culled: they are gameplay, not decoration. Clutter clears itself when a break
ends, so a long session does not accumulate bodies (a 12-cycle soak test keeps the body, collider,
geometry and texture counts flat).

## What keeps it fast

**Rendering**
- Static architecture merged into one mesh per material; repeated props instanced; every fragment
  of a material drawn by a single `BatchedMesh`, presized so it never reallocates mid-fight.
- Lambert shading for architecture (about 40% cheaper than PBR on integrated GPUs), PBR only where
  it shows. One shadow-casting light, and the shadow map only re-renders when something moved
  (`ShadowScheduler`).
- Dynamic resolution (`ResolutionGovernor`): lowers the pixel ratio under sustained load, within the
  tier's floor, and reverts the change if it did not help (CPU-bound frames are not "fixed" by
  blurring the picture).
- Shader warm-up at load *and* when a new object type is placed, with a real draw in front of the
  camera and a shadow pass. ANGLE (Chrome/Edge on Windows) compiles on first draw, not on
  `compile()`; without this the first break of each material cost 100–430 ms.

**Destruction**
- Fracture (plane slicing, island detection, consolidation, hull points) runs in a Web Worker on a
  transferable copy of the triangle soup. Results are spawned from a queue with a 3 ms per-frame
  budget, so a big break spreads its cost over a few frames instead of spiking one. Before the
  worker, a break cost 8–18 ms on the main thread.
- Triangle soup code avoids temporary allocations (inlined stats, numeric keys, single-material
  fast path) to keep the garbage collector quiet.
- Each object is one compound rigid body with at most 10 convex hull parts; fragments go to sleep
  and stop costing solver time. New and loaded bodies settle (gravity held for three steps, then
  sleep once supported), so a loaded room starts asleep instead of jittering.

**Physics**
- Fixed 1/60 s step with interpolated rendering; a stall drops time instead of replaying it, so
  a slow frame never causes a slower next frame.
- Collision groups remove pairs that never matter (small debris vs small debris, held objects vs
  the player).
- Rapier wasm streams as its own file (`instantiateStreaming`), not as base64 inside the JS.

**Audio and effects**
- Fixed voice budget with priorities (loudness, breaks and distance); a new sound only replaces a
  lower-priority voice, so quiet distant clatter is the first to go. Sample variants
  avoid repetition without playing more sounds.
- Particles live in two fixed-size pools (no allocation during play); the tier scales counts only.

## Quality tiers

| Tier | Pixel ratio (max / floor) | Shadow map | AA | Dust particles |
| --- | --- | --- | --- | --- |
| low | 0.85 / 0.5 | 512 | off | 50% |
| medium | 1.0 / 0.6 | 1024 | off | 80% |
| high | 1.5 / 0.75 | 2048 | on | 100% |

Detected from core count, device memory and GPU name; `?q=low|medium|high` overrides it, and
the player can change it in Settings.

## Download size (production build)

| File | Size | gzip |
| --- | --- | --- |
| JavaScript (game + three.js + Rapier glue) | 1.13 MB | 286 KB |
| Rapier wasm | 3.1 MB | 1.2 MB |
| Fracture worker | 9 KB | |
| Models (58, simplified, WebP textures) | 7.6 MB | loaded on demand |
| Textures | 1.1 MB | |
| Sounds | 0.7 MB | |

## Measuring

- Press ` (or F1) in game for the overlay (dev builds, or `?debug=1`): FPS and worst frame, tier
  and pixel ratio, draw calls, triangles, physics bodies (awake), fragments. F2 draws the colliders;
  it rebuilds a line buffer every frame, so leave it off when measuring.
- `?q=low` on a fast machine approximates the low tier's GPU load; Chrome's CPU throttling
  (DevTools → Performance, 4× slowdown) approximates an old CPU.
- `BENCH=1 npx vitest run src/destruction/geometry/fracture.bench.test.ts` times the fracture code
  on its own.
