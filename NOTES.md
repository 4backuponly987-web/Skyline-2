# SKYLINE — design, architecture and tuning notes

A browser wingsuit proximity-flying sandbox. Three.js r169, no build step, all
assets procedural.

---

## 0. Constraints discovered on this machine

- **No Node/npm** → no Vite, no Playwright/Puppeteer via npm. So:
  - Dev server is `python -m http.server` (Python 3.13 present).
  - Three.js is **vendored** at `vendor/three/three.module.js` (r169, pinned,
    fetched once from jsdelivr) and wired through an **import map**. The game
    runs fully offline, no CDN at runtime.
  - **No `examples/jsm` dependency at all** — post-processing, noise, meshing,
    sky and audio are hand-written. Fewer moving parts, full control.
  - Testing is done by driving the game in a real headless-ish browser pane:
    navigate to the dev server, read console errors, inject input events via JS,
    step the simulation deterministically through a debug hook, and screenshot
    from several camera rigs.
- `window.SKYLINE` is exposed as a debug/test handle (see §9).

## 1. Feel pillars

1. **Weight and speed.** You should feel 220 km/h in your chest: FOV stretch,
   camera lag and recovery, wind roar layering, fabric flutter, ground-rush
   particles, chromatic smear at the edges. Speed is *earned* in dives and
   *spent* in flares and turns.
2. **Trustworthy world.** Collision is computed from the same functions that
   build the visible surface. If it looks passable it is passable; if it looks
   solid it is solid. No invisible walls, no phantom rock.
3. **Readable air.** Ridge lift and thermals are physical, measurable and
   *visible* (drifting snow, wisps, a vario tone). Learning to read a slope is
   the skill ceiling.
4. **Forgiving to learn, deep to master.** Control is rate-based with
   stabilising damping, so a new player can hold a line 3 m off a ridge. Tricks,
   prewind, chain scoring and the close-shave meter are the depth.
5. **Beautiful at a glance.** Golden-hour alpine light, aerial perspective,
   real ridgelines. The title orbit has to sell it before any input happens.

## 2. Module layout

```
index.html              import map + loading screen + canvas
src/main.js             bootstrap, systems wiring, the game loop
src/core/               loop, input, settings, save, rng, noise, math, events
src/world/              field, erosion, sdf, features, mesher, chunks,
                        terrainMaterial, scatter, water, sky, wind, collision, pois
src/flight/             pilot (rigid body + aero), tricks, scoring, challenges
src/character/          rig (skinned proc mesh), fabric (wing cloth), poses, anim
src/render/             renderer, post, camera, fx
src/audio/              engine (wind, flutter, reverb, music layers)
src/ui/                 hud, menus, map, title, trickfeed, photomode, tutorial
src/replay/             recorder, director, ghosts
tests/                  standalone de-risking pages (terrain, mesher, rig)
```

## 3. Terrain generation

The riskiest part, and the second most important after flight feel. Four layers,
all deterministic from one seed:

**(a) Range architecture (hand-designed feel).**
A small set of authored *ridge spines* — polylines with width, height and
character parameters — are rasterised into a coarse elevation basis. This is
what stops the world looking like uniform noise hills: there is a main range
running NW–SE with a big glacial valley, a side range, a spur with a tower
field, and a high cirque. Spine influence uses distance-to-polyline with a
shaped falloff, so you get real valleys, saddles and passes between named peaks.

**(b) Noise detail.**
Domain-warped ridged multifractal (6 octaves, warp from 2 octaves of simplex)
for arete sharpness, plus billowed noise for shoulders and a high-frequency
detail band only applied at close LOD. Ridged noise gives knife-edge crests;
the warp kills the grid-aligned look.

**(c) Erosion (the thing that sells realism).**
A coarse grid (1024² over 8192 m, i.e. 8 m/px) is eroded once at load:
- **Hydraulic**: ~260k droplet simulations (Mei-style particle erosion) with
  sediment capacity, deposition, evaporation and inertia → real drainage
  networks, V-notch gullies, scree/alluvial fans at valley floors.
- **Thermal**: 40 relaxation passes clamping slope to a talus angle → believable
  scree slopes and rounded shoulders beneath cliffs.
The result is stored as a Float32Array and bilinearly sampled as the *base*
elevation; (b)'s high-frequency band is added on top at fine LOD only. The same
bake produces a **sky-occlusion (AO)** map and a **flow/wetness** map (used for
wet rock, river channels and lake placement).

**(d) Volumetric features (arches, caves, overhangs).**
Heightfields cannot express an arch, so signature features are authored as
**signed distance fields** composed from primitives (capsule, box, torus,
sphere, cone) with smooth union/subtract, blended against the local heightfield
SDF. Each feature is meshed once at load with **surface nets** (dual contouring
on a uniform grid, 2-3 vertices/m) into a normal BufferGeometry.

*The visual/collision contract:* the mesher and the collision query call the
**same** `featureSDF(p)` function. Inside a feature's footprint the heightfield
mesh punches a hole (quads whose centre is inside the footprint are skipped) and
the feature mesh — which includes the heightfield as part of its SDF — covers
that footprint completely, with a 4 m downward skirt at the footprint border to
hide the sub-decimetre isosurface/bilinear seam. The quadtree is forced to
maximum subdivision inside footprints so the hole-skip rule only ever applies at
the finest LOD. Collision dispatch is: inside footprint → SDF march; outside →
analytic heightfield. One rule, no ambiguity.

