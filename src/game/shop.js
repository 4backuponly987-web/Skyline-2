// The shop.
//
// Everything in here is cosmetic. A wingsuit that flew better than another
// one would make the challenges mean different things depending on what you
// had bought, and the whole scoring system rests on every run being flown by
// the same suit. So you buy looks, and you earn them by flying well.
//
// Colours are linear RGB triples, matching the palettes in rig.js and
// fabric.js: the body palette is [suit, helmet, boots, visor, container].

/**
 * Credits paid out the first time a challenge of each tier is completed.
 *
 * One good run clears most of a tier at once -- sixteen families all tick
 * over together -- so these have to be small. At sixty a single mid run
 * paid for half the shop. Completing every challenge in the game is worth
 * about 16,000 against a shop that costs about 32,000, so the rest comes
 * from racing and nothing is a foregone conclusion.
 */
export const TIER_CREDITS = {
  novice: 15,
  competent: 40,
  expert: 110,
  master: 260,
  legend: 600,
};

/** Credits for a race, by placing and difficulty. */
export const RACE_CREDITS = {
  easy: 25, medium: 55, hard: 110, extreme: 200, pro: 380,
};

export const CATEGORIES = [
  { key: 'wingsuit', name: 'Wingsuits', note: 'The wing itself: canopy colour and leading edge.' },
  { key: 'outfit', name: 'Outfits', note: 'The suit under the wing, and the boots.' },
  { key: 'helmet', name: 'Helmets', note: 'Shell and visor.' },
  { key: 'trail', name: 'Smoke trails', note: 'What you leave behind you.' },
];

