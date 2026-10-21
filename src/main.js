// SKYLINE — bootstrap and the game loop.
//
// Fixed 90 Hz physics with interpolated rendering; everything else (streaming,
// animation, audio, UI) runs per frame.

import * as THREE from 'three';
import { TerrainField, WORLD, RIVER } from './world/field.js';
import { TerrainChunks } from './world/chunks.js';
import { makeTerrainMaterial } from './world/terrainMaterial.js';
import { Collision, buildProbeDirs } from './world/collision.js';
import { Wind } from './world/wind.js';
import { buildPOIs, POI_KIND, nearestPOI } from './world/pois.js';
import { Scatter } from './world/scatter.js';
import { FeatureSet, FEATURE_RANGE } from './world/features.js';
import { Water } from './world/water.js';
import { Canopy } from './character/canopy.js';
import { resolve as resolveCosmetics } from './game/shop.js';
import { buildCourses, Race, diffByKey } from './game/race.js';
import { Tutorial, STEPS as TUTORIAL_STEPS } from './game/tutorial.js';
import { RACE_CREDITS } from './game/shop.js';
import { Rng } from './core/rng.js';
import { Sky, WEATHER } from './render/sky.js';
import { makeLitMaterial } from './render/materials.js';
import { CameraRig } from './render/camera.js';
import { PostChain } from './render/post.js';
import { TrailRibbon, Particles, makeTrailMaterial } from './render/fx.js';
import { Pilot, FLIGHT_STATE, AERO } from './flight/pilot.js';
import { Tricks } from './flight/tricks.js';
import { Scoring } from './flight/scoring.js';
import { Wingsuiter } from './character/anim.js';
import { Input } from './core/input.js';
import { Save } from './core/save.js';
import { Hud } from './ui/hud.js';
import { AudioEngine } from './audio/engine.js';
import {
  clamp, clamp01, lerp, smoothstep, damp, DEG, setUnits, fmtSpeed, fmtAlt,
} from './core/math.js';

export const PHYS_HZ = 90;
const PHYS_DT = 1 / PHYS_HZ;
const FWD_AXIS = new THREE.Vector3(0, 0, -1);
const EMPTY_EDGES = {};
const UP_9 = new THREE.Vector3(0, 2.2, 0);
const TRAIL_COOL = [0.55, 0.78, 1.0];
const TRAIL_HOT = [1.0, 0.55, 0.22];
const MAX_SUBSTEPS = 4;

const QUALITY = {
  low: { scale: 0.62, shadowSteps: 7, rockOctaves: 2, splitK: 1.7, fine: 300, bloom: false, far: 12000, maxDpr: 1 },
  medium: { scale: 0.82, shadowSteps: 11, rockOctaves: 3, splitK: 2.1, fine: 380, bloom: true, far: 16000, maxDpr: 1 },
  high: { scale: 1.0, shadowSteps: 12, rockOctaves: 4, splitK: 2.5, fine: 440, bloom: true, far: 20000, maxDpr: 1 },
  ultra: { scale: 1.0, shadowSteps: 22, rockOctaves: 5, splitK: 3.1, fine: 560, bloom: true, far: 24000, maxDpr: 1.5 },
};

export class Game {
  constructor() {
    this.errors = [];
    this.save = new Save();
    this.quality = QUALITY[this.save.settings.quality] || QUALITY.high;
    setUnits(this.save.settings.units);
    this.canvas = document.getElementById('view');
    this.ready = false;
    this.paused = false;
    this.mode = 'title';
    this.time = this.save.settings.timeOfDay;
    this.weatherKey = this.save.settings.weather;
    this.acc = 0;
    this.frameCount = 0;
    this.fpsAcc = 0;
    this.fpsTime = 0;
    this.fps = 60;
    this.probeDirs = buildProbeDirs();
    this.worldProbe = new Float32Array(this.probeDirs.length);
    this.nearest = 999;
    this.nearestInfo = {};
    this.titleAngle = 0;
    this.lastLaunch = null;
  }

  // ------------------------------------------------------------------ init

  async init(onProgress) {
    const seed = this.save.data.seed || 'skyline';
    this.field = new TerrainField(seed);

    for (const step of this.field.bake()) {
      onProgress(step);
      await nextTick();
    }

    onProgress({ phase: 'scene', progress: 0.1, label: 'Lighting the sky' });
    this.setupRenderer();
    await nextTick();

    onProgress({ phase: 'scene', progress: 0.4, label: 'Carving the mountain' });
    this.collision = new Collision(this.field);
    this.wind = new Wind(this.field, this.field.noiseB);
    this.pois = buildPOIs(this.field);
    await nextTick();

    onProgress({ phase: 'scene', progress: 0.7, label: 'Dressing the rock' });
    this.terrainMat = makeTerrainMaterial(this.field, this.sky.uniforms, this.quality);
    this.chunks = new TerrainChunks(this.field, this.terrainMat, {
      splitK: this.quality.splitK,
      fineRadius: this.quality.fine,
      holeRange: FEATURE_RANGE,
    });
    this.scene.add(this.chunks.group);
    await nextTick();

    // Volumetric features. They share the terrain material, so an arch is
    // shaded by exactly the same rock, snow and aerial perspective as the
    // mountain it grows out of.
    this.features = new FeatureSet(this.field, this.terrainMat, new Rng(this.field.seed ^ 0xa17c), {
      cellSize: this.quality.scale >= 1 ? 3.2 : 4.2,
      maxCells: this.quality.scale >= 1 ? 88 : 64,
    });
    for (const step of this.features.build()) {
      onProgress({ phase: 'scene', progress: 0.42 + step.progress * 0.3, label: step.label });
      await nextTick();
    }
    this.scene.add(this.features.group);
    for (const h of this.features.holes) this.chunks.addHole(h.x0, h.z0, h.x1, h.z1);
    this.chunks.holeMask = (x, z) => this.features.hidesQuad(x, z);
    this.collision.features = this.features;
    for (const f of this.features.list) {
      this.pois.push({
        kind: POI_KIND.FEATURE, name: f.name, note: f.note || featureNote(f.kind),
        x: f.x, y: f.y, z: f.z,
      });
    }
    await nextTick();

    onProgress({ phase: 'scene', progress: 0.76, label: 'Filling the lakes' });
    this.water = new Water(this.field, this.sky.uniforms, {
      quality: this.quality.scale >= 1 ? 1 : 0.5,
    });
    this.water.build(RIVER);
    this.scene.add(this.water.group);
    await nextTick();

    this.courses = buildCourses(this.field, this.pois.filter((q) => q.kind === 'launch'));
    this.race = new Race(this.scene);

    onProgress({ phase: 'scene', progress: 0.80, label: 'Planting forests' });
    this.foliageMat = makeLitMaterial(this.sky.uniforms, {
      translucency: 0.55, specular: 0.04, shininess: 12, ambientBoost: 0.15,
    });
    this.scatter = new Scatter(this.field, this.foliageMat, {
      // Denser forest. The treeline moved up with the relief, so there is
      // a much bigger band for it to fill than there used to be.
      density: this.quality.scale >= 1 ? 1.6 : 1.05,
      maxNear: this.quality.scale >= 1 ? 3000 : 1600,
      maxFar: this.quality.scale >= 1 ? 11000 : 5000,
      farDist: this.quality.far > 16000 ? 1800 : 1300,
    });
    this.scatter.bakeDensity();
    this.scene.add(this.scatter.group);
    await nextTick();

    onProgress({ phase: 'scene', progress: 0.88, label: 'Suiting up' });
    this.setupCharacter();
    this.pilot = new Pilot(this.field, this.collision, this.wind);
    this.tricks = new Tricks();
    this.tutorial = new Tutorial();
    this.scoring = new Scoring(this.save);
    this.scoring.onPopup = (item) => this.hud && this.hud.pushFeed(item);
    this.pilot.onEvent = (k, d) => this.onPilotEvent(k, d);
    this.tricks.onEvent = (k, d) => this.onTrickEvent(k, d);

    this.input = new Input();
    if (this.save.data.binds) {
      // Merge over the defaults rather than replacing them. A table saved
      // before an action existed has no keys for it, so the action is dead
      // -- which is exactly what happened to the hard-manoeuvre button and
      // the flat spin: anyone who had ever opened Settings had no binding
      // for them at all.
      for (const action in this.save.data.binds) {
        if (this.input.binds[action]) {
          this.input.binds[action] = this.save.data.binds[action];
        }
      }
      this.input.rebuild();
    }
    this.hud = new Hud(document.getElementById('hud'), this.save);
    this.audio = new AudioEngine();
    this.audio.setVolumes(this.save.settings);
    // WebAudio will not start without a gesture, so arm it on the first one
    const arm = () => { this.audio.resume(); };
    addEventListener('pointerdown', arm, { once: false });
    addEventListener('keydown', arm, { once: false });
    this.camRig = new CameraRig(this.camera, this.collision);

    await nextTick();
    onProgress({ phase: 'scene', progress: 0.95, label: 'Streaming terrain' });

    // Prime terrain around the opening shot so the first frame is complete.
    const start = this.pois.find((p) => p.kind === POI_KIND.LAUNCH) || { x: 0, z: 0, y: 2000 };
    this.startPoi = start;
    this.camera.position.set(start.x - 700, start.y + 420, start.z + 700);
    this.camera.lookAt(start.x, start.y, start.z);
    this.camera.updateMatrixWorld();
    this.updateFrustum();
    this.chunks.prime(this.camera.position, this.frustum);

    this.ready = true;
    onProgress({ phase: 'done', progress: 1, label: 'Ready' });
  }

  setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.quality.scale >= 1,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.adaptive = 1;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.quality.maxDpr) * this.quality.scale);
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping; // the composite pass does ACES
    this.renderer.autoClear = true;
    this.post = new PostChain(this.renderer, {
      bloom: this.quality.bloom,
      smearTaps: this.quality.rockOctaves >= 4 ? 4 : 3,
    });

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.6, this.quality.far);
    this.sky = new Sky(this.scene);
    this.sky.resize(this.quality.far);
    this.frustum = new THREE.Frustum();
    this._pm = new THREE.Matrix4();

    addEventListener('resize', () => this.onResize());
    document.addEventListener('pointerlockerror', (e) => e.preventDefault?.(), true);
    document.addEventListener('visibilitychange', () => {
      // Open the menu rather than pausing silently: a silent pause with no
      // way back is just a frozen game when you alt-tab in again.
      if (document.hidden && this.mode === 'fly' && this.ui && !this.ui.stack.length) {
        this.ui.openPause();
      }
    });
  }

  setupCharacter() {
    this.bodyMat = makeLitMaterial(this.sky.uniforms, { specular: 0.2, shininess: 44, ambientBoost: 0.2 });
    this.fabricMat = makeLitMaterial(this.sky.uniforms, {
      specular: 0.16, shininess: 24, translucency: 0.8, side: THREE.DoubleSide,
      ambientBoost: 0.35, twoTone: true, underTint: [0.30, 0.33, 0.40],
    });
    this.suit = new Wingsuiter(this.bodyMat, this.fabricMat);
    this.scene.add(this.suit.group);
    this.suit.group.visible = false;

    this.canopyMat = makeLitMaterial(this.sky.uniforms, {
      specular: 0.1, shininess: 18, translucency: 0.9, side: THREE.DoubleSide,
      ambientBoost: 0.45, twoTone: true, underTint: [0.62, 0.20, 0.16],
    });
    this.canopy = new Canopy(
      this.canopyMat,
      new THREE.LineBasicMaterial({ color: 0x141a22, transparent: true, opacity: 0.8 }),
    );
    this.scene.add(this.canopy.group);

    this.trailMat = makeTrailMaterial();
    this.trailL = new TrailRibbon(this.trailMat, 72, 0.055);
    this.trailR = new TrailRibbon(this.trailMat, 72, 0.055);
    this.scene.add(this.trailL.mesh, this.trailR.mesh);
    this.particles = new Particles(this.quality.scale >= 1 ? 900 : 400);
    this.scene.add(this.particles.points);

    // after the suit and the trails exist, so it can paint both
    this.applyCosmetics();
  }

  onResize() {
    if (!this.renderer) return;
    this.renderer.setPixelRatio(
      Math.min(devicePixelRatio, this.quality.maxDpr) * this.quality.scale *
      (this.save.settings.renderScale || 1) * this.adaptive,
    );
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    const sz = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(sz);
    this.post.setSize(sz.x, sz.y);
  }

  updateFrustum() {
    this._pm.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this._pm);
  }

  // --------------------------------------------------------------- launching

  /**
   * Everything that puts you in the air goes through this first.
   *
   * Closing a menu asks the UI to put the title screen back if the game is
   * still in title mode, and the UI closes before the launch sets the mode
   * -- so starting a race from the title left the title screen drawn on
   * top of a running race. Clicking Fly on it then sent you to the default
   * spawn, which is exactly what "races do not work" looked like.
   */
  enterFlight() {
    this.mode = 'fly';
    const t = document.getElementById('title');
    if (t) t.classList.add('hidden');
    if (this.ui) this.ui._titleWasUp = false;
    const hud = document.getElementById('hud');
    if (hud) hud.classList.remove('hidden');
  }

  launch(poi, mode = 'cliff') {
    /* eslint-disable-next-line no-param-reassign */
    const p = poi || this.startPoi;
    const heading = p.heading !== undefined ? p.heading : 0;
    const dir = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
    const pos = new THREE.Vector3(p.x, 0, p.z);
    let vel;

    if (mode === 'hot') {
      pos.y = (p.y || this.field.height(p.x, p.z)) + 140;
      vel = dir.clone().multiplyScalar(52);
      vel.y = -10;
    } else if (mode === 'heli') {
      pos.y = (p.y || this.field.height(p.x, p.z)) + 600;
      vel = dir.clone().multiplyScalar(6);
      vel.y = -2;
    } else {
      // Cliff exit: you start on your feet, set back from the lip and facing
      // it, and walk or run off the edge yourself. The menu has always called
      // this "stand on the edge and go"; it used to drop you into the air at
      // 11 m/s instead, which is why the standing start felt broken.
      // The walkable spot found behind the lip at bake time. Without one
      // there is nowhere to stand at this site, so fall back to an exit
      // already in the air rather than spawning you on a vertical face.
      if (p.stand) {
        pos.set(p.stand.x, this.field.height(p.stand.x, p.stand.z) + 0.95, p.stand.z);
        vel = new THREE.Vector3(0, 0, 0);
      } else {
        mode = 'hot';
        pos.y = (p.y || this.field.height(p.x, p.z)) + 140;
        vel = dir.clone().multiplyScalar(52);
        vel.y = -10;
      }
    }

    this.enterFlight();
    if (this.ui && this.ui.stack.length) this.ui.closeAll();
    // On your feet you are already in the suit with your arms out; a
    // helicopter drop starts stowed, so you fall until you spread.
    const startWings = mode === 'heli' ? 0 : 1;
    this.pilot.reset(pos, vel, undefined, startWings);
    if (mode === 'cliff') {
      this.pilot.state = FLIGHT_STATE.GROUND;
      this.pilot.sinceGround = 0;
      // Face the lip itself, not just the exit bearing: you spawn a little
      // off to one side of it. stepGround steers on (sin, cos).
      this.pilot.groundHeading = p.stand
        ? Math.atan2(p.x - p.stand.x, p.z - p.stand.z)
        : Math.atan2(dir.x, dir.z);
      this.pilot.scanEdge();
    } else {
      const aim = dir.clone();
      aim.y = vel.clone().normalize().y;
      this.pilot.lookAlong(aim.normalize());
    }
    // Leaving a race by any route -- a new launch, retry, respawn, the map
    // -- has to take the race with it. It used to leave the rings, the bots
    // and a running clock on screen while you flew somewhere else entirely.
    if (this.race) this.race.clear();
    this.lastRace = null;
    if (this.tutorial) { this.tutorial.active = false; this.hud.hideLesson(); }
    this.tricks.reset();
    this.invert = false;
    this.scoring.startRun();
    this.camRig.initialised = false;
    this.mode = 'fly';
    this.suit.group.visible = true;
    this.trailL.reset();
    this.trailR.reset();
    this.lastLaunch = { poi: p, mode };
    this.runStart = performance.now();
    this.primeAround();
    document.getElementById('hud').classList.remove('hidden');
    this.hud.toast(p.name ? `${p.name} — ${fmtAlt(pos.y)}` : 'Launch');
    if (mode === 'cliff') {
      this.hud.hint('<kbd>W</kbd> walk to the edge  <kbd>Shift</kbd> run  <kbd>H</kbd> fold for a dive exit', 9);
    } else if (startWings < 0.5) {
      this.hud.hint('<kbd>H</kbd> spread your arms to fly', 8);
    } else {
      this.hud.hint('<kbd>W</kbd>dive <kbd>S</kbd>pull up <kbd>A</kbd><kbd>D</kbd>bank <kbd>Shift</kbd>fold <kbd>Q</kbd><kbd>E</kbd>roll', 9);
    }
  }

  /**
   * Start a race. `opponents` is a list of difficulty keys, empty for a
   * time trial. You begin already flying at the first ring's height, so
   * the clock measures flying and not how well you exited.
   */
  startRace(course, opponents) {
    if (!course) return;
    const first = course.rings[0];
    const dir = new THREE.Vector3(Math.sin(first.h), 0, Math.cos(first.h));
    // Back off from the first ring far enough to be flying when you reach
    // it, and high enough that the run-in is not through a hillside: two
    // of the ten started you inside the mountain.
    // Start ON the course line, extrapolated backwards from the first ring
    // along the direction you will fly through it. Backing off along the
    // ring's own heading and then lifting when the ground was in the way
    // could put you several hundred metres up on the wrong side of a
    // ridge, looking at a mountain with the first gate behind it.
    const second = course.rings[1] || first;
    const lineX = first.x - second.x;
    const lineZ = first.z - second.z;
    const ll = Math.hypot(lineX, lineZ) || 1;
    const bx = lineX / ll;
    const bz = lineZ / ll;
    const pos = new THREE.Vector3();
    const approachClear = () => {
      let worst = Infinity;
      for (let t = 0; t <= 1.0001; t += 0.04) {
        const px = pos.x + (first.x - pos.x) * t;
        const py = pos.y + (first.y - pos.y) * t;
        const pz = pos.z + (first.z - pos.z) * t;
        worst = Math.min(worst, py - this.field.height(px, pz));
      }
      return worst;
    };
    // Start high and well back, already flying, looking down the line at
    // the first gate. Starting level with it meant arriving at it with no
    // margin and nothing you could do about a gate you were already low
    // for; from 260 m above you can see the whole opening sequence and
    // pick your line into it.
    let back = 520;
    for (const b2 of [520, 430, 340, 260, 190]) {
      back = b2;
      pos.set(first.x + bx * b2, first.y + 260 + b2 / 2.6, first.z + bz * b2);
      if (approachClear() >= 40) break;
    }
    let guard = 0;
    while (approachClear() < 40 && guard++ < 24) pos.y += 30;
    dir.set(-bx, 0, -bz);
    const toFirst = new THREE.Vector3(first.x - pos.x, first.y - pos.y, first.z - pos.z)
      .normalize();
    const vel = toFirst.multiplyScalar(46);
    this.enterFlight();
    if (this.ui && this.ui.stack.length) this.ui.closeAll();
    this.pilot.reset(pos, vel, undefined, 1);
    this.pilot.lookAlong(vel.clone().normalize());
    this.tricks.reset();
    this.scoring.startRun();
    this.camRig.initialised = false;
    this.mode = 'fly';
    this.suit.group.visible = true;
    this.trailL.reset();
    this.trailR.reset();
    this.lastLaunch = { poi: this.startPoi, mode: 'hot' };
    this.lastRace = { course, opponents };
    this.runStart = performance.now();
    this.primeAround();
    this.race.begin(course, opponents, pos);
    document.getElementById('hud').classList.remove('hidden');
    this.hud.toast(course.name.toUpperCase());
    this.hud.hint(
      opponents && opponents.length
        ? `${course.rings.length} rings · ${opponents.length} opponent${opponents.length > 1 ? 's' : ''}`
        : `${course.rings.length} rings · time trial`,
      6,
    );
  }

  /** Called when the last ring is crossed. */
  finishRace(res) {
    const c = this.lastRace && this.lastRace.course;
    if (!c) return;
    const best = this.save.data.raceBest || (this.save.data.raceBest = {});
    const prev = best[c.id];
    const pb = prev === undefined || res.time < prev;
    if (pb) best[c.id] = res.time;

    let credits = 0;
    const ops = (this.lastRace.opponents || []);
    if (ops.length) {
      // paid for the hardest bot you actually beat
      for (const key of ops) {
        const d = diffByKey(key);
        const botTime = c.par / d.pace;
        if (res.time < botTime) credits = Math.max(credits, RACE_CREDITS[d.key] || 0);
      }
    } else if (pb) {
      credits = 20;
    }
    if (pb && ops.length) credits += 25;
    if (credits > 0) {
      this.save.data.credits = (this.save.data.credits || 0) + credits;
    }
    this.save.touch();
    this.save.flush();
    this.audio.bang('land', 0.9);
    this.hud.toast(
      `${res.placing === 1 ? 'WON' : `P${res.placing}/${res.field}`}  ${res.time.toFixed(2)} s`
      + (pb ? '  · PB' : '') + (credits ? `  · +${credits} cr` : ''),
      3400,
    );
    this.race.clear();
  }

  /** Learn to fly: a gentle site, and the steps from there. */
  startTutorial() {
    const poi = this.pois.find((p) => p.name === 'West Shoulder')
      || this.pois.find((p) => p.kind === 'launch')
      || this.startPoi;
    this.launch(poi, 'cliff');
    this.tutorial.start();
    this.hud.toast('LEARN TO FLY', 2200);
  }

  retry() {
    // Restarting inside a race restarts the race, not the launch it came
    // from -- otherwise L quietly drops you out of the event.
    if (this.lastRace) {
      const r = this.lastRace;
      return this.startRace(r.course, r.opponents);
    }
    if (this.lastLaunch) this.launch(this.lastLaunch.poi, this.lastLaunch.mode);
  }

  respawn() {
    if (this.race) this.race.clear();
    this.lastRace = null;
    const sp = this.save.activeSpawn;
    if (!sp) return this.retry();
    const p = this.pilot;
    // A point you saved standing on a summit puts you back standing on it,
    // not dropped into the rock at zero airspeed.
    p.reset(
      new THREE.Vector3(sp.x, sp.y, sp.z),
      new THREE.Vector3(sp.vx || 0, sp.vy || -6, sp.vz || -30),
      undefined,
      sp.onGround ? 0 : 1,
    );
    if (sp.onGround) {
      p.state = FLIGHT_STATE.GROUND;
      p.groundHeading = sp.heading || 0;
      p.sinceGround = 0;
      p.vel.set(0, 0, 0);
      p.pos.y = this.field.height(sp.x, sp.z) + 0.95;
    }
    this.tricks.reset();
    this.scoring.startRun();
    this.camRig.initialised = false;
    this.mode = 'fly';
    this.suit.group.visible = true;
    this.trailL.reset();
    this.trailR.reset();
    this.primeAround();
    this.hud.toast(`RESPAWN — ${sp.name}`);
  }

  setSpawnHere() {
    const p = this.pilot;
    const n = this.save.data.spawns.length + 1;
    const near = nearestPOI(this.pois, p.pos.x, p.pos.z);
    const name = near.poi && near.dist < 500 ? `${near.poi.name} ${n}` : `Point ${n}`;
    const onGround = p.state === FLIGHT_STATE.GROUND;
    this.save.addSpawn({
      name, x: p.pos.x, y: p.pos.y, z: p.pos.z,
      vx: p.vel.x, vy: p.vel.y, vz: p.vel.z,
      heading: p.groundHeading,
      onGround,
    });
    this.hud.toast(`RESPAWN SET — ${name}`);
  }

  /**
   * Builds every chunk the camera can see right now, ignoring the per-frame
   * budget. Used after a teleport: the streamer only swaps in a complete set,
   * so without this you arrive looking at an empty sky for a second.
   */
  primeAround() {
    const p = this.pilot;
    const dir = this._pv || (this._pv = new THREE.Vector3());
    dir.copy(p.vel);
    if (dir.lengthSq() < 1) dir.set(0, 0, -1).applyQuaternion(p.quat);
    dir.normalize();
    this.camera.position.copy(p.pos).addScaledVector(dir, -9).add(UP_9);
    this.camera.lookAt(p.pos.x + dir.x * 40, p.pos.y + dir.y * 40, p.pos.z + dir.z * 40);
    this.camera.updateMatrixWorld();
    this.updateFrustum();
    this.chunks.update(this.camera.position, p.pos, this.frustum, 1e9, true);
    this.scatter.update(this.camera.position, 1);
    this.features.updateVisibility(this.camera.position);
    this.water.setVisible(this.camera.position);
  }

  /** Back to the title screen from anywhere. */
  toTitle() {
    if (this.race) this.race.clear();
    this.lastRace = null;
    this.mode = 'title';
    this.suit.group.visible = false;
    this.trailL.reset();
    this.trailR.reset();
    this.input.exitLock();
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('title').classList.remove('hidden');
    this.setPaused(false);
  }

  /** Forces one frame so menu sliders preview immediately. */
  renderOnce() {
    try { this.render(1 / 60); } catch (e) { this.errors.push(String(e && e.message)); }
  }

  setPaused(v) {
    this.paused = v;
    if (v) this.input.exitLock();
  }

  // ------------------------------------------------------------------ events

  onPilotEvent(kind, data) {
    switch (kind) {
      case 'stall':
        this.hud.toast('STALL');
        this.camRig.kick(0.8);
        this.audio.bang('stall', 1);
        break;
      case 'tumbleRecover':
        this.scoring.award('tumbleRecover', { prox: this.nearest, speed: this.pilot.speed });
        break;
      case 'crash':
        this.camRig.kick(1.8);
        if (data.kind === 'water') this.hud.toast('SPLASHDOWN');
        this.audio.bang('crash', 0.6 + data.impactSpeed / 45);
        this.hud.toast(`CRASH — ${fmtSpeed(data.impactSpeed)}`);
        this.scoring.breakChain();
        setTimeout(() => { if (this.mode === 'fly') this.showResults('crash'); }, 2200);
        break;
      case 'land': {
        const g = this.scoring.gradeLanding(data);
        this.audio.bang('land', 0.5 + data.impactSpeed / 14);
        this.hud.toast(g.grade);
        // Put the canopy down somewhere and that somewhere becomes yours:
        // the point is saved for you, so anywhere you can land is somewhere
        // you can start a run from.
        if (data.kind === 'canopy') {
          this.setSpawnHere();
          this.hud.hint(
            '<kbd>W</kbd> walk · <kbd>Space</kbd> jump · <kbd>J</kbd> to come back here',
            9,
          );
        } else {
          this.hud.hint('<kbd>W</kbd> walk · <kbd>Space</kbd> step off · hold <kbd>J</kbd> to save this spot', 8);
        }
        this.camRig.kick(0.3);
        break;
      }
      case 'deploy':
        this.suit.snapWings(1.3);
        this.camRig.kick(0.5);
        this.audio.bang('deploy', 0.6 + this.pilot.speed / 70);
        break;
      case 'stow':
        this.audio.bang('stow', 0.8);
        break;
      case 'jump':
        this.hud.hint('<kbd>H</kbd> spread your arms', 5);
        this.audio.bang('jump', 0.8);
        break;
      case 'skim':
        this.camRig.kick(0.25);
        this.audio.bang('skim', 0.5 + this.pilot.speed / 90);
        break;
      case 'canopy':
        this.hud.toast('CANOPY');
        this.audio.bang('deploy', 1.1);
        break;
    }
  }

  onTrickEvent(kind, info) {
    if (kind === 'trick') {
      this.scoring.award(info.name, {
        revs: info.revs,
        prewind: info.prewind,
        prox: this.nearest,
        speed: this.pilot.speed,
        inverted: this.tricks.inverted,
      });
      this.suit.snapWings(0.9 + info.revs * 0.2);
      this.camRig.kick(0.25);
      this.audio.bang('pop', 0.7 + info.revs * 0.25);
      // a trick that bleeds speed (a flat spin especially) should not dump
      // you straight into a tumble as its reward
      this.pilot.tumbleGrace = 1.4;
    }
  }

  showResults() {
    this.mode = 'results';
    const s = this.scoring.bankRun();
    this.ui?.showResults(s);
  }

  // ------------------------------------------------------------------- loop

  step(dt) {
    const inp = this.input;
    inp.poll();

    if (this.mode === 'fly' && !this.paused) {
      this.handleFlightInput(dt);
      this.trickEdges = this.input.pressed;
      this.acc += dt;
      let n = 0;
      while (this.acc >= PHYS_DT && n < MAX_SUBSTEPS) {
        this.physics(PHYS_DT);
        this.acc -= PHYS_DT;
        n++;
      }
      if (this.acc > PHYS_DT * MAX_SUBSTEPS) this.acc = 0;
    } else {
      this.acc = 0;
    }

    this.render(dt);
    inp.endFrame();
  }

  handleFlightInput(dt) {
    const i = this.input;
    const ed = i.pressed;
    const p = this.pilot;

    // H spreads the arms. Until you do, you are in freefall.
    if (ed.deploy) {
      if (p.state === FLIGHT_STATE.GROUND) this.hud.toast('STEP OFF FIRST — SPACE');
      else if (p.toggleWings()) {
        this.hud.toast(p.wingsTarget > 0.5 ? 'WINGS OUT' : 'WINGS IN');
      }
    }

    // J: hold on the ground to drop a respawn point, tap to go back to one.
    if (i.state.spawnPoint) {
      this.jHold = (this.jHold || 0) + dt;
      if (this.jHold > 0.55 && !this.jDone) {
        this.jDone = true;
        if (p.state === FLIGHT_STATE.GROUND) this.setSpawnHere();
        else this.hud.toast('LAND FIRST TO SET A POINT');
      }
    }
    if (i.released.spawnPoint) {
      if (!this.jDone) {
        if (this.save.activeSpawn) this.respawn();
        else this.hud.toast('NO RESPAWN POINT — HOLD J ON THE GROUND');
      }
      this.jHold = 0;
      this.jDone = false;
    }
    if (ed.camera) this.hud.toast('CAMERA — ' + this.camRig.cycle().toUpperCase());
    if (ed.respawn) this.respawn();
    if (ed.retry) this.retry();
    if (ed.setSpawn) this.setSpawnHere();
    if (ed.cycleSpawn) {
      const sp = this.save.cycleSpawn(1);
      if (sp) this.hud.toast(`Active: ${sp.name}`);
    }
    if (ed.canopy) {
      if (p.state === FLIGHT_STATE.CANOPY) p.cutCanopy();
      else p.deployCanopy();
    }
    if (ed.flareSnap && p.state === FLIGHT_STATE.GROUND) p.jump();
    // Space taps over: a quick tap in the air flips you upside down, and
    // holding it is still the flare. Tapping to flare does nothing useful
    // anyway -- a flare has to be held -- so the two do not collide.
    if (ed.flareSnap && p.state === FLIGHT_STATE.FLYING) this.spaceDown = 0;
    if (i.state.flareSnap && p.state === FLIGHT_STATE.FLYING) {
      this.spaceDown = (this.spaceDown || 0) + dt;
    }
    if (i.released.flareSnap && p.state === FLIGHT_STATE.FLYING
        && (this.spaceDown || 0) < 0.22 && !i.state.hard && p.wings > 0.6) {
      // Inverted is a roll of the body about the line of flight, not of the
      // flight model. Rolling the aerodynamics upside down points the lift
      // at the ground and takes the controls with it, which is why it was
      // unflyable; this way left is still left and up is still up, and it
      // looks like what it is.
      this.invert = !this.invert;
      this.hud.toast(this.invert ? 'INVERTED' : 'UPRIGHT');
    }
    if (ed.hud) {
      this.save.settings.showHud = !this.save.settings.showHud;
      this.hud.setVisible(this.save.settings.showHud);
      this.save.touch();
    }
    if (ed.bank) {
      const s = this.scoring.bankRun();
      if (s) this.hud.toast(`BANKED ${Math.round(s.score).toLocaleString()}`);
    }
  }

  buildInput() {
    const i = this.input;
    const m = i.mouse;
    let pitch = i.axis('pitchDown', 'pitchUp');
    let roll = i.axis('rollLeft', 'rollRight');
    let yaw = i.axis('yawLeft', 'yawRight');

    if (i.padAxes) {
      if (Math.abs(i.padAxes.ly) > 0.05) pitch = -i.padAxes.ly;
      if (Math.abs(i.padAxes.lx) > 0.05) roll = i.padAxes.lx;
      if (Math.abs(i.padAxes.rx) > 0.05) yaw = i.padAxes.rx;
    }

    if (m.locked && this.save.settings.mouseSensitivity > 0) {
      const sens = m.sensitivity * this.save.settings.mouseSensitivity;
      this.mousePitch = clamp((this.mousePitch || 0) - m.dy * sens * (m.invertY ? -1 : 1), -1, 1);
      this.mouseRoll = clamp((this.mouseRoll || 0) + m.dx * sens * 1.35, -1, 1);
      this.mousePitch *= 0.90;
      this.mouseRoll *= 0.86;
      pitch = clamp(pitch + this.mousePitch, -1, 1);
      roll = clamp(roll + this.mouseRoll, -1, 1);
    }

    if (this.pilot && this.pilot.state === FLIGHT_STATE.GROUND) {
      // Steer on your own feet, not on the camera. Taking the walk direction
      // from the camera fed back into itself -- the body turns to face the
      // way it is walking, the chase camera swings round behind it, and the
      // pair of them spiral off across the mountain. Standing still there is
      // no velocity for the chase camera to orient to at all.
      const turn = (i.state.rollRight ? 1 : 0) - (i.state.rollLeft ? 1 : 0);
      const look = m.locked ? m.dx * 0.0022 : 0;
      this.pilot.groundHeading -= turn * 2.3 * PHYS_DT + look;
      return {
        pitch: 0, roll: 0, yaw: 0, tuck: 0, track: 0, flare: 0,
        walkF: (i.state.pitchDown ? 1 : 0) - (i.state.pitchUp ? 1 : 0),
        walkS: 0,
        run: !!i.state.tuck,
        jump: !!i.pressed.flareSnap,
        heading: this.pilot.groundHeading,
      };
    }

    // Under canopy the suit controls make no sense. A parachute is steered
    // with two toggles: pull one to turn, pull both to slow down.
    if (this.pilot && this.pilot.state === FLIGHT_STATE.CANOPY) {
      const turn = (i.state.rollRight ? 1 : 0) - (i.state.rollLeft ? 1 : 0);
      const brake = i.state.pitchUp ? 1 : 0;        // S: both brakes, slow
      const drive = i.state.pitchDown ? 1 : 0;      // W: hands up, full speed
      this._lastRoll = turn;
      return {
        pitch: 0,
        roll: turn,
        yaw: turn * 0.5 + (m.locked ? clamp(m.dx * 0.01, -1, 1) : 0),
        tuck: 0,
        track: drive,
        flare: brake,
        canopySteer: true,
      };
    }

    const tuck = i.state.tuck ? 1 : 0;
    const track = i.state.track ? 1 : 0;
    // The flare is Space only. Pitch used to blend into it past 55 %, which
    // meant pulling up to climb silently stalled you.
    const flare = i.state.flareSnap ? 1 : 0;

    // Hold the left button for the sharp stuff: with S or Space it is a
    // hard pull-up, with A or D a hard carving turn. Space stops being the
    // flare while it is held, because you are asking for the opposite.
    // Upside down, A and D become yaw. The point of inverted flight is
    // that it looks good, not that you have to re-learn which way left is:
    // bank would turn you the other way up there, yaw does not.
    const hard = !!i.state.hard;
    const wantPull = hard && (i.state.pitchUp || i.state.flareSnap);
    const wantTurn = hard && (i.state.rollLeft || i.state.rollRight);
    let outFlare = flare;
    let outPitch = pitch;
    if (wantPull) {
      outPitch = 1;
      outFlare = 0;
    }
    // A hard turn is bank plus pull. Bank alone just points the lift
    // sideways and drops you out of the sky; the pull is what bends the
    // flight path round.
    if (wantTurn) {
      outPitch = Math.max(outPitch, 0.9);
      outFlare = 0;
    }

    // the canopy steers on the same input, and it is drawn from render()
    this._lastRoll = roll;

    return {
      pitch: outPitch,
      roll,
      yaw,
      tuck,
      track,
      flare: outFlare,
      hardPull: wantPull || wantTurn,
      hardTurn: wantTurn,
    };
  }

  physics(dt) {
    const p = this.pilot;
    const inp = this.buildInput();

    // Trick edges are consumed once per frame (see step()): a physics substep
    // can run twice or not at all, which either double-triggered a trick or
    // dropped the key press entirely.
    this.tricks.update(dt, this.input.state, this.trickEdges, p);
    this.trickEdges = EMPTY_EDGES;
    p.trickOmega.copy(this.tricks.omega);
    p.trickAero.area = this.tricks.aero.area;
    p.trickAero.drag = this.tricks.aero.drag;
    p.trickAero.lift = this.tricks.aero.lift;
    p.controlScale = this.tricks.controlScale;
    // a kick on the frame a hard manoeuvre starts, so it lands as a hit
    const hardNow = !!(inp.hardPull || inp.hardTurn);
    if (hardNow && !this._hardWas) this.camRig.kick(0.75);
    this._hardWas = hardNow;

    this.wind.update(dt, this.time);
    p.updateCanopy(dt);
    p.step(dt, inp);

    if (this.race && this.race.running) {
      const res = this.race.update(dt, p.pos, p.prevPos, this.camera.position);
      if (res && res.dnf) {
        this.audio.bang('crash', 0.5);
        this.hud.toast(`MISSED RING ${res.ring} / ${res.of}  ·  RUN OVER`, 3200);
        this.hud.hint('<kbd>L</kbd> to run it again', 6);
        this.race.clear();
      } else if (res && res.finished) {
        this.finishRace(res);
      } else if (res && res.ring) {
        this.audio.bang('skim', 0.55);
        this.camRig.kick(0.2);
      }
    }

    // proximity probes
    this.nearest = this.collision.nearest(
      p.pos.x, p.pos.y, p.pos.z, this.probeDirs, 60, this.nearestInfo,
    );

    // trees are not in the heightfield, so fold them into proximity and
    // handle strikes separately
    const treeD = this.scatter.nearestTree(p.pos.x, p.pos.y, p.pos.z, 34, this._tree || (this._tree = {}));
    if (treeD < this.nearest) this.nearest = treeD;
    if (treeD < 0.75 && p.state === FLIGHT_STATE.FLYING) {
      p.crash(p.speed, this._upVec || (this._upVec = new THREE.Vector3(0, 1, 0)), 'tree');
    } else if (treeD < 4.0 && p.speed > 26) {
      this.treeCool = (this.treeCool || 0) - dt;
      if (this.treeCool <= 0) {
        this.treeCool = 0.55;
        this.scoring.award('tree', { prox: treeD, speed: p.speed, inverted: this.tricks.inverted });
      }
    }

    // flying through an arch, a bridge or a cave
    const portal = this.features.portalTest(
      p.prevPos.x, p.prevPos.y, p.prevPos.z, p.pos.x, p.pos.y, p.pos.z,
    );
    if (portal && portal !== this._lastPortal) {
      this._lastPortal = portal;
      this._portalCool = 1.2;
      const kind = portal.kind === 'tunnel' || portal.kind === 'cave' ? 'cave' : 'arch';
      this.scoring.award(kind, {
        prox: Math.min(this.nearest, portal.tight * 0.5),
        speed: p.speed,
        inverted: this.tricks.inverted,
        mult: portal.tight < 26 ? 1.8 : 1,
      });
      this.hud.toast(portal.name.toUpperCase());
      this.camRig.kick(0.35);
      this.audio.bang('gate', 1);
    }
    if (this._portalCool > 0) {
      this._portalCool -= dt;
      if (this._portalCool <= 0) this._lastPortal = null;
    }

    // --- water ---------------------------------------------------------
    const surf = this.water.surfaceAt(p.pos.x, p.pos.z);
    const overWater = surf !== null;
    if (overWater && p.state === FLIGHT_STATE.FLYING) {
      const under = surf - p.pos.y;
      const sinkRate = -p.vel.y;
      if (under > 0) {
        if (sinkRate > 12 || p.speed < 11) {
          p.crash(Math.max(sinkRate, 6), this._upVec || (this._upVec = new THREE.Vector3(0, 1, 0)), 'water');
        } else {
          // in the water: the surface carries you, at the cost of speed
          p.pos.y = surf + 0.08;
          if (p.vel.y < 0) p.vel.y *= -0.18;
          p.vel.multiplyScalar(1 - Math.min(0.5, 2.6 * dt));
          p.contact = false;
          this.waterSkim = (this.waterSkim || 0) + dt * 1.6;
          this.spawnSpray(p, surf, 7);
        }
      } else if (under > -1.3 && p.speed > 22) {
        // a true skim is flown just above the surface, not through it, so
        // the band above the water counts too
        this.waterSkim = (this.waterSkim || 0) + dt;
        this.spawnSpray(p, surf, 4);
      } else if (under > -3.2 && p.speed > 26) {
        this.spawnSpray(p, surf, 2);
        this.waterSkim = Math.max(0, (this.waterSkim || 0) - dt * 0.5);
      } else {
        this.waterSkim = Math.max(0, (this.waterSkim || 0) - dt);
      }
      if (this.waterSkim > 0.4) {
        this.waterSkim = 0.08;
        this.scoring.award('waterSkim', {
          prox: 0.5, speed: p.speed, inverted: this.tricks.inverted,
        });
        this.audio.bang('skim', 0.9);
      }
    } else {
      this.waterSkim = Math.max(0, (this.waterSkim || 0) - dt);
    }

    // --- waterfall mist --------------------------------------------------
    this.mist = this.water.mistAt(p.pos.x, p.pos.y, p.pos.z);
    if (this.mist > 0.25 && p.speed > 20) {
      this.mistTime = (this.mistTime || 0) + dt;
      if (this.mistTime > 0.3 && !this.mistAwarded) {
        this.mistAwarded = true;
        this.scoring.award('mist', { prox: 4, speed: p.speed, inverted: this.tricks.inverted });
      }
    } else if (this.mist < 0.05) {
      this.mistTime = 0;
      this.mistAwarded = false;
    }

    const lake = this.field.isWater(p.pos.x, p.pos.z);
    this.scoring.update(dt, {
      prox: this.nearest,
      speed: p.speed,
      agl: p.agl,
      altitude: p.pos.y,
      glide: p.glide,
      contact: p.contact,
      vario: p.vel.y - (this.wind.lastLift || 0) + (this.wind.lastLift || 0),
      inverted: this.tricks.inverted,
      bank: p.bank,
      overWater: overWater || !!lake,
    });

    if (p.state === FLIGHT_STATE.CRASHED || p.state === FLIGHT_STATE.LANDED) {
      // physics continues but the run is over
    }
  }

  render(dt) {
    const p = this.pilot;
    this.time += dt * (this.save.settings.autoTime ? 0.0035 : 0);
    if (this.time > 24) this.time -= 24;

    const weather = WEATHER[this.weatherKey] || WEATHER.clear;
    this.wind.setWeather(weather);
    this.sky.update(this.time, weather, this.camera.position);

    if (this.mode === 'title') {
      this.updateTitleCamera(dt);
    } else if (this.mode === 'fly' || this.mode === 'results') {
      this.updateFlightView(dt);
    }

    this.sky.setCam(this.camera.position);
    this.terrainMat.uniforms.uTime.value = performance.now() * 0.001;
    this.terrainMat.uniforms.uSnowFall.value = weather.snow;

    this.camera.updateMatrixWorld();
    this.updateFrustum();
    this.chunks.update(this.camera.position, this.mode === 'fly' ? p.pos : this.camera.position, this.frustum, 6);
    this.scatter.update(this.camera.position, dt);
    this.features.updateVisibility(this.camera.position);

    // Point at the nearest arch, cave or roof. There are fifteen of them in
    // 151 km of mountain and they only draw within 1.9 km, so without a cue
    // you can fly for an hour and never happen across one.
    this.featureTimer = (this.featureTimer || 0) - dt;
    if (this.featureTimer <= 0) {
      this.featureTimer = 0.25;
      let best = null;
      for (const f of this.features.list) {
        const dx = f.x - p.pos.x;
        const dz = f.z - p.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 3400) continue;
        if (!best || d < best.dist) best = { f, dist: d, dx, dz };
      }
      if (!best) this.nearFeature = null;
      else {
        const head = Math.atan2(p.vel.x, p.vel.z);
        const to = Math.atan2(best.dx, best.dz);
        this.nearFeature = {
          name: best.f.name,
          kind: best.f.kind,
          dist: best.dist,
          rel: ((((to - head) * 180) / Math.PI + 540) % 360) - 180,
        };
      }
    }
    this.water.update(dt);
    this.water.setVisible(this.camera.position);

    const speed = this.mode === 'fly' ? this.pilot.speed : 0;
    this.post.tune(dt, {
      speed,
      flow: this.scoring ? this.scoring.flow : 0,
      prox: this.nearest,
      frost: this.camRig && this.camRig.mode === 'helmet' ? 0.5 + 0.35 * clamp01(speed / 85) : 0,
      mist: this.mode === 'fly' ? (this.mist || 0) * 0.9 : 0,
      flash: this.flash || 0,
      exposure: 1.18,
      bloom: this.mode === 'title' ? 0.42 : 0.33,
      allowSmear: this.save.settings.motionBlurAtSpeed !== false,
    });
    if (this.flash) this.flash = Math.max(0, this.flash - dt * 2.4);
    this.post.render(this.scene, this.camera);

    // fps
    this.fpsAcc++;
    this.fpsTime += dt;
    if (this.fpsTime > 0.5) {
      this.fps = this.fpsAcc / this.fpsTime;
      this.fpsAcc = 0;
      this.fpsTime = 0;
      // Adaptive resolution, with enough hysteresis to stop it hunting.
      // It used to nudge the scale by a few percent every half second
      // whenever the frame rate sat outside a ten-frame window, which meant
      // the canvas and every post target were being resized continuously --
      // and a resize is a visible pop. That was most of the "flickering".
      if (this.mode === 'fly' && !this.paused) {
        this.adaptHold = (this.adaptHold || 0) + 0.5;
        const low = this.fps < 46;
        const high = this.fps > 70;
        if ((low || high) && this.adaptHold >= 2.5) {
          // quantised, so there are only five possible resolutions and each
          // change is a deliberate step rather than a shimmer
          const step = low ? -0.1 : 0.1;
          const next = Math.round(clamp(this.adaptive + step, 0.6, 1) * 10) / 10;
          if (next !== this.adaptive) {
            this.adaptive = next;
            this.adaptHold = 0;
            this.onResize();
          }
        }
      }
    }

    if (this.tutorial.active && this.mode === 'fly' && !this.paused) {
      const p2 = this.pilot;
      const done = this.tutorial.update(dt, {
        state: p2.state,
        speed: p2.speed,
        glide: p2.glide,
        vario: p2.vel.y,
        closest: this.nearest,
        tricks: this.scoring.tricksDone,
        heading: Math.atan2(p2.vel.x, p2.vel.z),
        hard: !!(this.input.state.hard
          && (this.input.state.rollLeft || this.input.state.rollRight
            || this.input.state.pitchUp)),
      });
      if (done) {
        this.audio.bang('pop', 0.8);
        if (this.tutorial.complete) {
          this.hud.toast('THAT IS ALL OF IT — GO FLYING', 4000);
          this.tutorial.active = false;
          this.hud.hideLesson();
        }
      }
      if (this.tutorial.justAdvanced) {
        this.tutorial.justAdvanced = false;
        const st = this.tutorial.step;
        if (st) this.hud.lesson(this.tutorial.index + 1, TUTORIAL_STEPS.length, st);
      }
      // a step that needs air, with no air left: put them back up
      const st = this.tutorial.step;
      if (st && st.id !== 'walk' && st.id !== 'land'
          && (p2.state === 'crashed' || p2.state === 'ground')) {
        this.hud.toast('BACK UP YOU GO', 1600);
        const poi = this.lastLaunch ? this.lastLaunch.poi : this.startPoi;
        this.launch(poi, 'hot');
        this.tutorial.active = true;
      }
    }
    if (this.mode === 'fly' || this.mode === 'results') this.updateHud(dt);
    this.updateAudio(dt);
    this.save.tick(dt);
  }

  updateTitleCamera(dt) {
    this.titleAngle += dt * 0.028;
    const r = 3650;
    const cx = -200;
    const cz = -120;
    this.camera.position.set(
      cx + Math.cos(this.titleAngle) * r,
      2900 + Math.sin(this.titleAngle * 0.6) * 380,
      cz + Math.sin(this.titleAngle) * r,
    );
    this.camera.lookAt(cx, 1750, cz);
    if (this.camera.fov !== 46) {
      this.camera.fov = 46;
      this.camera.updateProjectionMatrix();
    }
  }

  updateFlightView(dt) {
    const p = this.pilot;
    const alpha = clamp01(this.acc / PHYS_DT);
    const pos = this._ip || (this._ip = new THREE.Vector3());
    const quat = this._iq || (this._iq = new THREE.Quaternion());
    p.sample(alpha, pos, quat);

    this.suit.group.position.copy(pos);
    this.suit.group.quaternion.copy(quat);
    // Stand the whole body up rather than folding it at the waist. The rig
    // is authored prone -- head along -Z, legs trailing along +Z -- so a
    // quarter turn about its own X axis puts the head up and the legs down
    // with everything else following, and the walk and idle poses then read
    // as a person instead of someone hanging off a rope.
    // Inverted: roll the drawn body about its own line of flight. Nothing
    // the flight model knows about changes.
    this._invBlend = damp(this._invBlend || 0, this.invert ? 1 : 0, 6, dt);
    if (this._invBlend > 0.001) {
      if (!this._invQ) this._invQ = new THREE.Quaternion();
      this._invQ.setFromAxisAngle(FWD_AXIS, Math.PI * this._invBlend);
      this.suit.group.quaternion.multiply(this._invQ);
    }

    const gb = (this._groundBlend = damp(
      this._groundBlend || 0,
      p.state === FLIGHT_STATE.GROUND ? 1 : 0,
      11, dt,
    ));
    if (gb > 0.001) {
      if (!this._uprightQ) {
        this._uprightQ = new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.5);
        this._identQ = new THREE.Quaternion();
        this._blendQ = new THREE.Quaternion();
      }
      this._blendQ.copy(this._identQ).slerp(this._uprightQ, gb);
      this.suit.group.quaternion.multiply(this._blendQ);
    }
    // No wing while you are on your feet. The membrane is rebuilt every
    // frame from the arm and leg bones regardless of pose, so a standing
    // figure was still wearing a fully spread wingsuit.
    this.suit.fabricMesh.visible = this.pilot.state !== FLIGHT_STATE.GROUND
      && this.pilot.state !== FLIGHT_STATE.CANOPY;
    this.canopy.update(
      dt, pos,
      Math.atan2(p.vel.x, p.vel.z) + Math.PI,
      p.state === FLIGHT_STATE.CANOPY ? p.canopy : 0,
      this._lastRoll || 0,
      p.pose.flare,
    );
    this.suit.group.updateMatrixWorld();

    const q = 0.5 * p.density() * p.speed * p.speed;
    this.suit.update(dt, {
      tuck: p.pose.tuck,
      track: p.pose.track,
      flare: p.pose.flare,
      bank: p.bank,
      alpha: p.alpha,
      speed: p.speed,
      sep: p.sep,
      inverted: this.tricks.rig.inverted,
      heli: this.tricks.rig.heli,
      knife: this.tricks.rig.knife,
      tumble: p.state === FLIGHT_STATE.TUMBLE ? 1 : 0,
      // Furl the wing while you are on your feet. The flight model keeps the
      // wing deployed so stepping off flies, but a wingsuit spread wide open
      // on a standing figure reads as something other than a person.
      wings: p.state === FLIGHT_STATE.GROUND ? 0 : p.wings,
      grounded: p.state === FLIGHT_STATE.GROUND ? 1 : 0,
      walk: p.state === FLIGHT_STATE.GROUND ? clamp01((p.walkSpeedNow || 0) / 4.2) : 0,
      crouch: 0,
      canopy: p.state === FLIGHT_STATE.CANOPY ? p.canopy : 0,
      trickSpin: this.tricks.rig.trickSpin,
      pressure: clamp01(q / 2600),
      tension: p.fabricTension,
    });

    this.trickBlend = damp(this.trickBlend || 0, this.tricks.active ? 1 : 0, 9, dt);
    this.camRig.update(dt, {
      pos,
      quat,
      vel: p.vel,
      agl: p.agl,
      trickBlend: this.trickBlend,
      canopy: p.state === FLIGHT_STATE.CANOPY ? p.canopy : 0,
      nearest: this.nearest,
      headPos: this.suit.headPos,
      headQuat: quat,
      tipPos: this.suit.tipR,
      state: p.state,
    });

    // hide the suit in helmet cam
    this.suit.group.visible = this.camRig.mode !== 'helmet';

    this.updateTrails(dt, p, quat);

    if (this.hud && this.save.settings.showHud) {
      this.hud.attitude.update(this.camera, this.camera.position, p.vel, p.fwd);
    }
  }

  /** Spray thrown up off the surface when you touch water. */
  spawnSpray(p, surfY, n) {
    const pr = this.particles;
    if (pr.live > pr.max - 8) return;
    for (let i = 0; i < n; i++) {
      const sx = (Math.random() - 0.5) * 3.2;
      const sz = (Math.random() - 0.5) * 3.2;
      pr.spawn(
        p.pos.x + sx, surfY + 0.2, p.pos.z + sz,
        -p.vel.x * 0.16 + sx * 3, 2.5 + Math.random() * 5.5, -p.vel.z * 0.16 + sz * 3,
        0.5 + Math.random() * 0.7, 0.26 + Math.random() * 0.42,
        0.88, 0.94, 0.99,
      );
    }
  }

  /** Put on whatever is equipped. Safe to call at any time. */
  applyCosmetics() {
    this.cosmetics = resolveCosmetics(this.save.data.equipped);
    const c = this.cosmetics;
    if (this.suit) {
      this.suit.rig.recolour(c.palette);
      this.suit.fabric.recolour(c.fabric, c.accent);
    }
    if (this.trailL) {
      const w = 0.055 * c.trailWidth;
      this.trailL.width = w;
      this.trailR.width = w;
    }
  }

  updateTrails(dt, p, quat) {
    const speed = p.speed;
    const flying = p.state === FLIGHT_STATE.FLYING || p.state === FLIGHT_STATE.TUMBLE;
    const base = clamp01((speed - 28) / 55);
    const close = smoothstep(26, 3, this.nearest);
    const strength = flying ? clamp01(base * 0.55 + close * 0.55) : 0;
    const up = this._tu || (this._tu = new THREE.Vector3());
    up.set(0, 1, 0).applyQuaternion(quat);
    // Close passes still flash hot; the rest of the time you fly in
    // whatever smoke you are wearing.
    const col = close > 0.5 ? TRAIL_HOT : (this.cosmetics.trail || TRAIL_COOL);
    if (strength > 0.03) {
      this.trailL.push(this.suit.tipL, up, strength, col);
      this.trailR.push(this.suit.tipR, up, strength, col);
    }
    this.trailL.update(dt);
    this.trailR.update(dt);

    // snow / dust kicked up when skimming the surface at speed
    if (flying && this.nearest < 7 && speed > 26 && this.particles.live < this.particles.max - 6) {
      const n = Math.min(4, Math.round(dt * 110 * clamp01((7 - this.nearest) / 7)));
      const info = this.nearestInfo;
      for (let i = 0; i < n; i++) {
        const sx = (Math.random() - 0.5) * 2.4;
        const sy = (Math.random() - 0.5) * 1.6;
        const sz = (Math.random() - 0.5) * 2.4;
        const snowy = p.pos.y > this.field.snowLineFor(p.pos.x, p.pos.z);
        const c = snowy ? 0.92 : 0.52;
        this.particles.spawn(
          (info.px ?? p.pos.x) + sx, (info.py ?? p.pos.y) + sy, (info.pz ?? p.pos.z) + sz,
          -p.vel.x * 0.1 + sx * 2, 1.6 + Math.random() * 2.4, -p.vel.z * 0.1 + sz * 2,
          0.7 + Math.random() * 0.8, 0.30 + Math.random() * 0.5,
          c, c * 0.99, c * 1.02,
        );
      }
    }
    this.particles.update(dt, 1.3, -2.2);
  }

  updateAudio(dt) {
    if (!this.audio || !this.audio.started) return;
    if (this.mode !== 'fly' || this.paused) {
      this.audio.update(dt, {
        speed: 0, altitude: this.camera.position.y, nearest: 999,
        flow: 0, grounded: 1, enclosure: 0,
      });
      return;
    }
    const p = this.pilot;
    // Enclosure drives the reverb: close rock on several sides, or the
    // ceiling of a tunnel over your head (agl goes negative inside one).
    const insideRock = p.agl < -4 ? 1 : 0;
    const enclosure = clamp01(smoothstep(62, 12, this.nearest) * 0.75 + insideRock);
    this.audio.update(dt, {
      speed: p.speed,
      agl: p.agl,
      altitude: p.pos.y,
      nearest: this.nearest,
      tension: p.fabricTension,
      sep: p.sep,
      wings: p.wings,
      enclosure,
      flow: this.scoring.flow,
      vario: p.vel.y,
      grounded: p.state === FLIGHT_STATE.GROUND ? 1 : 0,
      mist: this.mist || 0,
      fallDist: this.water.nearestFall(p.pos.x, p.pos.y, p.pos.z),
    });
  }

  updateHud(dt) {
    const p = this.pilot;
    const sc = this.scoring;
    this.hud.update(dt, {
      speed: p.speed,
      alt: p.pos.y,
      agl: p.agl,
      glide: p.glide,
      vario: p.vel.y,
      aoa: p.alpha / DEG,
      score: sc.score,
      mult: sc.multiplier,
      chain: sc.chain,
      meter: sc.meter,
      prox: this.nearest,
      trick: this.tricks.label(),
      flow: sc.flow,
      feature: this.nearFeature,
      race: this.race && this.race.running ? {
        ring: this.race.next + 1,
        of: this.race.active.rings.length,
        time: this.race.time,
        dist: this.race.distanceToNext(p.pos),
        gap: this.race.gap(),
        name: this.race.active.name,
      } : null,
      edge: p.state === FLIGHT_STATE.GROUND ? {
        dist: p.edgeDist === undefined ? -1 : p.edgeDist,
        drop: p.edgeDrop || 0,
        // relative bearing: 0 is straight ahead, so the arrow reads as a
        // pointer rather than a compass you have to translate
        rel: ((((p.edgeHeading || 0) - p.groundHeading) * 180 / Math.PI) + 540) % 360 - 180,
      } : null,
      fpsText: `${this.fps.toFixed(0)} fps\n${this.chunks.stats.nodes} nodes  ${(this.chunks.stats.tris / 1000).toFixed(0)}k tris\n${this.scatter.stats.near + this.scatter.stats.far} trees  ${this.features.list.length} feat  ${this.water.falls.length} falls`,
    });
  }
}