**Chunking / LOD.** Quadtree over the 8192 m world, node sizes 8192→64 m, 32×32
quads per node (1089 verts), vertical skirts on node borders to hide LOD cracks,
frustum culling per node, and a time-budgeted generation queue (6 ms/frame) so
streaming never spikes a frame. Vertex data is positions + normals + a packed
"surface" attribute (slope, altitude band, wetness, AO).

**Materials.** One terrain ShaderMaterial: triplanar procedural rock with strata
banding and crack lines, snow accumulation by slope/altitude/noise with a
sparkle term, ice sheen on glacier polygons, scree and moss variants, wet-rock
darkening near water and waterfalls. Sun shadowing is a 20-step raymarch of the
coarse height texture in the fragment shader (real moving ridge shadows at no
shadow-map cost), multiplied by the baked AO. Aerial perspective is applied in
the terrain and feature shaders from an analytic single-scatter atmosphere.

## 4. Flight model

Rigid body: position, velocity, orientation quaternion, angular velocity.
Fixed step **90 Hz**, max 4 substeps per frame, render interpolates between the
previous and current state.

Aerodynamics in body frame (forward = -Z, up = +Y):
- `alpha` = angle of attack between velocity and the body's chord plane.
- `CL(alpha) = CL_slope * sin(2*alpha)` shaped, peaking at `alpha_stall = 15.5°`,
  then collapsing to a post-stall plateau (separated flow).
- `CD(alpha) = CD0 + k*CL² + CD_sep(alpha)` where `CD_sep` ramps hard past stall.
- Wing area `S` scales with pose: folded 0.34, neutral 1.0, tracking 0.86 (with
  `CD0 * 0.72` — the glide pose), flare 1.30.
- Side force from sideslip gives knife-edge flight real cost.
- Coordinated turn comes out of the physics: bank tilts the lift vector, the
  horizontal component curves the path and the vertical component drops, so
  turning bleeds height and speed. A small amount of yaw-into-turn assist is
  added for keyboard playability.
- Air density falls with altitude (ISA-ish), so high air is fast and thin.
- Stall → tumble: angular impulse, control authority scaled to 35 %, recovery by
  tucking (reduces `S`, breaks the stall) — dramatic but always escapable.

Targets (verified in `tests/` and in-game telemetry):
- Neutral glide ratio **2.5 : 1** at ~41 m/s (148 km/h).
- Tracking pose **3.1 : 1**.
- Full tuck dive terminal **~300 km/h** (83 m/s).
- Flare converts ~22 m/s of speed into ~14 m of climb.

**Air.** `wind.js` returns a vector for any point: prevailing wind (direction
varies slowly with a noise LFO), **ridge lift** = `windSpeed * slopeFactor *
windwardDot * exp(-heightAboveSlope / 90)`, and **thermals** = noise-seeded
columns biased to sun-facing low-albedo rock, strongest in the afternoon. Both
feed the aero model through relative airspeed, so soaring a windward ridge really
does regain height.

## 5. Trick state machine

`tricks.js` runs one *primary* trick driver plus modifiers.

```
IDLE ──Q/E──► ROLL(n)  ──stack on re-tap──► ROLL(n+1) … ──► SETTLE ──► IDLE
     ──X+W/S─► FLIP(front|back) ──► SNAP_OPEN ──► SETTLE
     ──Z+A/D─► HELI(flat spin, 360/720/…) ──► RECOVER
     ──F────► CORKSCREW (roll + spiral dive, hold)
     ──V────► INVERTED (sustained pose, toggle)
     ──stall─► TUMBLE ──clean input──► TUMBLE_RECOVERED (bonus)
A+D held in IDLE accumulates PREWIND (0…1) which multiplies the next trick's
rate and its score, and shows as a wind-up in the rig.
```
Each state exposes `aeroModifier` (area/drag/stability scaling) so a flat spin
really does sink and a corkscrew really does accelerate, and `rigDrive` (the
additive animation layer). Tricks complete on rotation accumulated, not on a
timer, so they read honestly.

## 6. Character and animation

Fully procedural, no imported skeletons or meshes.

- **Rig**: 21 bones (hips, 3 spine, neck, head, clavicle/shoulder/elbow/wrist ×2,
  hip/knee/ankle ×2). Local rest transforms authored in code.
- **Body mesh**: a procedurally generated tube/limb mesh, auto-skinned (two
  nearest bones per vertex, inverse-distance weights, smoothed) into a
  `THREE.SkinnedMesh`, so limbs bend smoothly instead of reading as hinged
  capsules. Helmet, visor and suit panel seams are part of the same mesh with
  vertex-colour material IDs.
- **Fabric**: arm wings (shoulder→wrist→hip) and leg wing (hip→hip→ankles) are
  separate dynamic meshes rebuilt every frame from bone world positions, with
  (i) billow proportional to dynamic pressure, (ii) taut-ness that flattens the
  billow in a flare, (iii) travelling ripple noise whose amplitude scales with
  airspeed and whose wavelength shortens with tension, (iv) luffing (chaotic,
  large-amplitude, low-frequency) when separated/stalled. Double-sided with a
  thin rim.
- **Poses**: a library of per-bone quaternion offsets (neutral, tracking,
  folded, flare, bank L/R, knife L/R, inverted, tumble, takeoff crouch, run,
  landing stand, parachute hang) blended by weights derived from physics state;
  every joint runs through a critically-damped spring with slight overshoot so
  transitions have weight and settle.
