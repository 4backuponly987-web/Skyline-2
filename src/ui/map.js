// World map: a shaded-relief render of the baked heightfield with POIs,
// respawn points and the player on it. Click to select, then pick a launch
// mode.

import { WORLD } from '../world/field.js';
import { POI_KIND } from '../world/pois.js';
import { clamp, clamp01 } from '../core/math.js';

export function renderRelief(field, size = 620) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const g = field.eroded;
  const res = field.res;
  const cell = field.cell;
  // sun from the north-west, the cartographic convention
  const lx = -0.62, ly = 0.55, lz = -0.56;
  const il = 1 / Math.hypot(lx, ly, lz);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.min(res - 3, Math.max(1, (x / size) * res | 0));
      const gy = Math.min(res - 3, Math.max(1, (y / size) * res | 0));
      const i = gy * res + gx;
      const h = g[i];
      // Central differences over two cells. A one-cell forward difference at
      // this zoom is mostly sampling noise, which is what made the relief
      // look soft and vague rather than like a mountain range.
      let nx = (g[i - 1] - g[i + 1]) / (2 * cell);
      let nz = (g[i - res] - g[i + res]) / (2 * cell);
      const l = Math.hypot(nx, 1, nz);
      let d = (-nx * lx * il + (1 / l) * ly * il + -nz * lz * il);
      // keep plenty of light in the shadows: a map you cannot read is useless
      d = clamp01(d * 0.78 + 0.52);
      // a touch of slope darkening picks the ridges out from the valleys
      d *= 1 - clamp01((1 - 1 / l) * 0.5);

      const alt = clamp01((h - 560) / 2500);
      const snow = clamp01((alt - 0.47) * 3.0) * clamp01(1 / l * 1.4);
      let r, gg, b;
      if (alt < 0.11) { r = 96; gg = 122; b = 88; }
      else if (alt < 0.30) { r = 104 + alt * 110; gg = 130 + alt * 90; b = 92 + alt * 70; }
      else { r = 162 + alt * 56; gg = 156 + alt * 52; b = 146 + alt * 50; }
      r = r * (1 - snow) + 248 * snow;
      gg = gg * (1 - snow) + 251 * snow;
      b = b * (1 - snow) + 255 * snow;

      const o = (y * size + x) * 4;
      img.data[o] = r * d;
      img.data[o + 1] = gg * d;
      img.data[o + 2] = b * d;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // water
  ctx.globalAlpha = 0.85;
  for (const L of field.lakes) {
    const p = worldToMap(L.x, L.z, size);
    const r = (L.r / WORLD.size) * size;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#28506b';
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return canvas;
}

export function worldToMap(x, z, size) {
  return {
    x: ((x + WORLD.half) / WORLD.size) * size,
    y: ((z + WORLD.half) / WORLD.size) * size,
  };
}

export function mapToWorld(px, py, size) {
  return {
    x: (px / size) * WORLD.size - WORLD.half,
    z: (py / size) * WORLD.size - WORLD.half,
  };
}

