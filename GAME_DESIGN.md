# sTressT: game design (web demo)

## Pillars

1. **Breaking feels physical.** Damage comes from energy, angle, contact area and material, never
   from a scripted "hit points minus one". A bat and a hammer break the same vase differently.
2. **Every action has feedback.** Hit-stop, camera shake, a tool that visibly lands on its target,
   layered sound, dust and chips, payout pop-ups and a short slow motion on big breaks.
3. **Your room, your rules.** You buy the objects, decide where they go, then destroy your own
   arrangement.
4. **Runs on weak hardware without being a lesser game.** Quality tiers only change resolution,
   shadow sharpness and dust counts. Objects, fragments and physics are identical everywhere.

## Core loop

```
Street ──► Tool Shop / Object Store (buy) ──► goods wait outside the shop: pick them up
   │       free finds on the street (one-time claims)
   ▼
Rage room, DÜZENLE / ARRANGE: carry objects in, ghost-place them (no damage)
   │ TAB ▸ KIR / BREAK: the door locks
   ▼
BREAK: tools, kicks, throws, chain reactions ──► break credits, combo, stress meter
   │ stress meter empty = room cleared (+10% of what you destroyed); TAB ▸ TEMİZLE ends it any time
   ▼
TEMİZLE / CLEANUP: the door opens; carry the big pieces out to the container across the road
   │ every piece that settles inside pays its cleanup share (once)
   ▼
Buy more, arrange again. The room never resets: what you broke stays broken until you clear it.
```

The world is persistent. Nothing is restored by TAB, Esc, leaving the room, loading or reloading
the page: intact objects keep their place and damage (dents, cracks, scuffs), broken objects stay
broken and their collectible pieces stay where they fell until the player throws them away.

## Movement

Walk 3.4 m/s, run 5.2 m/s (Shift), jump 0.63 m, crouch (hold C): a 1.1 m capsule with the eyes at
0.95 m, 1.8 m/s, quieter steps, no running. Releasing C stands up only when the full-height capsule
fits (under a table the player stays down); a jump from a crouch needs that room too. Footsteps
follow the surface (rubber mats in the room, concrete pavers outside) and the room has its own
reverb.

## Demo scope and pacing (about 30 minutes)

| Time | What the player is doing |
| --- | --- |
| 0–4 min | Learns movement, fists, grab and throw, kick. Breaks the starter room, first cleanup |
| 4–8 min | Buys the Frying Pan and Baseball Bat; claims street finds, first purchased objects |
| 8–18 min | Hammer and Pipe Wrench; arranges stacks and chain reactions; cleanup becomes routine |
| 18–30 min | Crowbar and Sledgehammer; big cycles; heavy objects that must be smashed smaller |

The economy simulator (`src/economy/simulate.ts`, run by `npm test`) plays the loop with three
player models and prints when each tool is bought:

| Player | Pan | Bat | Hammer | Wrench | Crowbar | Sledge |
| --- | --- | --- | --- | --- | --- | --- |
| Good (cleans everything, combos) | 0.9 min | 2.3 | 4.2 | 7.8 | 12.7 | 16.4 |
| Average (cleans 75%) | 0.9 | 2.7 | 6.4 | 11.8 | 19.6 | 30.1 |
| Bad (rarely cleans, misses a lot) | 1.0 | 2.3 | 7.2 | 22.2 | 51.5 | never |

Nobody is ever stuck: see the safety net below. Picking up the last of the seven tools ends the
demo: a summary (time, objects destroyed, credits earned, pieces thrown away, best combo, objects
thrown) with "keep breaking" or "main menu". It is shown once per save.

## Tools

Power grows with price, and every tool also has a specialty (affinity per material), so cheaper
tools stay useful. Striking energy is ½·m·v², with m including the arm behind the tool.

| Tool | Price | Energy | Swing (s) | Motion | Best against |
| --- | --- | --- | --- | --- | --- |
| Fists | 0 | 45 J | 0.32 | Alternating left/right punches | Cardboard, fragile items |
| Frying Pan | 150 | 73 J | 0.47 | Diagonal smack | Plastic, glass, electronics |
| Baseball Bat | 300 | 141 J | 0.56 | Horizontal sweep, long reach | Wood, plastic |
| Hammer | 450 | 76 J | 0.41 | Overhead chop, tiny face | Ceramic, glass, screens, stone |
| Pipe Wrench | 700 | 148 J | 0.50 | Diagonal whack | Metal, electronics, stone |
| Crowbar | 1,000 | 127 J | 0.51 | Hooked chop | Wood joints, metal |
| Sledgehammer | 1,500 | 316 J | 0.85 | Heavy overhead | Everything; chairs and nightstands in one square hit |