- **Trick layering**: rolls and flips are driven head-and-shoulders-first
  (lead/lag offsets down the chain), then the wings snap open with a fabric pop
  (an impulse into the fabric ripple system plus an audio transient).

## 7. Scoring

- **Close shave**: per-frame nearest-surface distance from collision probes;
  `gain = f(1/distance) * g(speed)`; builds a meter and a multiplier up to ×8;
  any contact resets it. Shown as edge tension (vignette bloom + audio whoosh).
- **Style**: base value per trick × amplitude × speed band × risk tag (near
  rock / inverted / in a gap) × variety decay (repeats pay 55 % each time,
  recovering over ~40 s) × flow chain (chain multiplier grows while you keep
  linking inside 4 s windows).
- **Terrain tricks** are detected geometrically: gap thread (two surfaces within
  N m on opposing sides), arch/cave flythrough (entering a feature's portal
  volume), tree thread, lake/waterfall skim, ridge surf (sustained updraft +
  proximity), inverted skim.
- **Landing**: flare quality, slope, vertical speed and heading alignment grade
  into Perfect / Clean / Rough / Crash with a Perfect Landing bonus.
- **Banking** a run locks the score into records; clipping terrain drops the
  chain (but not the banked total).
- **Challenges**: 84 definitions across 5 tiers plus 8 mastery combos, each a
  metric + threshold evaluated from the run summary; PBs and lifetime stats in
  localStorage.

## 8. Performance budget (1080p, mid-range laptop, High preset)

| System | Budget |
|---|---|
| Terrain draw | ≤ 260k tris, ≤ 140 draw calls |
| Features | ≤ 40 meshes, ≤ 150k tris |
| Scatter (trees/rocks) | 4 instanced meshes + impostor billboards, ≤ 16 calls |
| Particles | 3 pooled systems, ≤ 4k live quads |
| Physics + collision | ≤ 1.2 ms/frame |
| Character + fabric rebuild | ≤ 1.0 ms/frame |
| Terrain streaming | ≤ 6 ms/frame hard budget, amortised |
| Post chain | bloom at ½ res (5 taps) + single composite |

Presets Low/Med/High/Ultra scale: render scale, view distance, LOD bias, shadow
raymarch steps, scatter density, impostor distance, bloom, DOF, particle caps.
Adaptive resolution nudges render scale to hold the frame target.

## 9. Debug / test hooks

`window.SKYLINE` exposes `{ game, step(n), teleport(x,y,z), setCamera(mode),
state(), errors }` so a browser automation pass can load the page, assert
`errors.length === 0`, deterministically advance the simulation, press keys
through synthetic `KeyboardEvent`s, switch camera rigs and screenshot.

---

## Tuning values (live)

| Name | Value | Note |
|---|---|---|
| `PHYS_HZ` | 90 | fixed step |
| `MAX_SUBSTEPS` | 4 | then time is dropped (tab switch safe) |
| `WORLD_SIZE` | 8192 m | 67 km² |
| `EROSION_RES` | 1024 | 8 m/px |
| `DROPLETS` | 260000 | hydraulic passes |
| `TALUS` | 0.62 | thermal slope clamp |
| `CHUNK_QUADS` | 32 | per node |
| `LOD_LEVELS` | 8 | 8192 → 64 m |
| `PILOT_MASS` | 86 kg | pilot + suit |
| `WING_AREA` | 1.62 m² | neutral reference |
| `CL_SLOPE` | 2.95 | per radian, shaped |
| `CD0` | 0.108 | neutral |
| `ALPHA_STALL` | 15.5° | |
| `BODY_RADIUS` | 1.15 m | collision sphere |
| `WINGTIP_SPAN` | 1.45 m | probe offset |
| `CLOSE_SHAVE_MAX` | 14 m | meter engagement distance |
| `FOV_BASE/MAX` | 62° / 94° | speed-mapped |

## Decisions log

- **No bundler.** Import maps + vendored Three means the project runs from any
  static server and there is nothing to break on a machine without Node.
- **Surface nets, not marching cubes**, for feature meshing: one vertex per cell
  gives cleaner topology, fewer triangles and much better normals for the same
  grid, and it is far less code.
- **No shadow maps.** A height-texture raymarch in the terrain shader gives
  kilometre-scale ridge shadows that a cascade would struggle with, and it costs
  one loop. The character gets a cheap projected contact shadow instead.
- **Segmented-capsule characters were rejected** in favour of a procedurally
  auto-skinned mesh: at chase-camera distance the hinge seams of capsules are
  exactly the "stiff" look the brief warns about.
- **Erosion runs on load, not offline**, so the seed box in the menu actually
  changes the world. The bake is chunked across frames behind the loading
  screen, with a progress bar, and takes ~2-4 s at 1024².

## Control model (revised after first play test)

The first playable build had three problems that all traced back to the same
instinct — modelling the *aircraft* rather than the *player's intent*.

1. **Pitch raised the trim angle straight past the stall.** Asking the suit to
   climb stalled it, every time. Now the commanded trim is capped at 96 % of
   the stall angle, and an angle-of-attack limiter fades out both the direct
   nose-up rate and the stabiliser's nose-up correction as the stall is
   approached. Stalling is reachable only by holding the flare (Space) or by
   running out of airspeed. Pulling out of a 300 km/h dive now goes from
   -60 m/s to +5 m/s vertical.
2. **Roll was rate-commanded.** Holding D rolled the suit over and over.
   Roll now seeks a bank angle (`maxBank` 1.30 rad at full input, `bankGain`
   3.4) and returns to level at `levelGain` when released. Tricks and the
   inverted toggle bypass this and command rates directly.