function featureNote(kind) {
  return {
    arch: 'Natural arch — fly it',
    bridge: 'Rock bridge',
    tunnel: 'Tunnel, open both ends',
    cave: 'Cave run',
    overhang: 'Overhanging roof',
    spires: 'Spire field — slalom it',
  }[kind] || '';
}

function nextTick() {
  return new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------- bootstrap

export async function boot() {
  const game = new Game();
  window.SKYLINE = game;
  window.addEventListener('error', (e) => game.errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => game.errors.push('promise: ' + e.reason));

  const bar = document.getElementById('loadBar');
  const phase = document.getElementById('loadPhase');
  const PHASES = { field: [0, 0.3], hydraulic: [0.3, 0.6], thermal: [0.6, 0.7], ao: [0.7, 0.78], scene: [0.78, 1] };

  try {
    await game.init((s) => {
      const r = PHASES[s.phase] || [0.99, 1];
      const t = r[0] + (r[1] - r[0]) * s.progress;
      bar.style.width = `${(t * 100).toFixed(1)}%`;
      phase.textContent = s.label;
    });
  } catch (err) {
    phase.textContent = 'failed: ' + err.message;
    console.error(err);
    throw err;
  }

  const { attachUI } = await import('./ui/menus.js');
  attachUI(game);

  const loading = document.getElementById('loading');
  loading.style.opacity = '0';
  setTimeout(() => loading.classList.add('hidden'), 750);
  document.getElementById('title').classList.remove('hidden');
  document.getElementById('titleSeed').textContent = game.save.data.seed;

  let last = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    try {
      game.step(dt);
    } catch (e) {
      game.errors.push(String(e && e.message));
      console.error(e);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // deterministic stepping hook for automated testing
  window.SKYLINE.stepFrames = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) game.step(dt);
    return true;
  };
  return game;
}