Ideal direct hits to destroy (from the balance formula, assuming square hits; real swings land at
an angle, so expect roughly 1.5–2× as many in practice):

| Object (HP) | Fists | Pan | Bat | Hammer | Wrench | Crowbar | Sledge |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Wooden cabinet (1100) | 46 | 20 | 7 | 13 | 7 | 5 | 3 |
| Wooden table (800) | 33 | 15 | 5 | 9 | 5 | 4 | 2 |
| CRT TV (450) | 18 | 9 | 4 | 3 | 3 | 3 | 2 |
| Marble bust (600) | 43 | 24 | 6 | 4 | 3 | 3 | 2 |
| Wooden chair (260) | 11 | 5 | 2 | 3 | 2 | 2 | 1 |

**Kick** (right click / V): any time your hands are free (while carrying, it puts the load down). Low damage, a lot of push: for
toppling shelves, sending a chair into a TV, or punting debris.

**Grab and throw** (E to pick up, E or right click to put down, left click to throw): loose
pieces up to 12 kg are thrown; whole objects up to 40 kg can be carried (heavier ones slow you
down and are held low). A thrown object takes full damage itself; whatever it hits takes
chain-reaction damage (×0.45), and anything it destroys pays the chain-reaction bonus.

## Damage model

```
damage = energy × angle × concentration × threshold × affinity × toolAffinity × generation
```

- **angle**: 1 for a square hit, falling to 0.35 for a graze.
- **concentration**: a small striking face concentrates stress, and brittle materials care most
  (a hammer shatters ceramic; on cardboard the face size hardly matters).
- **threshold**: below the material's minimum energy, damage falls off quadratically. A punch barely
  dents a metal cabinet, however many times you hit it.
- **generation**: 1 for the player's own hits and throws, 0.45 and then 0.2 for chain reactions,
  0 after two hops. A collapse cannot cascade forever.

Stages: **intact → damaged** (below 92%) **→ broken** (below 45%, or a structural part gave way)
**→ destroyed**. Each stage pays once, ever (the object id is never reused). Every hit leaves a
visible mark (crack, glass star or scuff, up to 8 per object) that is saved. Broken objects shed parts; destroyed objects
fracture with a material pattern: radial (ceramic), shatter (glass), splinter (wood),
tear (cardboard, sheet metal), chunk (stone, plastic, electronics).

## Debris

| Kind | What | Lifetime |
| --- | --- | --- |
| **Major** | The biggest pieces of a break (radius ≥ 6 cm). Physical, collectible, saved | Until thrown in the container |
| **Minor** | Visible clutter with physics | Fades out when the break ends |
| **Micro** | Crumbs and shards | A few seconds |

- Each object has one budget of major pieces for its whole life: 1 + 3.2 per metre of its largest
  dimension, at most 5 (a vase 2, a chair 4, a cabinet 5). Chips are never collectible; a part
  that comes off may take up to two, always leaving one for the final break. 30 majors at most in
  the world.