3. **The chase camera rolled with a sign.** A roll angle applied to the camera
   has a sign that is easy to get backwards, and backwards makes a right-hand
   bank read as a left-hand one. The camera now blends its *up vector* toward
   the pilot's (42 %, faded to 0 during a trick). There is no sign to get
   wrong, and a barrel roll spins the suit against a steady horizon instead of
   tumbling the world.

Trick inputs were also being dropped: edges were read inside the physics
substep loop, which runs a variable number of times per frame. They are now
latched once per frame.

## Development gotcha

Browsers cache ES modules aggressively enough that `python -m http.server`
will serve stale code after an edit — silently, so a fix looks like it did
nothing. `serve.py` sends `no-store`. Several apparent bugs during the build
were this.

## Revised tuning values

| Name | Value |
|---|---|
| `clAlpha` | 3.15 /rad |
| `alphaStall` | 17.5° |
| `trimRange` | ±15° (capped at 0.96 × stall) |
| `maxBank` / `bankGain` | 1.30 rad / 3.4 |
| `rollRate` (cap) | 2.35 rad/s |
| `response` | 8 /s |
| `coordYaw` / `yawDamp` | 0.85 / 0.9 |
| ridge lift factor | 2.75 × wind, e-folding 115 m |
| camera distance / bank follow | 7.6 m / 0.42 |

## Volumetric features: what the build taught

Five things went wrong in a row, and each is worth remembering.

1. **Triangle winding.** Surface nets emit one quad per sign-changing grid
   edge, and the winding has to turn the front face toward the empty side.
   Backwards, the mesh renders as dark ragged shapes you can see through — it
   looks like broken geometry rather than a culling problem, which sent me
   looking in the wrong place. The tell was that `side: DoubleSide` fixed it
   completely, which it only can if the vertices and normals are already
   right.
2. **The box has to contain the terrain.** A feature's surface-nets box was
   sized to the feature. On a hillside the terrain inside the footprint spans
   far more than that, so in the corners there was no sign change, no mesh —
   and since the heightfield had already been removed there, you could see
   sky through the mountain. `fitBounds` grows the box to the terrain's own
   range inside the footprint.
3. **Hole masks, not hole boxes.** Removing the heightfield over a tunnel's
   whole bounding box is wrong: the terrain over the middle of the ridge is
   still correct and nothing would fill the gap. Each feature now carries a
   4 m boolean mask marking only the cells where the terrain surface actually
   passes through its box — for a tunnel that is the two mouths; for an arch
   it is the whole footprint.
4. **Arch proportions.** The first opening was 80 % of the span, which leaves
   legs too thin to read as rock, and an ellipsoid block tapers to nothing at
   exactly the ends where an arch needs its legs. Now: a rounded box, and the
   opening capped at 31 % of the span.
5. **Site search beats hand-placement.** Authored coordinates landed arches on
   cliff faces where they vanished into the hillside. Sites are searched for
   instead, with explicit landform tests — an arch wants a notch with
   abutments of comparable height and air across the span; a tunnel wants a
   ridge with both mouths well below the crest. Anything whose box ends up
   more than 3.2x taller than it is wide is rejected rather than built badly.

Terrain skirts were also cut from `step*5+8` to `step*1.5+3`: at coarse LOD
the old depth produced 300 m curtains hanging in open air below every ridge,
and punching holes for features made them visible.

Feature budget: 11 features, 336k triangles total, 1.5 s to build, and only
those within 1700 m are drawn (beyond that the heightfield closes over them).

## Wings stowed vs deployed

The suit now starts every cliff exit with its wings stowed. That is one
boolean (`wings`, damped 0..1) feeding three places:

- **Aero**: reference area scales from 8 % to 100 %, and the parasite drag
  area crossfades to `stowedCdA0` 0.205, which puts head-down terminal at
  about 86 m/s (193 mph). The dive is fast because there is no lift, not
  because there is less drag.
- **Stability**: the trim angle of attack scales with `wings`, so stowed the
  body simply follows the airflow. No trim point, no lift, no stall and no
  tumble — freefall does not stall.
- **Pose**: a `dive` pose with the arms in tight, and the fabric's billow and
  luff multiplied by `wings`, so the wing visibly has no air in it.

Deploying is `damp(wings, 1, 6.5)` — about a third of a second — with a
fabric-pop impulse, a camera kick and an audio whump.

## Landing and the ground state

Two ways down. Arrive under `landSpeed` (16 m/s, so the 30 mph the brief asks
for always works with room to spare) with an impact under 12 m/s on ground
flatter than 0.62, and you land on your feet. Arrive faster and you need the
flare. Landing no longer ends the run: you stand up, can walk (camera-relative
WASD), save the spot, and step off again with Space.

## Audio

All procedural. The one idea behind the mix is that you are listening to air:
everything except the transients and the drone is noise through a filter whose
cutoff and gain are functions of airspeed, wing loading or proximity.

Reverb wet is driven by an "enclosure" estimate rather than a room test:
`smoothstep(62, 12, nearest) * 0.75 + insideRock`, where `insideRock` is true
when the pilot's height above the heightfield is negative — which is exactly
and only the case inside a tunnel or cave.

## Water

