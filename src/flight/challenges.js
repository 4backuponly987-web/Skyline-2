// Challenges: 80 graded objectives across five tiers plus mastery combos.
//
// Novice and Competent are meant to be passed by somebody still learning
// the suit -- they are the on-ramp, and they pay for the first few things
// in the shop. Expert upwards is where it gets serious; Legend is close to
// what the model can physically do.
// They are evaluated from the run summary, never from live state, so they can
// never be half-awarded.

import { fmtSpeed, fmtLong, fmtShort, toSpeed, speedLabel } from '../core/math.js';
import { TIER_CREDITS } from '../game/shop.js';

export const TIERS = [
  { key: 'novice', name: 'Novice' },
  { key: 'competent', name: 'Competent' },
  { key: 'expert', name: 'Expert' },
  { key: 'master', name: 'Master' },
  { key: 'legend', name: 'Legend' },
];

const TIER_KEYS = TIERS.map((t) => t.key);

const n0 = (v) => Math.round(v).toLocaleString('en-US');
const m1 = (v) => fmtShort(v);
const s1 = (v) => v.toFixed(1) + ' s';
const km2 = (v) => fmtLong(v);
const kmh = (v) => fmtSpeed(v);
const xm = (v) => 'x' + v.toFixed(1);

/**
 * family: name template, metric, per-tier targets, formatter, direction.
 */
const FAMILIES = [
  {
    id: 'speed', name: (t) => `Hit ${Math.round(toSpeed(t))} ${speedLabel().toLowerCase()}`,
    metric: (s) => s.topSpeed, targets: [140 / 3.6, 190 / 3.6, 250 / 3.6, 290 / 3.6, 318 / 3.6],
    fmt: kmh, label: (t) => Math.round(toSpeed(t)) + ' ' + speedLabel().toLowerCase(),
  },
  {
    id: 'dist', name: (t) => `Fly ${fmtLong(t)} in one run`,
    metric: (s) => s.distance, targets: [1100, 2800, 7000, 13000, 20000],
    fmt: km2, label: (t) => fmtLong(t),
  },
  {
    id: 'time', name: (t) => `Stay up for ${t} s`,
    metric: (s) => s.time, targets: [30, 65, 130, 230, 330],
    fmt: s1, label: (t) => t + ' s',
  },
  {
    id: 'score', name: (t) => `Bank ${n0(t)} points`,
    metric: (s) => s.score, targets: [4500, 22000, 110000, 340000, 900000],
    fmt: n0, label: (t) => n0(t),
  },
  {
    id: 'close', name: (t) => `Pass within ${fmtShort(t)} of rock`,
    metric: (s) => s.closest, targets: [14, 8, 4, 1.8, 0.9], lower: true,
    fmt: m1, label: (t) => fmtShort(t),
  },
  {
    id: 'proxtime', name: (t) => `Spend ${t} s in the close-shave zone`,
    metric: (s) => s.proximityTime, targets: [3, 9, 24, 55, 95],
    fmt: s1, label: (t) => t + ' s',
  },
  {
    id: 'mult', name: (t) => `Reach a x${t} multiplier`,
    metric: (s) => s.peakMultiplier, targets: [1.8, 3.2, 5.2, 8, 10.5],
    fmt: xm, label: (t) => 'x' + t,
  },
  {
    id: 'tricks', name: (t) => `Land ${t} tricks in one run`,
    metric: (s) => s.tricks, targets: [3, 9, 22, 44, 70],
    fmt: n0, label: (t) => String(t),
  },
  {
    id: 'revs', name: (t) => `Stack ${t} rotations in one trick`,
    metric: (s) => s.maxRevs, targets: [2, 3, 5, 9, 13],
    fmt: n0, label: (t) => String(t),
  },
  {
    id: 'skim', name: (t) => `Hold a skim for ${t} s`,
    metric: (s) => s.longestSkim, targets: [1, 2.2, 4.5, 8.5, 13],
    fmt: s1, label: (t) => t + ' s',
  },
  {
    id: 'surf', name: (t) => `Ridge-surf for ${t} s`,
    metric: (s) => s.longestSurf, targets: [2, 5.5, 12, 24, 38],
    fmt: s1, label: (t) => t + ' s',
  },
  {
    id: 'gaps', name: (t) => `Thread ${t} gap${t > 1 ? 's' : ''} in one run`,
    metric: (s) => s.gapCount, targets: [1, 3, 8, 17, 27],
    fmt: n0, label: (t) => String(t),
  },
  {
    id: 'arch', name: (t) => `Fly ${t} arch${t > 1 ? 'es' : ''} in one run`,
    metric: (s) => s.archCount, targets: [1, 2, 5, 10, 15],
    fmt: n0, label: (t) => String(t),
  },
  {
    id: 'cave', name: (t) => `Run ${t} cave${t > 1 ? 's' : ''} in one run`,
    metric: (s) => s.caveCount, targets: [1, 2, 3, 7, 11],
    fmt: n0, label: (t) => String(t),
  },
  {
    id: 'rolls', name: (t) => `${t} barrel rolls in one run`,
    metric: (s) => s.counts.roll || 0, targets: [2, 6, 15, 33, 52],
    fmt: n0, label: (t) => String(t),
  },
  {
    id: 'flow', name: (t) => `Fill the flow meter to ${Math.round(t * 100)}%`,
    metric: (s) => s.flow, targets: [0.28, 0.5, 0.72, 0.92, 0.985],
    fmt: (v) => Math.round(v * 100) + '%', label: (t) => Math.round(t * 100) + '%',
  },
];

