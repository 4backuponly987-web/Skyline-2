// Scoring: the close-shave meter, style points, flow chains and landings.
//
// The design intent: proximity is the multiplier, tricks are the base, and
// variety plus flow are what separate a good run from a long one. Repeating
// the same trick pays less; linking different ones pays more; touching
// anything drops the chain (but never the already-banked total).

import { clamp, clamp01, lerp, smoothstep } from '../core/math.js';

export const TRICK_VALUE = {
  roll: 130,
  frontflip: 210,
  backflip: 230,
  heli: 250,
  corkscrew: 190,
  invertOn: 60,
  tumbleRecover: 420,
  gap: 320,
  arch: 420,
  cave: 520,
  tree: 180,
  skim: 240,
  waterSkim: 300,
  ridgeSurf: 260,
  knife: 150,
  invertedSkim: 560,
  mist: 340,
};

export const TRICK_LABEL = {
  roll: 'BARREL ROLL',
  frontflip: 'FRONT FLIP',
  backflip: 'BACK FLIP',
  heli: 'HELICOPTER',
  corkscrew: 'CORKSCREW',
  invertOn: 'INVERTED',
  tumbleRecover: 'TUMBLE RECOVERY',
  gap: 'GAP THREADED',
  arch: 'ARCH FLYTHROUGH',
  cave: 'CAVE RUN',
  tree: 'TREE THREAD',
  skim: 'SKIM',
  waterSkim: 'WATER SKIM',
  ridgeSurf: 'RIDGE SURF',
  knife: 'KNIFE EDGE',
  invertedSkim: 'INVERTED SKIM',
  mist: 'THROUGH THE MIST',
};

const CHAIN_WINDOW = 4.2;
const VARIETY_RECOVER = 38;

export class Scoring {
  constructor(save) {
    this.save = save;
    this.reset();
    this.feed = [];
    this.onPopup = null;
    this.lifetime = save ? save.data.lifetime : { score: 0, distance: 0, time: 0, tricks: 0, best: 0 };
  }

  reset() {
    this.score = 0;
    this.meter = 0;
    this.multiplier = 1;
    this.chain = 0;
    this.chainTimer = 0;
    this.variety = new Map();
    this.closest = 999;
    this.topSpeed = 0;
    this.maxAltitude = 0;
    this.descended = 0;
    this.bestGlide = 0;
    this._lastAlt = null;
    this.runTime = 0;
    this.distance = 0;
    this.tricksDone = 0;
    this.flow = 0;
    this.peakMultiplier = 1;
    this.skimTimer = 0;
    this.surfTimer = 0;
    this.knifeTimer = 0;
    this.lastContact = 99;
    this.banked = false;
    this.counts = {};
    this.proximityTime = 0;
    this.longestSkim = 0;
    this.longestSurf = 0;
    this.gapCount = 0;
    this.archCount = 0;
    this.caveCount = 0;
    this.maxRevs = 0;
  }

  startRun() {
    this.reset();
  }

  /**
   * @param {object} c {prox, speed, agl, contact, vario, inverted, bank,
   *                    overWater, nearTrees, dt}
   */
  update(dt, c) {
    this.runTime += dt;
    this.distance += c.speed * dt;
    this.lastContact += dt;
    if (c.speed > this.topSpeed) this.topSpeed = c.speed;
    if (c.prox < this.closest) this.closest = c.prox;
    // vertical ground covered, and the flattest glide actually held
    if (c.altitude !== undefined) {
      if (c.altitude > this.maxAltitude) this.maxAltitude = c.altitude;
      if (this._lastAlt !== null && this._lastAlt > c.altitude) {
        this.descended += this._lastAlt - c.altitude;
      }
      this._lastAlt = c.altitude;
    }
    if (c.glide !== undefined && c.glide < 20 && c.glide > this.bestGlide
        && c.speed > 20) {
      this.bestGlide = c.glide;
    }

    // ---- close-shave meter ------------------------------------------------
    const near = smoothstep(15, 1.6, c.prox);
    const fast = clamp01((c.speed - 22) / 45);
    const gain = near * fast;
    if (gain > 0.02) {
      this.meter = clamp01(this.meter + gain * dt * 0.55);
      this.proximityTime += dt;
      this.score += gain * dt * 46 * this.multiplier;
    } else {
      this.meter = Math.max(0, this.meter - dt * 0.17);
    }
    this.multiplier = 1 + this.meter * 7;
    if (this.multiplier > this.peakMultiplier) this.peakMultiplier = this.multiplier;

    // ---- flow ---------------------------------------------------------------
    const flowTarget = clamp01(this.meter * 0.65 + clamp01(this.chain / 6) * 0.5);
    this.flow += (flowTarget - this.flow) * (1 - Math.exp(-dt * 0.8));

    // ---- chain timer --------------------------------------------------------
    if (this.chain > 0) {
      this.chainTimer -= dt;
      if (this.chainTimer <= 0) {
        this.chain = 0;
        this.emit('CHAIN ENDED', '', 0, 'dim');
      }
    }

    // ---- variety recovery ---------------------------------------------------
    for (const [k, v] of this.variety) {
      const nv = v - dt / VARIETY_RECOVER;
      if (nv <= 0) this.variety.delete(k);
      else this.variety.set(k, nv);
    }

    // ---- sustained terrain tricks -------------------------------------------
    if (c.prox < 4.2 && c.speed > 30) {
      this.skimTimer += dt;
      if (this.skimTimer > this.longestSkim) this.longestSkim = this.skimTimer;
      if (this.skimTimer > 0.8) {
        const kind = c.inverted ? 'invertedSkim' : (c.overWater ? 'waterSkim' : 'skim');
        this.award(kind, { mult: Math.min(3, this.skimTimer * 0.6) });
        this.skimTimer = 0.1;
      }
    } else this.skimTimer = Math.max(0, this.skimTimer - dt * 2);

    if (c.vario > 1.2 && c.prox < 32 && c.speed > 28) {
      this.surfTimer += dt;
      if (this.surfTimer > this.longestSurf) this.longestSurf = this.surfTimer;
      if (this.surfTimer > 1.8) {
        this.award('ridgeSurf', { mult: 1 });
        this.surfTimer = 0.2;
      }
    } else this.surfTimer = Math.max(0, this.surfTimer - dt * 1.5);

    if (Math.abs(c.bank) > 1.15 && c.prox < 18 && c.speed > 35) {
      this.knifeTimer += dt;
      if (this.knifeTimer > 0.7) {
        this.award('knife', { mult: 1 });
        this.knifeTimer = 0;
      }
    } else this.knifeTimer = 0;

    if (c.contact) this.breakChain();
  }