Nothing about the water is in the heightfield. The terrain already dishes a
basin under each lake and trenches the valley for the river, so the
collidable ground is the bed and the water is a surface drawn on top. That is
what makes skimming fall out for free: you are flying a couple of metres over
the bed, and the only job the water has is to decide whether that counts as a
graze, a splash or a ditching.

Four things went wrong worth remembering:

1. **Authored lake levels.** `Lac Blanc` was written at 878 m and its valley
   floor eroded to 444 m, so the "lake" was a sheet of water hanging 434 m in
   the air. Levels are now a hint: after the erosion bake each lake is pinned
   to `coarseHeight(centre) + 3.5`, and the basin is dug relative to that.
2. **Circular everything.** The first lakes were perfect discs. The basin
   radius is now perturbed by noise sampled on a ring (so it stays continuous
   all the way round), and `surfaceAt` asks the ground rather than a circle —
   there is water exactly where the basin floor is below the water line,
   which is the same test the mesh was built from.
3. **A monotonic river.** Forcing the surface to only ever descend from the
   first station left the ribbon hanging in mid-air wherever the authored
   path crossed higher ground. Each station now simply sits 0.8 m above its
   own channel floor (verified: max height above ground across all 232
   stations is 0.80 m). Stations with no channel break the ribbon into
   separate runs instead of stretching a quad across the gap.
4. **Waterfalls through rock.** Dropping a flat sheet vertically from the lip
   buried 12 of 13 sample points inside the hillside. Falls now trace the
   steepest-descent line and every vertex sits on its own piece of ground,
   pushed out along the surface normal — so a vertical face reads as a free
   fall, a steep one as a chute, and none of it is ever inside the mountain
   (now 0 buried samples of 58).

Mist is a volume query (`mistAt`) rather than a collision: it drives a bright,
flat, desaturating veil in the composite pass, opens the reverb, raises the
waterfall roar and awards a trick when you fly through at speed.

## The standing exit, and why the mountain has walls carved into it

Measuring beat reading here. Instrumenting the flight model from a real
launch turned up four separate faults that all presented as "you die off
spawn":

1. **Every launch started inverted.** `Pilot.lookAlong` built its basis as
   `up = cross(fwd, right)`, which is left-handed; it needed
   `cross(right, fwd)`. Bank read 173 degrees at frame 0 and took two and a
   half seconds to roll upright, by which time the dive was unrecoverable.
   Every launch, respawn and ground jump went through it.
2. **The air was a gale.** Ridge lift was `windSpeed * 2.75`, so fair
   weather put 22 m/s of updraft on a lip, and the 9 m/s prevailing wind
   cancelled most of a cliff exit's airspeed. Lift is capped at 0.85x now
   and the presets run 4.5-12.5 m/s.
3. **The wing was too small.** At `clAlpha` 3.15 the suit only supported its
   own weight near 126 mph, so an exit had to convert 200 m of altitude into
   speed before it flew at all. It now settles at 80 mph, 2.6:1 and 12 m/s
   of sink, and establishes in about 80 m.
4. **There was nowhere to jump from.** Hydraulic and thermal erosion relax
   the field towards the talus angle, so nothing on the mountain exceeded
   about 58 degrees. A standing exit needs roughly 100 m of fall in the
   first 50 m of travel, which is 63 degrees, so *every* site was a slide.

The fourth one is why `SCARPS` exists. Each authored launch has a headwall
cut under it in `postCarve`: a levelled rim about 85 m deep and a 390 m wall
at 69 degrees. It is analytic rather than baked, so the lip stays sharp at
any LOD and collision is exactly the surface you see, and the carve only
lowers ground (except on the rim, which is levelled) and fades to nothing at
its edges, so it cannot introduce a step. Its direction is chosen after the
bake by scanning for the heading that keeps falling away -- several authored
headings pointed at ground that climbs again a few hundred metres out.

Two numbers worth keeping: `DIVE_PROFILE` and `STEP_OFF_PROFILE` in
`pois.js` are measured from the flight model itself, not estimated, by
flying it in free air with the terrain stubbed out. The first guessed table
was optimistic by a factor of two in the near field, which is precisely why
the site search kept choosing cliffs that killed you.

## Making the standing exit comfortable

Surviving is not the same as being any good. Three more things were wrong:

**Everyone left the ground already in contact.** `standHeight` is 0.95 and
`bodyRadius` is 1.15, so a pilot who had been stood up was inside their own
collision sphere, and the very first sweep after leaving the ground always
reported a hit. On gentle ground that passed the `slow` test and landed you
again the instant you stepped off; on a steep wall it failed every test and
crashed you. `Pilot.leaveGround` now lifts clear first, which is also why
Space-to-jump used to put you straight back on your feet.

With that fixed the wall could be steepened from 69 to 76 degrees. Measured
against `STEP_OFF_PROFILE` that is 37 m of air twenty metres off the lip and
110 m at fifty, where 69 degrees gave nine. Each headwall is also nudged up
to 400 m from its authored point at bake time, picking the position and
heading whose clearance stays positive furthest out -- Mesa Rim and Lac
Blanc Shoulder were both sitting in bowls.

All ten launches, walking and running, now fly for 24 s with no input at
all after the step-off, covering 443-862 m, with 72-439 m of clearance
three seconds off the lip.

**The ground character was standing on its head.** Measured from the rig,
the feet sat 0.93 m *above* the hips. The base pose is prone with the legs
trailing along +Z, so standing has to swing the thighs down, which is +X;
they were -X, folding the legs up over the back. The arms were a separate
error: they hang by rotating about the chest's Y, and an X rotation at the
shoulder runs along the arm, so both arms stayed over the head. It now
measures head +0.45, hands -0.36, feet -0.94 -- a person.