- Glass is always its own part (a microwave door, a frame's pane, a clock face), so it shatters
  while the frame around it breaks like the frame. A thin wall mirror rests on its back.
- A major piece can be broken again (up to depth 3, two collectible children, value kept).
  Pieces over 12 kg cannot be carried: the prompt says to break them smaller in BREAK mode, and
  they stay breakable at any depth so the room can always be cleaned. A room holding only heavy
  pieces still allows BREAK mode.
- Ids are permanent: `<object>.d<n>` for a piece, `<piece>.<k>` for its children.
- States: active, held, thrown, disposed, lost. Disposed and lost are final.

## Cleanup and the container

- The street container (across the road from the room) has a disposal volume. A piece counts only
  when its centre is inside, it is slower than 1.8 m/s, it has stayed 0.3 s and nobody holds it.
  Pieces bouncing off the rim or lying against the outside do not count; intact objects never do.
- A disposed piece fades out (0.45 s) and is gone for good.

## Economy rules

- Credits are created only through reward ids in an idempotent ledger and spent only through the
  economy reducers (`src/economy/economy.ts`); a reward id can never pay twice:
  `brk:<object>:<stage>`, `cln:<piece>`, `clr:<session>`.
- Object value = 1.05 × price. **Breaking** pays 75% of it: 25% at broken, the rest at
  destroyed. **Cleanup** pays the other 25%, shared by the object's major pieces by size. Breaking
  is always worth more than cleaning, but skipping cleanup leaves a quarter on the table and a
  cluttered room.
- **Combo**: each *different* object hit within 2.5 s adds +10% (up to ×1.6). **ONE HIT** (intact to
  destroyed in one impact): +20% of the value. **CHAIN REACTION** (destroyed by a thrown object,
  debris or a collapse): +25%.
- **Room clear**: when the stress meter is empty, +10% of the value destroyed in that session.
- Bought objects are consumed when broken: income comes from buying, breaking and cleaning again.
- Street finds (eight objects around the street) are free; each can be claimed once.
- **Safety net**: with no credits for the cheapest object and nothing breakable left (in the room or
  in storage), the Object Store gives a free cardboard box. Nobody can get stuck.
- Room capacity: 40 objects. Rubber items and the metal barrel are indestructible props.

## Shops and deliveries

Shops are entered on foot (E at the shop door); there is no shop in the pause menu. Purchases are
physical:

- **Tools** appear on the bench in front of the Tool Shop. E picks one up; it is then owned and
  equipped. A tool cannot be bought twice.
- **Objects** appear on the sidewalk in front of the Object Store, at a free spot (then on the road
  edge, then on a pile). The player carries them into the room.

## Modes (TAB)

TAB opens a selector: **[1 DÜZENLE] [2 KIR] [3 TEMİZLE]**. TAB moves the highlight, 1–3 or E / left
click picks, right click or a few seconds closes it.

- **DÜZENLE / ARRANGE**: no damage. Left click on an object shows a ghost; the ghost never pushes
  anything, and whatever stands on it (a cup on a table, a TV on a cabinet) travels with it. It
  snaps onto the surface below (magnet), turns with Q/E (Shift: free rotation) and is checked with
  its real collision shape for overlap, plus support, the room walls, the doorway and the player.
  Left click commits, right click cancels. Delete sends an intact object to storage; I opens
  storage. Walking into things only nudges them, and a carried object bumps into others without
  shoving them: arranging never knocks the room over.
- **KIR / BREAK**: only inside the room, away from the doorway, with something breakable present.
  The door locks; damage, rewards, stress meter and combo are active. Arrange is not available
  until the break ends.
- **TEMİZLE / CLEANUP**: the door opens, tools are lowered (no attacks); grab and throw work, with
  the same gentle carrying as in arrange mode. The HUD counts disposed / total pieces and announces
  a clean room.

Walking into objects pushes them like a person would: horizontally, slower than the player
(75% of the player's speed, at most 350 N, while breaking; 35%, 150 N and a soft start otherwise).

## Saves and profiles

- Local profiles (up to 5 per browser), each with 3 save slots and its own settings. A save is keyed
  `installation/profile/slot` in IndexedDB; profile metadata lives in localStorage.
- A save holds credits, tools, deliveries, storage, every object (pose, damage, marks, parts), every
  major piece, claimed finds, the reward ledger, statistics, tutorial flags and playtime.
- Autosave after changes and every 60 s; manual save from the pause menu. Each write keeps the
  previous good save as a backup, both with a checksum: a corrupt save falls back to the backup.
- Schema version 3, with migration from older saves.
- Main menu: Continue, New game, Saved games, Settings, profile switch. Pause menu: Resume, Save,
  End break (during a break), Settings, Main menu.

## Porting notes (Godot)

- `src/data/*.json` is the design: materials, tools (including viewmodel grip and swing style),
  objects and the starter room. The schema is in `src/data/types.ts`.
- `src/config/gameConfig.ts` holds every tuning constant, grouped by system.
- The damage formula (`src/destruction/damage.ts`), stage rules (`stages.ts`), debris rules
  (`debrisRules.ts`), economy reducers (`src/economy/economy.ts`), the economy simulator and the
  session rules (`src/session/Session.ts`) are engine-free pure logic with unit tests: port them as
  they are and keep the tests.
- Saves are plain JSON (`src/save/schema.ts`), so a port can read web saves.
- Swing motions (`MOTIONS` in `src/player/Viewmodel.ts`) are camera-space keys (hand offset, tool
  direction, face direction) and do not depend on the model.