  breakChain() {
    if (this.meter > 0.03 || this.chain > 0) {
      this.emit('CHAIN LOST', 'contact', 0, 'bad');
    }
    this.meter = 0;
    this.chain = 0;
    this.multiplier = 1;
    this.lastContact = 0;
    this.skimTimer = 0;
  }

  /**
   * Award a trick. `info` may carry {revs, prewind, prox, speed, inverted, mult}
   */
  award(kind, info = {}) {
    const base = TRICK_VALUE[kind] || 100;
    const revs = info.revs || 1;
    const prewind = info.prewind || 0;
    const rep = this.variety.get(kind) || 0;
    const varietyMul = Math.pow(0.55, rep);
    const chainMul = 1 + Math.min(this.chain, 12) * 0.22;
    const ampMul = Math.pow(revs, 1.35);
    const riskMul = 1 + smoothstep(22, 3, info.prox ?? 99) * 1.4 + (info.inverted ? 0.5 : 0);
    const speedMul = 1 + clamp01(((info.speed ?? 50) - 40) / 55) * 0.6;
    const pw = 1 + prewind * 1.1;
    const value = base * ampMul * varietyMul * chainMul * riskMul * speedMul * pw * (info.mult ?? 1) * this.multiplier;

    this.score += value;
    this.variety.set(kind, rep + 1);
    this.chain++;
    this.chainTimer = CHAIN_WINDOW;
    this.tricksDone++;
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    if (revs > this.maxRevs) this.maxRevs = revs;
    if (kind === 'gap') this.gapCount++;
    if (kind === 'arch') this.archCount++;
    if (kind === 'cave') this.caveCount++;

    const tags = [];
    if (revs > 1) tags.push(`x${revs}`);
    if (prewind > 0.25) tags.push('PREWOUND');
    if (riskMul > 2.0) tags.push('CLOSE');
    if (info.inverted) tags.push('INVERTED');
    if (this.chain > 1) tags.push(`CHAIN x${this.chain}`);
    if (varietyMul < 0.6) tags.push('REPEAT');

    this.emit(TRICK_LABEL[kind] || kind.toUpperCase(), tags.join('  '), Math.round(value), 'good');
    return value;
  }

  gradeLanding(landing, ctx) {
    const q = landing.quality;
    let grade = 'CRASH';
    let bonus = 0;
    if (q > 0.82) { grade = 'PERFECT LANDING'; bonus = 1500; }
    else if (q > 0.55) { grade = 'CLEAN LANDING'; bonus = 700; }
    else if (q > 0.2) { grade = 'ROUGH LANDING'; bonus = 220; }
    else { grade = 'HARD LANDING'; bonus = 40; }
    const value = bonus * (1 + this.meter * 2);
    this.score += value;
    this.emit(grade, landing.how === 'canopy' ? 'under canopy' : 'on your feet', Math.round(value), 'good');
    this.landingGrade = grade;
    return { grade, value };
  }

  emit(text, sub, value, kind) {
    const item = { text, sub, value, kind, t: performance.now() / 1000 };
    this.feed.unshift(item);
    if (this.feed.length > 14) this.feed.pop();
    this.onPopup?.(item);
  }

  summary() {
    return {
      score: Math.round(this.score),
      time: this.runTime,
      distance: this.distance,
      topSpeed: this.topSpeed,
      closest: this.closest,
      tricks: this.tricksDone,
      peakMultiplier: this.peakMultiplier,
      counts: { ...this.counts },
      longestSkim: this.longestSkim,
      longestSurf: this.longestSurf,
      gapCount: this.gapCount,
      archCount: this.archCount,
      caveCount: this.caveCount,
      maxRevs: this.maxRevs,
      proximityTime: this.proximityTime,
      landingGrade: this.landingGrade || null,
      flow: this.flow,
      maxAltitude: this.maxAltitude,
      descended: this.descended,
      bestGlide: this.bestGlide,
    };
  }

  bankRun() {
    if (this.banked) return null;
    this.banked = true;
    const s = this.summary();
    if (this.save) this.save.recordRun(s);
    this.emit('RUN BANKED', `${Math.round(this.score).toLocaleString()} points`, 0, 'bank');
    return s;
  }
}