export class WorldMap {
  constructor(game) {
    this.game = game;
    // As big as a 1080p window can take. The map is how you choose where
    // to fly, and at 620 it was a thumbnail.
    this.size = Math.max(620, Math.min(980, Math.round(Math.min(
      window.innerWidth * 0.62, window.innerHeight * 0.86,
    ))));
    // Render at twice the logical size. Everything below still works in
    // 620-unit coordinates; the extra pixels go into the relief and the
    // text, which at 620 was a blurry upscale with unreadable labels.
    this.scale = 2;
    this.relief = renderRelief(game.field, this.size * this.scale);
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'mapCanvas';
    this.canvas.width = this.size * this.scale;
    this.canvas.height = this.size * this.scale;
    this.canvas.style.width = this.size + 'px';
    this.canvas.style.height = this.size + 'px';
    this.ctx = this.canvas.getContext('2d');
    this.ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.selected = null;
    this.hover = null;
    this.showChallenges = true;

    this.canvas.addEventListener('mousemove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.size;
      const py = ((e.clientY - r.top) / r.height) * this.size;
      this.hover = this.pick(px, py);
      this.draw();
    });
    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.size;
      const py = ((e.clientY - r.top) / r.height) * this.size;
      const hit = this.pick(px, py);
      if (hit) this.select(hit);
      else {
        const w = mapToWorld(px, py, this.size);
        this.select({
          kind: 'custom',
          name: 'Map point',
          x: w.x, z: w.z,
          y: this.game.field.height(w.x, w.z),
          heading: 0,
        });
      }
      this.onSelect?.(this.selected);
      this.draw();
    });
  }

  pick(px, py) {
    let best = null;
    let bd = 13;
    for (const p of this.game.pois) {
      const m = worldToMap(p.x, p.z, this.size);
      const d = Math.hypot(m.x - px, m.y - py);
      if (d < bd) { bd = d; best = p; }
    }
    for (const s of this.game.save.data.spawns) {
      const m = worldToMap(s.x, s.z, this.size);
      const d = Math.hypot(m.x - px, m.y - py);
      if (d < bd) { bd = d; best = { ...s, kind: POI_KIND.SPAWN, y: s.y }; }
    }
    return best;
  }

  select(p) {
    this.selected = p;
  }

  draw() {
    const c = this.ctx;
    const s = this.size;
    c.clearRect(0, 0, s, s);
    c.drawImage(this.relief, 0, 0, s, s);

    const marker = (p, color, r, label, filled) => {
      const m = worldToMap(p.x, p.z, s);
      c.beginPath();
      c.arc(m.x, m.y, r, 0, Math.PI * 2);
      if (filled) { c.fillStyle = color; c.fill(); }
      c.strokeStyle = color;
      c.lineWidth = 1.4;
      c.stroke();
      if (label) {
        c.font = '600 14px ui-sans-serif, system-ui, sans-serif';
        c.lineJoin = 'round';
        c.lineWidth = 3.5;
        c.strokeStyle = 'rgba(8,12,18,0.85)';
        c.strokeText(label, m.x + r + 6, m.y + 5);
        c.fillStyle = 'rgba(255,255,255,0.97)';
        c.fillText(label, m.x + r + 6, m.y + 5);
        c.lineWidth = 1.4;
      }
    };

    for (const p of this.game.pois) {
      if (p.kind === POI_KIND.SUMMIT) marker(p, 'rgba(255,255,255,0.55)', 2.2, null, true);
    }
    for (const p of this.game.pois) {
      if (p.kind === POI_KIND.WATER) marker(p, 'rgba(120,200,255,0.8)', 3, null, false);
      if (p.kind === POI_KIND.FEATURE) marker(p, 'rgba(140,220,255,0.9)', 4, p.name, false);
      if (p.kind === POI_KIND.LAUNCH) marker(p, '#ff7a3d', 5, p.name, false);
    }
    for (const sp of this.game.save.data.spawns) {
      marker(sp, '#7ee8a8', 4, sp.name, false);
    }

    // player
    const pl = this.game.pilot;
    if (pl && this.game.mode !== 'title') {
      const m = worldToMap(pl.pos.x, pl.pos.z, s);
      c.save();
      c.translate(m.x, m.y);
      const ang = Math.atan2(pl.vel.x, pl.vel.z);
      c.rotate(-ang + Math.PI);
      c.beginPath();
      c.moveTo(0, -7); c.lineTo(5, 6); c.lineTo(0, 3); c.lineTo(-5, 6);
      c.closePath();
      c.fillStyle = '#fff';
      c.fill();
      c.restore();
    }

    if (this.selected) {
      const m = worldToMap(this.selected.x, this.selected.z, s);
      c.strokeStyle = '#ffd36b';
      c.lineWidth = 1.6;
      c.beginPath();
      c.arc(m.x, m.y, 10, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(m.x - 15, m.y); c.lineTo(m.x - 5, m.y);
      c.moveTo(m.x + 5, m.y); c.lineTo(m.x + 15, m.y);
      c.moveTo(m.x, m.y - 15); c.lineTo(m.x, m.y - 5);
      c.moveTo(m.x, m.y + 5); c.lineTo(m.x, m.y + 15);
      c.stroke();
    }

    // scale bar
    const km = (1000 / WORLD.size) * s;
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(14, s - 16); c.lineTo(14 + km, s - 16);
    c.moveTo(14, s - 20); c.lineTo(14, s - 12);
    c.moveTo(14 + km, s - 20); c.lineTo(14 + km, s - 12);
    c.stroke();
    c.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    c.fillStyle = 'rgba(255,255,255,0.85)';
    c.fillText('1 km', 18 + km, s - 12);
  }
}
