// Procedural audio. No samples: everything is noise buffers, oscillators and
// filters built at runtime.
//
// The mix is a single idea — you hear the air. Wind roar is the bed, its
// cutoff and level follow airspeed; a hiss band opens up at speed; the fabric
// flutters at a rate set by how much air is loading the wing; rock close by
// adds a resonant whoosh that sweeps as it passes; and a convolution tail
// built from decaying noise opens up in canyons and caves.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** Looping white/pink-ish noise. */
function noiseBuffer(ctx, seconds = 3, pink = true) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (!pink) { d[i] = w; continue; }
    // Paul Kellet's pink filter: a flatter, less hissy bed than white noise
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  // taper the seam so the loop does not click
  const fade = Math.min(2000, (n / 8) | 0);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    d[i] *= t;
    d[n - 1 - i] *= t;
  }
  return buf;
}

/** A plausible mountain-canyon tail: decaying noise with early reflections. */
function impulse(ctx, seconds = 2.4, decay = 3.2) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
    }
    // a few discrete slap-backs off the walls
    for (const [at, g] of [[0.031, 0.5], [0.057, 0.38], [0.094, 0.3], [0.151, 0.22]]) {
      const i = Math.floor(at * ctx.sampleRate * (c ? 1.07 : 1));
      if (i < n) d[i] += g * (Math.random() * 2 - 1);
    }
  }
  return buf;
}