export const SHOP = [
  // ---- wingsuits: [fabric, accent] -------------------------------------
  { id: 'w-slate', cat: 'wingsuit', name: 'Slate', price: 0,
    note: 'Standard issue.', fabric: [0.300, 0.322, 0.372], accent: [0.86, 0.32, 0.12] },
  { id: 'w-ember', cat: 'wingsuit', name: 'Ember', price: 450,
    note: 'Burnt orange, black leading edge.', fabric: [0.62, 0.22, 0.07], accent: [0.09, 0.08, 0.09] },
  { id: 'w-glacier', cat: 'wingsuit', name: 'Glacier', price: 450,
    note: 'Pale ice with a deep blue edge.', fabric: [0.72, 0.80, 0.88], accent: [0.07, 0.22, 0.46] },
  { id: 'w-moss', cat: 'wingsuit', name: 'Moss', price: 700,
    note: 'Olive and bone.', fabric: [0.22, 0.30, 0.16], accent: [0.80, 0.78, 0.66] },
  { id: 'w-ink', cat: 'wingsuit', name: 'Ink', price: 700,
    note: 'Near black, with a hot pink edge.', fabric: [0.055, 0.060, 0.075], accent: [0.92, 0.12, 0.46] },
  { id: 'w-sulphur', cat: 'wingsuit', name: 'Sulphur', price: 1100,
    note: 'Impossible to lose in cloud.', fabric: [0.88, 0.78, 0.10], accent: [0.14, 0.13, 0.12] },
  { id: 'w-cardinal', cat: 'wingsuit', name: 'Cardinal', price: 1600,
    note: 'Deep red, gold edge.', fabric: [0.52, 0.055, 0.08], accent: [0.86, 0.66, 0.18] },
  { id: 'w-aurora', cat: 'wingsuit', name: 'Aurora', price: 2600,
    note: 'Green over violet.', fabric: [0.10, 0.52, 0.42], accent: [0.46, 0.18, 0.72] },
  { id: 'w-bone', cat: 'wingsuit', name: 'Bone', price: 3400,
    note: 'Off white. Shows every mark.', fabric: [0.86, 0.84, 0.79], accent: [0.30, 0.28, 0.26] },

  // ---- outfits: [suit, boots] ------------------------------------------
  { id: 'o-charcoal', cat: 'outfit', name: 'Charcoal', price: 0,
    note: 'Standard issue.', suit: [0.140, 0.155, 0.190], boots: [0.085, 0.090, 0.105] },
  { id: 'o-sand', cat: 'outfit', name: 'Sand', price: 320,
    note: 'Desert tan.', suit: [0.46, 0.40, 0.29], boots: [0.20, 0.17, 0.13] },
  { id: 'o-navy', cat: 'outfit', name: 'Navy', price: 320,
    note: 'Dark blue, grey boots.', suit: [0.07, 0.11, 0.24], boots: [0.22, 0.23, 0.26] },
  { id: 'o-rust', cat: 'outfit', name: 'Rust', price: 620,
    note: 'Oxidised orange.', suit: [0.38, 0.16, 0.08], boots: [0.11, 0.09, 0.08] },
  { id: 'o-forest', cat: 'outfit', name: 'Forest', price: 620,
    note: 'Deep green.', suit: [0.09, 0.18, 0.12], boots: [0.10, 0.10, 0.09] },
  { id: 'o-steel', cat: 'outfit', name: 'Steel', price: 1200,
    note: 'Pale grey with white boots.', suit: [0.52, 0.55, 0.59], boots: [0.78, 0.79, 0.80] },
  { id: 'o-mono', cat: 'outfit', name: 'Monochrome', price: 2200,
    note: 'Black on black.', suit: [0.045, 0.045, 0.050], boots: [0.02, 0.02, 0.02] },

  // ---- helmets: [shell, visor] -----------------------------------------
  { id: 'h-signal', cat: 'helmet', name: 'Signal', price: 0,
    note: 'Standard issue.', helmet: [0.88, 0.33, 0.13], visor: [0.085, 0.130, 0.200] },
  { id: 'h-white', cat: 'helmet', name: 'Chalk', price: 260,
    note: 'Plain white, smoked visor.', helmet: [0.88, 0.88, 0.86], visor: [0.05, 0.05, 0.06] },
  { id: 'h-matte', cat: 'helmet', name: 'Matte', price: 260,
    note: 'Flat black, clear visor.', helmet: [0.07, 0.07, 0.08], visor: [0.22, 0.30, 0.38] },
  { id: 'h-lime', cat: 'helmet', name: 'Lime', price: 540,
    note: 'Visible from the valley floor.', helmet: [0.62, 0.86, 0.10], visor: [0.06, 0.09, 0.07] },
  { id: 'h-cobalt', cat: 'helmet', name: 'Cobalt', price: 540,
    note: 'Blue shell, gold visor.', helmet: [0.07, 0.24, 0.62], visor: [0.52, 0.40, 0.10] },
  { id: 'h-chrome', cat: 'helmet', name: 'Chrome', price: 1400,
    note: 'Mirror finish.', helmet: [0.78, 0.80, 0.84], visor: [0.40, 0.44, 0.50] },
  { id: 'h-gold', cat: 'helmet', name: 'Gold Leaf', price: 3000,
    note: 'Entirely unnecessary.', helmet: [0.82, 0.64, 0.16], visor: [0.10, 0.08, 0.04] },

  // ---- trails ----------------------------------------------------------
  { id: 't-vapour', cat: 'trail', name: 'Vapour', price: 0,
    note: 'Standard issue.', trail: [0.80, 0.88, 0.96], width: 1 },
  { id: 't-coral', cat: 'trail', name: 'Coral', price: 300,
    note: 'Warm red smoke.', trail: [0.95, 0.35, 0.28], width: 1.1 },
  { id: 't-mint', cat: 'trail', name: 'Mint', price: 300,
    note: 'Pale green.', trail: [0.45, 0.95, 0.70], width: 1.1 },
  { id: 't-violet', cat: 'trail', name: 'Violet', price: 650,
    note: 'Deep purple.', trail: [0.58, 0.32, 0.95], width: 1.15 },
  { id: 't-amber', cat: 'trail', name: 'Amber', price: 650,
    note: 'Thick orange smoke.', trail: [0.98, 0.64, 0.12], width: 1.35 },
  { id: 't-ink', cat: 'trail', name: 'Ink', price: 1300,
    note: 'Black smoke. Dramatic, slightly rude.', trail: [0.10, 0.10, 0.12], width: 1.4 },
  { id: 't-gold', cat: 'trail', name: 'Gold Dust', price: 2400,
    note: 'Wide and bright.', trail: [1.0, 0.82, 0.30], width: 1.6 },
  { id: 't-aurora', cat: 'trail', name: 'Aurora', price: 3800,
    note: 'Shifts green to violet along its length.', trail: [0.30, 0.92, 0.62], width: 1.5, shift: [0.52, 0.22, 0.92] },
];

export const FREE_IDS = SHOP.filter((i) => i.price === 0).map((i) => i.id);

export const byId = (id) => SHOP.find((i) => i.id === id);

export function defaultEquipped() {
  return { wingsuit: 'w-slate', outfit: 'o-charcoal', helmet: 'h-signal', trail: 't-vapour' };
}

/**
 * Builds the body palette and the wing/trail colours from what is equipped.
 * Anything missing falls back to standard issue, so a save written before
 * the shop existed still paints a jumper.
 */
export function resolve(equipped) {
  const e = Object.assign(defaultEquipped(), equipped || {});
  const w = byId(e.wingsuit) || byId('w-slate');
  const o = byId(e.outfit) || byId('o-charcoal');
  const h = byId(e.helmet) || byId('h-signal');
  const t = byId(e.trail) || byId('t-vapour');
  return {
    // [suit, helmet, boots, visor, container]
    palette: [o.suit, h.helmet, o.boots, h.visor, [0.360, 0.380, 0.420]],
    fabric: w.fabric,
    accent: w.accent,
    trail: t.trail,
    trailWidth: t.width || 1,
    trailShift: t.shift || null,
  };
}
