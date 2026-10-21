# SKYLINE

A wingsuit proximity-flying sandbox in the browser. 151 km² of seeded,
eroded mountain range, a physical flight model, and no assets at all — every
piece of geometry, texture, sound and pixel of UI is generated in code.

## Running it

Copy the whole folder, then **double-click `Play SKYLINE.bat`** on Windows, or
`Play SKYLINE.command` on macOS and Linux. It starts the server and opens the
game. Leave the little black window open while you play; closing it stops the
game. The only thing it needs is Python, and it says so with a link if the
machine has not got it.

### On a locked-down machine

If you cannot install Python and cannot reach a web host — a school laptop,
say — build the whole game into one file instead:

```bash
python bundle.py
```

That writes `SKYLINE.html`: 42 modules, Three.js and the stylesheet flattened
into a single 1.8 MB page with nothing external in it. Copy that one file
anywhere and double-click it. No server, no Python, no network. See
`bundle.py` for how, and re-run it after changing the source or the file goes
stale.

Or do it by hand — no build step and no Node required:

```bash
python serve.py
```

Then open <http://127.0.0.1:8099/>. Add `--open` to have it launch the browser
for you, and a port number to override 8099. If that port is busy it steps up
to the next free one, so a second copy opens rather than failing.

**You cannot open `index.html` by double-clicking it.** Browsers refuse to load
ES modules and import maps over `file://`, so the page comes up blank. It has
to be served over HTTP, even though the server only ever talks to this machine.

`serve.py` is `http.server` with no-cache headers — browsers cache ES modules
hard enough that edits silently do nothing otherwise. `python -m http.server`
works too if you do not plan to change the code.

Three.js r169 is vendored in `vendor/three/` and wired through an import map,
so the game runs offline. Progress, records and purchases live in that
browser's local storage, so a different machine starts with a clean save.

## Controls

### Flying

Speeds read in **mph** and heights in **feet** by default; Settings has a
metric toggle.

| Key | Action |
|---|---|
| **H** | Spread your arms. Until you do, you are in freefall |
| **W** | Dive (nose down) |
| **S** | Pull up — climbs, bleeds speed, never stalls on its own |
| **A / D** | Bank left / right. Hold for a sustained turn; release to level out |
| **Mouse** | Pitch and bank (click the canvas to capture) |
| **Left button** *(hold)* + **S**/**Space** | Hard pull-up — rides the edge of the stall for about a second |
| **Left button** *(hold)* + **A**/**D** | Hard carving turn: bank and pull together, about 2.4x the turn rate |
| **Right button** + **A**/**D** | Flat spin |
| **Shift** *(hold)* | Fold the wings — near-vertical dive, up to 300 km/h |
| **Ctrl** *(hold)* | Tracking pose — best glide, 3.2 : 1 |
| **Space** *(hold)* | Flare. The only input that will stall you, and what you land on |
| **Space** *(tap)* | Roll inverted. A and D still turn the way they say they do |
| **G** | Deploy / cut away the parachute. Under canopy it steers on **A**/**D** and **Space** is the flare — put it down anywhere and the spot is saved as a respawn point |
| **← / →** | Yaw |

**You leave the cliff with your wings stowed.** Arms in, you fall head-down at
around 190 mph and steer like a skydiver. Press **H** and the wing inflates
with a whump — that is the moment the flight starts. Leave it late for the
speed, leave it too late and the ground arrives.

### On the ground

Fly slowly enough and you land on your feet instead of crashing: under about
30 mph onto ground that is not too steep. Summits, ledges and saddles are real
places you can stop.

| Key | Action |
|---|---|
| **W / S** | Walk forward / back. Shift to run |
| **A / D**, mouse | Turn |
| walk off the lip | Step off and fly. You start with the wing spread, so this is an exit, not a fall |
| **H** | Fold your arms first for a dive exit |
| **Space** | Jump off |
| **Hold J** | Save this spot as a respawn point |
| **Tap J** | Go back to your respawn point, standing where you left it |

Pull-up is deliberately safe: the angle-of-attack limiter holds you at maximum
lift. If you want to stall, hold Space.

### Tricks

| Key | Trick |
|---|---|
| **Q / E** | Barrel roll left / right. One roll per tap, however long the tap; hold through the end of a roll to keep going. Tap again mid-roll to stack a double, triple, … |
| **X + W / S** | Tuck flip, front or back |
| **Z + A / D** | Helicopter — flat spin, 360°, 720° and beyond |
| **R / F** | Front flip / back flip. Same rule as the rolls: one per tap, hold to keep flipping |
| **O** *(hold)* | Corkscrew: roll plus a spiralling dive |
| **V** | Toggle inverted flight |
| **A + D together** | Prewind — hold before a trick to store rotation; the release is faster and worth more |

### World and view