function loopSource(ctx, buf, dest, rate = 1) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.playbackRate.value = rate;
  src.connect(dest);
  src.start(ctx.currentTime + Math.random() * 0.1);
  return src;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.started = false;
    this.enabled = true;
    this.vol = { master: 0.85, music: 0.5, sfx: 0.9 };
    this.smooth = { wind: 0, hiss: 0, flutter: 0, prox: 0, rev: 0, music: 0 };
    this.lastNearest = 999;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async resume() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.build();
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.started = this.ctx.state === 'running';
      return this.started;
    } catch (e) {
      console.warn('audio unavailable', e);
      this.enabled = false;
      return false;
    }
  }

  build() {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    this.master = ctx.createGain();
    this.master.gain.value = this.vol.master;
    // a gentle limiter so a crash plus full wind never clips
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 18;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    this.sfx = ctx.createGain();
    this.sfx.gain.value = this.vol.sfx;
    this.sfx.connect(this.master);

    this.music = ctx.createGain();
    this.music.gain.value = 0;
    this.musicVol = this.vol.music;
    this.music.connect(this.master);

    // ---- reverb send ----
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = impulse(ctx);
    this.revGain = ctx.createGain();
    this.revGain.gain.value = 0;
    this.convolver.connect(this.revGain);
    this.revGain.connect(this.master);

    this.send = ctx.createGain();
    this.send.gain.value = 1;
    this.send.connect(this.convolver);

    const pink = noiseBuffer(ctx, 3, true);
    const white = noiseBuffer(ctx, 2, false);
    this.pink = pink;
    this.white = white;

    // ---- wind bed ----
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 220;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.sfx);
    this.windGain.connect(this.send);
    loopSource(ctx, pink, this.windFilter);

    // ---- hiss, the edge of speed ----
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = 'highpass';
    this.hissFilter.frequency.value = 2600;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hissFilter.connect(this.hissGain);
    this.hissGain.connect(this.sfx);
    loopSource(ctx, white, this.hissFilter, 0.85);

    // ---- fabric flutter: noise through a band, amplitude modulated ----
    this.flutFilter = ctx.createBiquadFilter();
    this.flutFilter.type = 'bandpass';
    this.flutFilter.frequency.value = 520;
    this.flutFilter.Q.value = 1.6;
    this.flutAm = ctx.createGain();
    this.flutAm.gain.value = 0.5;
    this.flutGain = ctx.createGain();
    this.flutGain.gain.value = 0;
    this.flutFilter.connect(this.flutAm);
    this.flutAm.connect(this.flutGain);
    this.flutGain.connect(this.sfx);
    this.flutGain.connect(this.send);
    loopSource(ctx, pink, this.flutFilter, 1.3);

    this.flutLfo = ctx.createOscillator();
    this.flutLfo.type = 'sawtooth';
    this.flutLfo.frequency.value = 11;
    this.flutLfoGain = ctx.createGain();
    this.flutLfoGain.gain.value = 0.45;
    this.flutLfo.connect(this.flutLfoGain);
    this.flutLfoGain.connect(this.flutAm.gain);
    this.flutLfo.start(t);

    // ---- proximity whoosh ----
    this.proxFilter = ctx.createBiquadFilter();
    this.proxFilter.type = 'bandpass';
    this.proxFilter.frequency.value = 900;
    this.proxFilter.Q.value = 3.2;
    this.proxGain = ctx.createGain();
    this.proxGain.gain.value = 0;
    this.proxFilter.connect(this.proxGain);
    this.proxGain.connect(this.sfx);
    this.proxGain.connect(this.send);
    loopSource(ctx, white, this.proxFilter, 0.6);

    // ---- waterfall roar ----
    this.fallFilter = ctx.createBiquadFilter();
    this.fallFilter.type = 'lowpass';
    this.fallFilter.frequency.value = 1400;
    this.fallFilter.Q.value = 0.6;
    this.fallGain = ctx.createGain();
    this.fallGain.gain.value = 0;
    this.fallFilter.connect(this.fallGain);
    this.fallGain.connect(this.sfx);
    this.fallGain.connect(this.send);
    loopSource(ctx, pink, this.fallFilter, 1.6);

    // ---- vario: a soft tone that appears when the air is going up ----
    this.varioOsc = ctx.createOscillator();
    this.varioOsc.type = 'sine';
    this.varioOsc.frequency.value = 620;
    this.varioGain = ctx.createGain();
    this.varioGain.gain.value = 0;
    this.varioOsc.connect(this.varioGain);
    this.varioGain.connect(this.sfx);
    this.varioOsc.start(t);

    // ---- music: a slow drone that opens up with flow ----
    this.musicNodes = [];
    const root = 73.42; // D2
    const voices = [
      { f: root, type: 'sawtooth', detune: -6, cut: 320, g: 0.5 },
      { f: root * 1.5, type: 'sawtooth', detune: 5, cut: 480, g: 0.34 },
      { f: root * 2, type: 'triangle', detune: -3, cut: 900, g: 0.22 },
      { f: root * 3, type: 'triangle', detune: 7, cut: 1500, g: 0.13 },
    ];
    for (const v of voices) {
      const osc = ctx.createOscillator();
      osc.type = v.type;
      osc.frequency.value = v.f;
      osc.detune.value = v.detune;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = v.cut;
      f.Q.value = 0.9;
      const g = ctx.createGain();
      g.gain.value = v.g;
      osc.connect(f);
      f.connect(g);
      g.connect(this.music);
      osc.start(t);
      // slow drift so the pad never sits still
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.03 + Math.random() * 0.05;
      const lg = ctx.createGain();
      lg.gain.value = v.cut * 0.35;
      lfo.connect(lg);
      lg.connect(f.frequency);
      lfo.start(t);
      this.musicNodes.push({ osc, f, g, lfo });
    }
  }

  setVolumes(s) {
    this.vol.master = s.masterVolume ?? this.vol.master;
    this.vol.music = s.musicVolume ?? this.vol.music;
    this.vol.sfx = s.sfxVolume ?? this.vol.sfx;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, t, 0.05);
    this.sfx.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
    this.musicVol = this.vol.music;
  }

  /**
   * @param {object} s {speed, agl, nearest, tension, sep, wings, altitude,
   *                    enclosure, flow, vario, canopy, grounded}
   */
  update(dt, s) {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const k = Math.min(0.2, dt * 2.5);

    const speed = s.speed || 0;
    // Full roar at about 160 mph rather than 210: the suit spends its life
    // between 80 and 140, and scaling to a top speed you rarely see meant
    // normal flight sat at a sixth of the available volume and sounded
    // like nothing was happening.
    const v = clamp01(speed / 72);
    const fast = v * v;

    // thin air up high: quieter and duller
    const thin = 1 - clamp01((s.altitude - 1600) / 4200) * 0.35;

    // ---- wind ----
    const windTarget = (0.02 + fast * 1.30) * thin * (s.grounded ? 0.12 : 1);
    this.smooth.wind = lerp(this.smooth.wind, windTarget, k);
    this.windGain.gain.setTargetAtTime(this.smooth.wind, t, 0.06);
    // opens up as well as getting louder, so speed brightens the roar
    this.windFilter.frequency.setTargetAtTime(150 + v * v * 2600, t, 0.1);

    const hissTarget = Math.max(0, fast - 0.06) * 0.38 * thin * (s.grounded ? 0 : 1);
    this.smooth.hiss = lerp(this.smooth.hiss, hissTarget, k);
    this.hissGain.gain.setTargetAtTime(this.smooth.hiss, t, 0.08);
    this.hissFilter.frequency.setTargetAtTime(2200 + v * 4200, t, 0.12);

    // ---- fabric ----
    const wings = s.wings === undefined ? 1 : s.wings;
    const flutTarget = (0.03 + v * 0.26) * wings * (0.4 + (s.tension || 0) * 0.8) * (s.grounded ? 0 : 1);
    this.smooth.flutter = lerp(this.smooth.flutter, flutTarget, k);
    this.flutGain.gain.setTargetAtTime(this.smooth.flutter, t, 0.05);
    this.flutLfo.frequency.setTargetAtTime(7 + v * 26 + (s.sep || 0) * 9, t, 0.1);
    this.flutFilter.frequency.setTargetAtTime(380 + v * 900, t, 0.1);

    // ---- proximity: a resonant rush that sweeps as rock goes past ----
    const near = s.nearest === undefined ? 999 : s.nearest;
    const closeness = clamp01(1 - near / 30);
    const proxTarget = closeness * closeness * fast * 0.5;
    this.smooth.prox = lerp(this.smooth.prox, proxTarget, Math.min(0.5, dt * 6));
    this.proxGain.gain.setTargetAtTime(this.smooth.prox, t, 0.03);
    // closing fast sweeps the resonance up; opening again sweeps it down
    const rate = (this.lastNearest - near) / Math.max(dt, 1e-3);
    this.lastNearest = near;
    const sweep = 620 + closeness * 900 + Math.max(-900, Math.min(900, rate * 12));
    this.proxFilter.frequency.setTargetAtTime(sweep, t, 0.04);

    // ---- reverb: canyons, cave interiors, anything enclosed ----
    const encl = clamp01(s.enclosure || 0);
    this.smooth.rev = lerp(this.smooth.rev, encl * 0.9, Math.min(0.3, dt * 1.6));
    this.revGain.gain.setTargetAtTime(this.smooth.rev, t, 0.2);

    // ---- vario ----
    const lift = clamp01(((s.vario || 0) - 0.6) / 7);
    this.varioGain.gain.setTargetAtTime(lift * 0.035, t, 0.12);
    this.varioOsc.frequency.setTargetAtTime(520 + lift * 460, t, 0.12);

    // ---- waterfall: audible from a long way off, huge up close ----
    const fallD = s.fallDist === undefined ? 1e9 : s.fallDist;
    const fallNear = clamp01(1 - fallD / 340);
    const fallTarget = fallNear * fallNear * 0.42 + clamp01(s.mist || 0) * 0.3;
    this.smooth.fall = lerp(this.smooth.fall || 0, fallTarget, Math.min(0.4, dt * 3));
    this.fallGain.gain.setTargetAtTime(this.smooth.fall, t, 0.1);
    this.fallFilter.frequency.setTargetAtTime(700 + fallNear * 2600, t, 0.2);

    // ---- music ----
    const flow = clamp01(s.flow || 0);
    const musicTarget = this.musicVol * (0.18 + flow * 0.82) * (s.grounded ? 0.4 : 1);
    this.smooth.music = lerp(this.smooth.music, musicTarget, Math.min(0.1, dt * 0.6));
    this.music.gain.setTargetAtTime(this.smooth.music, t, 0.4);
    for (let i = 0; i < this.musicNodes.length; i++) {
      const n = this.musicNodes[i];
      const open = clamp01(flow * 1.4 - i * 0.22);
      n.g.gain.setTargetAtTime(0.5 * (0.2 + open * 0.8) * [0.5, 0.34, 0.22, 0.13][i] * 2, t, 0.6);
    }
  }

  /** One-shot transients. */
  bang(kind, strength = 1) {
    if (!this.started || !this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amp = Math.max(0.05, Math.min(1.6, strength));

    const burst = (dur, type, f0, f1, g, q) => {
      const src = ctx.createBufferSource();
      src.buffer = this.white;
      src.loop = true;
      const flt = ctx.createBiquadFilter();
      flt.type = type;
      flt.frequency.setValueAtTime(f0, t);
      flt.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      if (q) flt.Q.value = q;
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0, t);
      gn.gain.linearRampToValueAtTime(g * amp, t + Math.min(0.02, dur * 0.2));
      gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(flt);
      flt.connect(gn);
      gn.connect(this.sfx);
      gn.connect(this.send);
      src.start(t);
      src.stop(t + dur + 0.05);
    };

    const thump = (dur, f0, f1, g) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(18, f1), t + dur);
      const gn = ctx.createGain();
      gn.gain.setValueAtTime(0, t);
      gn.gain.linearRampToValueAtTime(g * amp, t + 0.008);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gn);
      gn.connect(this.sfx);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    };

    switch (kind) {
      case 'deploy':
        // the wing catching air: a whump that opens upward
        burst(0.42, 'lowpass', 300, 2600, 0.5);
        thump(0.3, 150, 52, 0.42);
        break;
      case 'pop':
        burst(0.14, 'bandpass', 1800, 700, 0.34, 2.2);
        break;
      case 'stow':
        burst(0.18, 'lowpass', 1400, 320, 0.22);
        break;
      case 'crash': {
        // Four things at once: the body hitting rock, the rock itself, the
        // debris after it, and the man inside the suit.
        thump(0.80, 165, 24, 2.6);          // the weight of it
        thump(0.34, 70, 20, 1.9);           // the sub under that
        burst(0.10, 'bandpass', 2400, 820, 1.7, 1.0);  // the slap
        burst(1.40, 'lowpass', 1900, 55, 1.25);        // the tail
        burst(0.60, 'highpass', 900, 3600, 0.45, 0.8); // grit and scree
        break;
      }
      case 'land':
        burst(0.26, 'lowpass', 900, 160, 0.32);
        thump(0.22, 95, 40, 0.3);
        break;
      case 'jump':
        burst(0.16, 'highpass', 700, 1800, 0.16);
        break;
      case 'skim':
        burst(0.3, 'bandpass', 2400, 900, 0.3, 1.4);
        break;
      case 'gate': {
        const o1 = ctx.createOscillator();
        const o2 = ctx.createOscillator();
        o1.frequency.value = 880;
        o2.frequency.value = 1320;
        const gn = ctx.createGain();
        gn.gain.setValueAtTime(0, t);
        gn.gain.linearRampToValueAtTime(0.09 * amp, t + 0.01);
        gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
        o1.connect(gn); o2.connect(gn); gn.connect(this.sfx); gn.connect(this.send);
        o1.start(t); o2.start(t);
        o1.stop(t + 0.55); o2.stop(t + 0.55);
        break;
      }
      case 'stall':
        burst(0.5, 'bandpass', 420, 180, 0.4, 0.8);
        break;
      default:
        break;
    }
  }

  suspend() {
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
    this.started = false;
  }
}