**The camera sat inside that person's head.** `avoidTerrain` casts from the
pilot's origin, which when stood up is 0.95 m above the ground, so the ray
grazed the pilot's own hillside and pulled the camera in to its 1.2 m
minimum. It casts from chest height now, and the grounded case gets its own
framing rather than the chase shot.

## Two rendering bugs that looked like "glitches"

The canvas had `position: fixed; inset: 0` and no CSS width or height. A
canvas is a replaced element, so it lays out at its drawing-buffer size --
and adaptive resolution scales that buffer down to 0.58 when the frame rate
dips. The picture visibly shrank into the top-left corner of the window with
black around it, which is exactly what the screenshots showed.

The moon disc did `mix(col, moonColour * uMoonBright, e)`. In daylight
`uMoonBright` is zero, so the disc blended the sky towards pure black and
painted a black hole on it. The brightness scales the blend now, not the
colour.

## The parachute

There was canopy physics but nothing drawn, which made deploying feel like
a bug. `character/canopy.js` builds a seven-cell ram-air out of numbers: a
cambered sheet swept round a shallow anhedral arc, with a line set down to
the risers. It inflates from a bundle, breathes while it flies, banks when
you steer and pulls its tail down when you flare. The flight model gives it
a 1.2:1 glide at about 6 m/s of descent, and the flare roughly doubles the
lift for a second.

The landing rule matters more than the numbers. Any ground you could stand
on is a landing, and brushing a face at under 9 m/s under an open canopy is
a scrape you slide down rather than a crash -- it used to kill you for
touching an 85 degree wall at walking pace. A canopy landing also saves the
spot, so anywhere you can put it down is somewhere you can start a run
from.

## Performance, and the "flickering"

Two things, neither of them where you would look first.

The terrain's sun shadow is a per-pixel ray march, and it ran its full
fourteen steps on every pixel out to the horizon. Falling to four steps by
4.2 km -- where terrain is a few pixels across and buried in aerial
perspective -- took the test scene from 30 fps at a 0.9 render scale to 60
at full scale. Nothing visible changed.

The flickering was the adaptive resolution hunting. It nudged the scale by
a few percent every half second whenever the frame rate sat outside a
ten-frame window, and every nudge resizes the canvas and all five post
render targets. It now waits 2.5 s, needs the rate outside 46-70, and
quantises to five steps.

Worth remembering for anything else that resizes: a canvas is a replaced
element, so with no CSS width or height it lays out at its drawing-buffer
size, and scaling that buffer scales the picture on screen.

## Making the world bigger

8.2 km square became 12.3, so 67 km of mountain became 151. Everything that
cares about scale already derived from `WORLD.size` and the three
resolution constants, so the change was: scale the resolutions with it
(1536 / 768 / 384) to hold 8 m per erosion cell, scale the hydraulic
droplet count with the area, and author ground to put in the new ring.

Six new ranges run out from the ends of the inner ridges rather than
standing apart from them -- the Gendarme Chain past the Teeth, a big north
face, an east rampart, a hanging cirque, rolling meadow in the south and a
western rim -- with five new launches on them. The highest summits stay in
the middle on purpose, so the core still reads as the centre of the range.

Two things fell out of it:

1. **Launches near the edge flew you off the map.** A headwall picks its
   own direction at bake time, and out there the best-scoring line pointed
   straight out of the world. The scan now takes a heavy penalty for any
   sample within 400 m of the boundary, and the outer ranges were pulled in
   a few hundred metres.
2. **Near-vertical faces showed the height texture as a grid of shadow
   blocks.** The sun shadow marches the 8 m coarse grid, and on a wall many
   screen pixels fall inside one texel. The march start is jittered per
   pixel now, which turns the banding into fine noise that reads as rock.

Bake is about 11 s for the whole 151 km.

## A post-processing bug worth remembering

Chromatic aberration ran *after* the radial smear and assigned
`col.r` and `col.b` from fresh `tDiffuse` samples, while `col.g` kept the
smeared value. Red and blue came from the sharp image and green from the
blurred one, which split the picture into magenta and green. It had always
been wrong and was invisible only because the smear never ran below 85 mph
-- above the speed the suit cruises at. Both are radial rescalings of the
same image, so they are now one pass that samples the three channels at
slightly different radii.

## Credits, the shop, and racing

**Everything in the shop is cosmetic, on purpose.** A wingsuit that flew
better than another one would make every challenge mean something different
depending on what you had bought, and the whole scoring and challenge
system rests on every run being flown by the same suit. So you buy looks:
nine wings, seven outfits, seven helmets and eight trails, and you earn
them by flying.

Recolouring is a rewrite of a colour attribute, not a rebuild: every vertex
of the body remembers which palette slot it came from and every vertex of
the wing remembers whether it is leading edge, so `Rig.recolour` and
`Fabric.recolour` just walk the buffer.

Credits come from challenges, which pay more the harder the tier
(60 / 150 / 380 / 850 / 1800), and from beating bots. The challenge targets
were all raised at the same time -- the old Legend speed target was 300
km/h when the suit will do more than that in a tuck.

**The ten race courses are grown from the terrain, not authored**, because
that is the only way to be sure they are flyable. Each ring is placed by
walking forward from the last along whichever heading keeps the straight
line to it clear of the ground, and the height is not a choice at all: it
is exactly the altitude the suit loses covering that distance. Three things
that had to be got right:

1. **Check the segment, not the ring.** The first version put every ring
   comfortably in the air and ran five of the ten lines straight through a
   spur in between.
2. **Match the glide exactly.** A course steeper than the glide makes you
   dive between every ring; flatter and you sink out of it. At the suit's
   own 2.6:1 following the line is a steering problem, which is the game.
3. **Try a shorter step before giving up.** Squeezing between two spurs is
   what keeps a course going; without it they ended after eight rings.

Bots run the course line at a pace rather than flying it. That is honest
about what they are -- a time you can see -- and avoids an AI pilot that
flies into a cliff and makes the race meaningless.

Verified by walking a point along each course line: all ten register every
ring and finish, and every run-in clears the ground by at least 35 m.

## Raising the range, and walling it

The world was 12.3 km wide and 3.1 km tall, and almost all of the flyable
ground sat inside a single kilometre band -- which is why it felt like
there was nothing to do: about forty seconds of glide and nothing to aim
at. `relief.js` now stretches everything above the valley floor by 1.66,
and ridges authored low are first scaled about the floor until they reach
2.5 km, so the outer country stands up instead of staying a plain. Launches
sit between 2.4 and 4.1 km with close to four vertical kilometres under
them.

An invisible boundary is worse than none: you fly towards what looks like
open country and watch the terrain tear itself apart at the edge of the
loaded area. The range is ringed by five kilometres of rock, rising 1.5 km
from the edge and sheer by the last 400 m, so the question never comes up.

Raising the range exposed one thing in the shader: the rock strata were a
single sine on altitude banding every 114 m, which is invisible on ordinary
ground and reads as corduroy on a sheer face, where forty of them stack up
the screen. Two frequencies, a much wider warp, and easing them off as the
ground stands up.

## Things that were quietly dead

Two bugs worth remembering, both of the same shape -- a thing that looked
implemented and was not running at all:

**Saved key binds replaced the default table instead of merging over it.**
A table written before an action existed has no keys for that action, so
the action is dead for anyone who had ever opened Settings. That is why the
left-button hard manoeuvre and the flat spin "did nothing": they had no
binding. Merging over the defaults fixes it for every action added later
too.

**Escape was handled after the title screen's own shortcuts**, and that
branch returned early. So on the title screen -- which is exactly where you
open the shop and the challenge list from -- Escape did nothing and the
only way out of a long panel was to scroll to the bottom. It is handled
first now, and every overlay has a close control pinned to the corner.

Also: inverted flight is a roll of the *drawn* body about its line of
flight, not of the flight model. Rolling the aerodynamics upside down
points the lift at the ground and takes the controls with it, which is
unflyable; this way it looks like what it is and left is still left.

## The race that looked like it never started

Clicking a race did start the race -- rings laid out, clock running, four
kilometres up -- and drew the title screen on top of it. Closing a menu
asks the UI to put the title back if the game is still in title mode, and
the UI closes *before* the launch sets the mode, so from the title screen
you ended up looking at SKYLINE over a live race. Clicking Fly on it then
sent you to the default spawn, which is what "races do not work, it just
spawns me back at the main spawn point" actually was.

Every entry into flight now goes through `enterFlight()` first, which sets
the mode and hides the title before any menu closes.

## Making the races downhill

The courses descended at exactly the glide the suit holds hands-off, on
the reasoning that following the line should then be a steering problem.
That was the wrong call: one gradient the whole way down is slow, it never
builds speed, and a 2.4 km course only used 900 m of a mountain with four
kilometres of vertical in it.

They now prefer 1:1.45 and fall back towards the glide only where the
terrain leaves nowhere steep to go, so a course drops 600 to 1600 m and
you fly it diving. Diving is always available to the player, which is why
a line steeper than the glide is fair and a flatter one is not. Par is set
against 46 m/s rather than the 36 m/s hands-off cruise, because that is
what you actually hold on one of these.

Rings are oriented along the line through them, pitch included -- at 1:1.4
a ring standing bolt upright is one you fly past the top of.

Missing a ring ends the run. A time penalty made a missed gate something
you shrugged at.

## Audio

Wind scaled to a 210 mph top speed, so normal flight -- 80 to 140 -- sat
at about a sixth of the available volume and sounded like nothing was
happening. It scales to 160 now and the filter opens with speed as well,
so going faster gets both louder and brighter.

The crash was a filtered noise burst and a sine thump. It is now four
things at once: the weight of the impact, the slap of the body on rock,
a long debris tail, and -- above a threshold, so a scrape does not get one
-- a shout. The shout is two detuned saws through band-passes sitting
where the first two formants of an open vowel sit, with the pitch falling
as the breath goes. That is about as close to a voice as you get without a
sample, and close enough buried under a rock impact.

## Learn to fly

Nine steps, in the order you need the things in: get off the hill, get the
wing working, point it, go fast, go slow, turn hard, get close, throw
something, put it down. Each one is a short explanation and a test, and
none of them can be failed -- a step stays up until you do it, because the
point is to teach the suit rather than examine you on it. Run out of air
part way through and it puts you back up rather than ending the lesson.

The tests are written against a snapshot the game hands it each frame
(`state`, `speed`, `glide`, `vario`, `closest`, `tricks`, `heading`,
`hard`), so the tutorial knows nothing about the rest of the game and
nothing else knows about the tutorial.

## Finding the arches

