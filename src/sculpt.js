// Sculpting brushes. All functions work in the mesh's local space on an
// indexed BufferGeometry (see primitives.js#makeSculptable).
//
// They are deliberately free of any XR or rendering code so they can be unit
// tested in Node and reused by both the hand-tracked and desktop front ends.

const EPS = 1e-9;

// Smooth bell falloff: 1 at the center, 0 at the brush edge.
export function falloff(t) {
  if (t >= 1) return 0;
  const k = 1 - t * t;
  return k * k;
}

// Mirror a point (array or {x,y,z}) across the local YZ plane.
export function mirrorX(p) {
  return { x: -p.x, y: p.y, z: p.z };
}

// Finger-displaces-clay brush: vertices inside a sphere around the fingertip
// are pushed out of it, which leaves a dent wherever you poke.
export function pushBrush(geometry, tip, radius, strength = 0.6) {
  const pos = geometry.attributes.position.array;
  const nrm = geometry.attributes.normal.array;
  const r2 = radius * radius;
  let changed = false;
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - tip.x, dy = pos[i + 1] - tip.y, dz = pos[i + 2] - tip.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const d = Math.sqrt(d2);
    const push = (radius - d) * strength * (0.35 + 0.65 * falloff(d / radius));
    if (d > EPS) {
      pos[i] += (dx / d) * push;
      pos[i + 1] += (dy / d) * push;
      pos[i + 2] += (dz / d) * push;
    } else {
      pos[i] -= nrm[i] * push;
      pos[i + 1] -= nrm[i + 1] * push;
      pos[i + 2] -= nrm[i + 2] * push;
    }
    changed = true;
  }
  return changed;
}

// Adds (or with a negative amount removes) volume along the surface normals.
export function inflateBrush(geometry, center, radius, amount) {
  const pos = geometry.attributes.position.array;
  const nrm = geometry.attributes.normal.array;
  const r2 = radius * radius;
  let changed = false;
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - center.x, dy = pos[i + 1] - center.y, dz = pos[i + 2] - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const w = amount * falloff(Math.sqrt(d2) / radius);
    pos[i] += nrm[i] * w;
    pos[i + 1] += nrm[i + 1] * w;
    pos[i + 2] += nrm[i + 2] * w;
    changed = true;
  }
  return changed;
}

// Vertex adjacency in CSR form, built once per mesh topology.
export function buildAdjacency(geometry) {
  const count = geometry.attributes.position.count;
  const idx = geometry.index.array;
  const sets = Array.from({ length: count }, () => new Set());
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  const offsets = new Uint32Array(count + 1);
  for (let v = 0; v < count; v++) offsets[v + 1] = offsets[v] + sets[v].size;
  const neighbors = new Uint32Array(offsets[count]);
  for (let v = 0; v < count; v++) {
    let k = offsets[v];
    for (const n of sets[v]) neighbors[k++] = n;
  }
  return { offsets, neighbors };
}

// Laplacian relax toward the neighbor average.
export function smoothBrush(geometry, adjacency, center, radius, strength = 0.5) {
  const pos = geometry.attributes.position.array;
  const { offsets, neighbors } = adjacency;
  const r2 = radius * radius;
  let changed = false;
  for (let v = 0, i = 0; i < pos.length; v++, i += 3) {
    const dx = pos[i] - center.x, dy = pos[i + 1] - center.y, dz = pos[i + 2] - center.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;
    const start = offsets[v], end = offsets[v + 1];
    if (end === start) continue;
    let ax = 0, ay = 0, az = 0;
    for (let k = start; k < end; k++) {
      const j = neighbors[k] * 3;
      ax += pos[j]; ay += pos[j + 1]; az += pos[j + 2];
    }
    const n = end - start;
    const w = strength * falloff(Math.sqrt(d2) / radius);
    pos[i] += (ax / n - pos[i]) * w;
    pos[i + 1] += (ay / n - pos[i + 1]) * w;
    pos[i + 2] += (az / n - pos[i + 2]) * w;
    changed = true;
  }
  return changed;
}

// Pinch-and-pull brush. Captures the vertices around the pinch point when
// the pinch starts, then drags them with the hand using the falloff weights.
// With `mirror`, the region mirrored across X follows a mirrored delta.
export class GrabStroke {
  constructor(geometry, center, radius, mirror = false) {
    this.geometry = geometry;
    const pos = geometry.attributes.position.array;
    const weights = new Map(); // vertex -> [primary, mirrored]
    const collect = (c, slot) => {
      const r2 = radius * radius;
      for (let v = 0, i = 0; i < pos.length; v++, i += 3) {
        const dx = pos[i] - c.x, dy = pos[i + 1] - c.y, dz = pos[i + 2] - c.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r2) continue;
        const w = falloff(Math.sqrt(d2) / radius);
        if (w <= 0) continue;
        const entry = weights.get(v) || [0, 0];
        entry[slot] = w;
        weights.set(v, entry);
      }
    };
    collect(center, 0);
    if (mirror) collect(mirrorX(center), 1);

    this.indices = new Uint32Array(weights.size);
    this.w1 = new Float32Array(weights.size);
    this.w2 = new Float32Array(weights.size);
    this.origin = new Float32Array(weights.size * 3);
    let k = 0;
    for (const [v, [a, b]] of weights) {
      this.indices[k] = v;
      // Where both regions overlap (near the mirror plane) keep the stronger
      // pull instead of adding them, so the middle doesn't move twice as far.
      const norm = a + b > 0 ? Math.max(a, b) / (a + b) : 0;
      this.w1[k] = a * norm;
      this.w2[k] = b * norm;
      this.origin[k * 3] = pos[v * 3];
      this.origin[k * 3 + 1] = pos[v * 3 + 1];
      this.origin[k * 3 + 2] = pos[v * 3 + 2];
      k++;
    }
  }

  get empty() {
    return this.indices.length === 0;
  }

  // delta: local-space offset of the hand since the stroke started.
  update(delta) {
    const pos = this.geometry.attributes.position.array;
    for (let k = 0; k < this.indices.length; k++) {
      const i = this.indices[k] * 3;
      const a = this.w1[k], b = this.w2[k];
      pos[i] = this.origin[k * 3] + delta.x * a - delta.x * b;
      pos[i + 1] = this.origin[k * 3 + 1] + delta.y * (a + b);
      pos[i + 2] = this.origin[k * 3 + 2] + delta.z * (a + b);
    }
  }
}

// Distance from a local point to the closest vertex (cheap surface proximity).
export function nearestVertexDistance(geometry, p) {
  const pos = geometry.attributes.position.array;
  let best = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - p.x, dy = pos[i + 1] - p.y, dz = pos[i + 2] - p.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

// Call after a brush changed positions.
export function finishEdit(geometry, { bounds = false } = {}) {
  geometry.attributes.position.needsUpdate = true;
  geometry.computeVertexNormals();
  if (bounds) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
}
