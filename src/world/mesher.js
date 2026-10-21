// Naive surface nets.
//
// One vertex per cell that straddles the surface, placed at the average of
// the edge crossings, then a quad for every grid edge that changes sign.
// Compared with marching cubes this gives far fewer triangles, no sliver
// cases and much better normals for the same grid, in a fraction of the code.
//
// Normals come from the SDF gradient rather than the mesh, so the shading
// matches the function the collision queries also use.

// corner index: c = dx + 2*dy + 4*dz
const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

// the 12 cube edges as corner pairs
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7],   // x
  [0, 2], [1, 3], [4, 6], [5, 7],   // y
  [0, 4], [1, 5], [2, 6], [3, 7],   // z
];

/**
 * @param {object} opts
 *   bounds {x0,y0,z0,x1,y1,z1}
 *   res    [nx,ny,nz] cells
 *   sample (x,y,z,ix,iy,iz) -> signed distance (negative = solid)
 *   normal (x,y,z,out) -> fills out.x/y/z  (optional, falls back to gradient)
 * @returns {{positions:Float32Array, normals:Float32Array, indices:Uint32Array,
 *            count:number}}
 */
export function surfaceNets(opts) {
  const { bounds, res, sample } = opts;
  const nx = res[0];
  const ny = res[1];
  const nz = res[2];
  const sx = (bounds.x1 - bounds.x0) / nx;
  const sy = (bounds.y1 - bounds.y0) / ny;
  const sz = (bounds.z1 - bounds.z0) / nz;

  const gx = nx + 1;
  const gy = ny + 1;
  const gz = nz + 1;
  const grid = new Float32Array(gx * gy * gz);

  for (let k = 0; k < gz; k++) {
    const wz = bounds.z0 + k * sz;
    for (let j = 0; j < gy; j++) {
      const wy = bounds.y0 + j * sy;
      const row = (k * gy + j) * gx;
      for (let i = 0; i < gx; i++) {
        grid[row + i] = sample(bounds.x0 + i * sx, wy, wz, i, j, k);
      }
    }
  }

  const at = (i, j, k) => grid[(k * gy + j) * gx + i];

  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const pos = [];
  const v = new Float32Array(8);

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const d = at(i + CORNER[c][0], j + CORNER[c][1], k + CORNER[c][2]);
          v[c] = d;
          if (d < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let ax = 0, ay = 0, az = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const a = EDGES[e][0];
          const b = EDGES[e][1];
          const va = v[a];
          const vb = v[b];
          if ((va < 0) === (vb < 0)) continue;
          const t = va / (va - vb);
          ax += CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * t;
          ay += CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * t;
          az += CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * t;
          n++;
        }
        if (!n) continue;
        cellVert[(k * ny + j) * nx + i] = pos.length / 3;
        pos.push(
          bounds.x0 + (i + ax / n) * sx,
          bounds.y0 + (j + ay / n) * sy,
          bounds.z0 + (k + az / n) * sz,
        );
      }
    }
  }

  const vcount = pos.length / 3;
  if (!vcount) return { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0), count: 0 };

  const cv = (i, j, k) =>
    (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) ? -1 : cellVert[(k * ny + j) * nx + i];

  const idx = [];
  // Winding: faces must turn their front toward the empty side, which is the
  // side the SDF gradient points to.
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) idx.push(a, b, c, a, c, d);
    else idx.push(a, c, b, a, d, c);
  };

  // every interior grid edge that changes sign owns one quad
  for (let k = 0; k < gz; k++) {
    for (let j = 0; j < gy; j++) {
      for (let i = 0; i < gx; i++) {
        const s0 = at(i, j, k) < 0;
        if (i + 1 < gx && j > 0 && k > 0) {
          const s1 = at(i + 1, j, k) < 0;
          if (s0 !== s1) {
            quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k), s0);
          }
        }
        if (j + 1 < gy && i > 0 && k > 0) {
          const s1 = at(i, j + 1, k) < 0;
          if (s0 !== s1) {
            quad(cv(i - 1, j, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i - 1, j, k), !s0);
          }
        }
        if (k + 1 < gz && i > 0 && j > 0) {
          const s1 = at(i, j, k + 1) < 0;
          if (s0 !== s1) {
            quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k), s0);
          }
        }
      }
    }
  }

  // normals from the gradient of the field itself
  const positions = new Float32Array(pos);
  const normals = new Float32Array(vcount * 3);
  const h = Math.min(sx, sy, sz) * 0.45;
  const grad = opts.gradient || ((x, y, z, out) => {
    const d = opts.field;
    out.x = d(x + h, y, z) - d(x - h, y, z);
    out.y = d(x, y + h, z) - d(x, y - h, z);
    out.z = d(x, y, z + h) - d(x, y, z - h);
  });
  const out = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < vcount; i++) {
    grad(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2], out);
    const l = Math.hypot(out.x, out.y, out.z) || 1;
    normals[i * 3] = out.x / l;
    normals[i * 3 + 1] = out.y / l;
    normals[i * 3 + 2] = out.z / l;
  }

  return {
    positions,
    normals,
    indices: vcount > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
    count: vcount,
  };
}