There are fifteen volumetric features -- arches, caves, tunnels, roofs,
spires -- and the complaint was never seeing one. They are all present and
placed; the problem is that they only draw within 1700 m of you, and 1700 m
is nothing in a 12.3 km world.

Raising that range does not work. A feature footprint forces its chunks to
the finest LOD, because a hole punched into a chunk that is drawn without
its feature shows daylight straight through the mountain. The range is
therefore a direct multiplier on triangle count: at 2500 the test scene
went from 117k triangles at 60 fps to 536k at 30. Scaling the features
themselves up by 1.7 to match the taller range broke one of them outright
-- it rendered as a black box, the SDF no longer fitting its volume.

So the range stays where it is and the HUD points at the nearest one
instead: name and distance, with an arrow that is a relative bearing, out
to 3.4 km. You can now aim at an arch from well before you can see it.

Worth knowing: being within a feature's footprint costs roughly half the
frame rate, 60 down to 30, and most launch sites have a feature within a
few hundred metres. That is not new and it is not fixed.

## Saving

The save was written on a three-second timer driven from the render loop,
and nowhere else. Close the tab, switch away, or reload inside that window
and everything since the last write was gone -- which is how a race time
you had just set disappeared. It now writes on `beforeunload`, on
`pagehide` and when the page is hidden, the timer is down to 1.5 s, and
shop purchases flush immediately. Verified by writing a best time, a
credit balance and a purchase, reloading the page, and reading them back.

## The camera at the lip

The grounded camera and the flight camera were a hard switch at 1.6 m of
ground clearance, so stepping off a lip cut between two quite different
framings in one frame -- a throw across the scene at exactly the moment
you need to see where you are going. They are blended over about half a
second now. Measured off a cliff launch with Shift and W held from the
first frame: 1.2 m of camera movement in the worst frame, where it used to
jump the whole gap at once.

## The gate that would not count

Two separate faults, both in the same two lines of the crossing test.

The plane each ring was tested against came from `r.h`, the heading the
course growth used to step *to* that ring. For every ring but the first
that is roughly the direction you fly through it. For the first ring it is
the heading from the launch the course grew out of -- which is not where
the race starts you, since the start is extrapolated back along the
ring0-to-ring1 line instead. Where those two directions differ by more
than ninety degrees you begin on the far side of the plane, the crossing
`d0 < 0 && d1 >= 0` can never happen, and the gate simply never counts.
Rampart Run and Westwatch Drop were both like that.

The plane was also flat -- only x and z. The courses drop at about 1:1.4
and a tucked dive is far steeper than that, so arriving fast and steep
crossed the plane well above or below the centre and failed the radius
check. That is the "holding Shift stops it registering" report: not speed,
angle.

Both come from the same fix: each ring stores a real 3D normal, previous
point to next, built from the same path the mesh is oriented by -- so what
you aim at and what counts are now the same vector. Verified by flying a
straight line into the first gate of all fifteen courses, level and from
140 m above, and by running every course end to end.

## Twenty-six waterfalls that were never there

The first load after the race fix threw 364 console errors, all of them
three's "Computed radius is NaN", in pairs: one indexed geometry, one not.
That pairing is `addFall` -- the ribbon mesh and the mist Points, built one
after the other.

`addFall` sizes the ribbon from `lip.half`. River stations carry a
half-width because the river is built from them. The flow-placed falls are
scored off the flow map and their candidate object had no `half` at all, so
`width` was NaN, every vertex of both the sheet and the mist was NaN, and
all twenty-six of them silently rendered nothing. Only the three river falls
were ever visible -- which is why the place looked short of water however
many the builder reported.

The candidates now carry a half-width of their own, scaled by catchment, so
a bigger flow earns a wider fall; and `addFall` falls back to a default
rather than trusting the field to exist. Twenty-nine falls, widths 11 to 34,
nothing NaN in the scene and a clean console on load.

## One file, no server

The game needs a server only because browsers refuse to *fetch* ES modules
over file://. An inline `<script type="module">` is not fetched, so it is
allowed -- which means the whole thing can be flattened into one HTML file
that runs off a USB stick with nothing installed.

`bundle.py` does it in about two hundred lines: walk the import graph from
`src/main.js`, rewrite each module into a function of `(__x, __req)`, sort
them so dependencies come first, and emit one inline module. Imports become
destructuring (`import { a as b }` -> `const { a: b } = __req(...)`), exports
become assignments at the end of the body so function hoisting still works,
and the single dynamic import resolves straight to the exports object, which
`await` is happy to accept.

It is deliberately narrow. It handles exactly the syntax this codebase uses
and raises on anything else -- `export default`, `export *`, an import cycle
-- rather than quietly emitting a broken game. The cycle check matters:
destructuring snapshots a value at require time, so a cycle would hand
someone `undefined` instead of failing. `relief.js` exists because of one
such cycle, and the bundler confirms there are no others.

Verified by playing the built file: boots clean, 29 waterfalls, 15 courses,
and a full race from first gate to finish with an empty console. Nothing in
the test rig here can open a file:// URL, so the double-click itself was
confirmed by hand on Windows -- opened from Explorer, it runs.

## Known issues

- Yanking out of a full tuck dive can still produce a brief (<1 s) tumble.
  That reads as correct — it is recoverable and the scorer pays for the
  recovery — but it is worth watching.
- Flying a cave end to end needs real piloting: the bore bends, so a straight
  line clips the wall. That is intended, but the entry portal awards at the
  midpoint, so a crash before then scores nothing.
- Lakes are shaped into the terrain but have no rendered water surface.