| Key | Action |
|---|---|
| **Esc** / **Tab** | Pause menu — time of day, weather, map, challenges, settings |
| **M** | World map: pick any point and launch from it |
| **C** | Camera: chase → helmet → wingtip → cinematic → free |
| **J** | Hold on the ground to save a point, tap anywhere to return |
| **B** | Drop a respawn point where you are (works in the air too) |
| **I** | Respawn at the active point |
| **N** | Cycle respawn points |
| **L** (or **Y**) | Restart the run |
| **B** *(home)* | Shop — wingsuits, outfits, helmets and smoke trails |
| **X** *(home)* | Stats — everything you have flown, since the first run |
| **T** *(home)* | Learn to fly — nine steps, none of which can be failed |
| **R** *(home)* | Racing — fifteen steep ring courses, against the clock or against bots |
| **Enter** | Bank the run (locks the score into your records) |
| **U** | Toggle the HUD |

Every binding is rebindable in Settings → Controls. Gamepad is supported
(left stick pitch/roll, right stick yaw, triggers fold/track, face buttons
for tricks).

## Reading the HUD

- **Flight-path marker** — the cyan circle sits exactly where you are going,
  with your climb angle beside it. Green means you are climbing.
- **Nose caret** — the small chevron is where the body is pointing. The gap
  between it and the flight-path marker is your angle of attack.
- **Horizon and pitch ladder** — projected from the real camera, so bank and
  pitch are honest. Dashed rungs are below the horizon.
- **Close shave** — the bar fills as you fly near rock and builds your score
  multiplier, up to ×8. Touching anything resets it.
- **Vario** — the bar on the left. Find the rising air on windward slopes.

## What is in it

- **Terrain**: an authored dendritic ridge network (trunk ranges with
  procedurally grown spurs) shaped by domain-warped ridged multifractal noise,
  then eroded with 260k hydraulic droplets and a thermal talus pass. Baked
  flow and sky-occlusion maps drive wetness and ambient light. Quadtree LOD
  with shared index buffers and skirts; kilometre-scale sun shadows from
  raymarching the height texture.
- **Flight**: 90 Hz fixed-step rigid body with interpolated rendering. Lift
  and drag from angle of attack and pose-dependent wing area, post-stall
  separated flow, sideslip side-force, trim-angle stability. 2.6 : 1 neutral
  glide, 3.2 : 1 tracking, 300 km/h in a full tuck.
- **Air**: prevailing wind, ridge lift on windward slopes you can genuinely
  soar, afternoon thermals, mechanical turbulence near the ground.
- **Character**: a procedural skeleton, an auto-skinned body mesh and wing
  fabric rebuilt every frame from the bone positions, with billow, travelling
  ripples, taut flares and luffing when the flow separates. Poses blend from
  the physics through per-joint springs.
- **Tricks and scoring**: close-shave meter, variety decay, flow chains, risk
  tags, 88 challenges across five tiers plus mastery combos, persistent
  records.
- **Volumetric features**: eleven arches, natural bridges, tunnels, caves and
  spire fields that a heightfield cannot express. Each is a signed distance
  field blended with the local terrain, meshed with surface nets, and collided
  against with the same function that produced the mesh — so if it looks
  passable it is passable. Sites are searched for, not hand-placed: an arch
  looks for a notch with comparable abutments, a tunnel for a ridge with both
  mouths below the crest. Flying one scores.
- **World**: forests from a baked density map with a rocky treeline, boulder
  fields, named summits and launch points chosen by simulating the glide so
  every exit is actually flyable, respawn points, a shaded-relief world map.
- **Presentation**: analytic sky with time of day and weather, aerial
  perspective shared between terrain and sky, bloom, speed vignette, radial
  smear, chromatic aberration, goggle frost in the helmet cam, wingtip trails
  and spray particles.
- **Water**: alpine lakes with irregular shorelines, depth-graded colour,
  swell, sun glint and shore foam; a river ribbon that follows the channel
  floor the whole way down the valley; and waterfalls that trace the real
  fall line down the rock, with mist clouds at their feet you can fly
  through. Skim a lake just above the surface at speed and it chains; dive
  into it steeply or arrive too slowly and you ditch.
- **Audio**: entirely procedural — no samples. A pink-noise wind bed whose
  level and cutoff track airspeed, a hiss band that opens at speed, fabric
  flutter amplitude-modulated at a rate set by how hard the wing is loaded, a
  resonant whoosh that sweeps as rock goes past, a convolution tail built from
  decaying noise that opens up in canyons and cave interiors, thinner and
  quieter air at altitude, a vario tone when you find lift, transients for the
  wing opening, impacts, landings and gates, and a four-voice drone that comes
  up with your flow meter.

## Not built yet

Honest list, so you know what you are not looking for:

- Replay, auto-director, ghosts, photo mode, scout mode and the tutorial.
- Gap-thread detection in the scorer. Arch and cave flythroughs do score.
- Spire fields exist but are not yet dense enough to slalom properly.

## Tuning and decisions

See `NOTES.md`.