function buildChallenges() {
  const out = [];
  for (const f of FAMILIES) {
    f.targets.forEach((t, i) => {
      out.push({
        id: `${f.id}.${i}`,
        tier: TIER_KEYS[i],
        name: f.name(t),
        metric: f.metric,
        target: t,
        lower: !!f.lower,
        fmt: f.fmt,
        targetLabel: f.label(t),
      });
    });
  }

  // --- mastery combos -----------------------------------------------------
  const mastery = [
    {
      id: 'm.perfectClose', name: 'Perfect landing after a sub-5 m pass',
      test: (s) => s.landingGrade === 'PERFECT LANDING' && s.closest < 5,
      targetLabel: 'combo', metric: (s) => (s.landingGrade === 'PERFECT LANDING' && s.closest < 5 ? 1 : 0),
    },
    {
      id: 'm.archRoll', name: 'An arch and a double roll in one run',
      test: (s) => s.archCount >= 1 && s.maxRevs >= 2,
      metric: (s) => (s.archCount >= 1 && s.maxRevs >= 2 ? 1 : 0), targetLabel: 'combo',
    },
    {
      id: 'm.caveSpeed', name: 'Run a cave above 220 km/h',
      test: (s) => s.caveCount >= 1 && s.topSpeed > 220 / 3.6,
      metric: (s) => (s.caveCount >= 1 && s.topSpeed > 220 / 3.6 ? 1 : 0), targetLabel: 'combo',
    },
    {
      id: 'm.longClean', name: '5 km with no contact and a clean landing',
      test: (s) => s.distance > 5000 && s.landingGrade && s.landingGrade.includes('LANDING') && s.peakMultiplier > 2,
      metric: (s) => (s.distance > 5000 && s.landingGrade && s.landingGrade.includes('LANDING') ? 1 : 0), targetLabel: 'combo',
    },
    {
      id: 'm.surfTrick', name: 'Ridge-surf 10 s then land a trick',
      test: (s) => s.longestSurf > 10 && s.tricks > 0,
      metric: (s) => (s.longestSurf > 10 && s.tricks > 0 ? 1 : 0), targetLabel: 'combo',
    },
    {
      id: 'm.gapChain', name: 'Three gaps and a x5 multiplier',
      test: (s) => s.gapCount >= 3 && s.peakMultiplier >= 5,
      metric: (s) => (s.gapCount >= 3 && s.peakMultiplier >= 5 ? 1 : 0), targetLabel: 'combo',
    },
    {
      id: 'm.variety', name: 'Five different trick types in one run',
      test: (s) => Object.keys(s.counts).length >= 5,
      metric: (s) => Object.keys(s.counts).length, targetLabel: '5 types',
    },
    {
      id: 'm.everything', name: 'Arch, cave, gap, skim and a landing',
      test: (s) => s.archCount && s.caveCount && s.gapCount && s.longestSkim > 1 && s.landingGrade,
      metric: (s) => ((s.archCount ? 1 : 0) + (s.caveCount ? 1 : 0) + (s.gapCount ? 1 : 0) + (s.longestSkim > 1 ? 1 : 0) + (s.landingGrade ? 1 : 0)),
      targetLabel: '5 of 5',
    },
  ];
  for (const m of mastery) {
    out.push({
      id: m.id, tier: 'legend', name: m.name, metric: m.metric,
      target: 1, test: m.test, fmt: n0, targetLabel: m.targetLabel, mastery: true,
    });
  }
  return out;
}

export const CHALLENGES = buildChallenges();

export function evaluateRun(summary, save) {
  const newly = [];
  for (const c of CHALLENGES) {
    let value;
    try { value = c.metric(summary); } catch (e) { continue; }
    if (value === undefined || Number.isNaN(value)) continue;
    if (!(c.lower && value >= 99)) save.setBest(c.id, value, !c.lower);
    const pass = c.test ? c.test(summary) : (c.lower ? value <= c.target : value >= c.target);
    if (pass && !save.data.challenges[c.id]) {
      save.data.challenges[c.id] = true;
      // Challenges are where credits come from, and they are worth more the
      // harder they are. A mastery combo pays a Master-tier purse.
      const purse = TIER_CREDITS[c.tier] || TIER_CREDITS.master;
      save.data.credits = (save.data.credits || 0) + purse;
      c.purse = purse;
      newly.push(c);
    }
  }
  if (newly.length) save.flush();
  return newly;
}

export function progressOf(save) {
  const done = CHALLENGES.filter((c) => save.data.challenges[c.id]).length;
  return { done, total: CHALLENGES.length };
}
