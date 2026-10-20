import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PRIMITIVES, createPrimitiveGeometry } from '../src/primitives.js';
import {
  pushBrush, inflateBrush, smoothBrush, buildAdjacency, GrabStroke, finishEdit, nearestVertexDistance,
} from '../src/sculpt.js';
import { History, captureGeometry, geometryEntry } from '../src/history.js';

const vec = (g, i) => new THREE.Vector3().fromBufferAttribute(g.attributes.position, i);

function nearestIndex(g, p) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < g.attributes.position.count; i++) {
    const d = vec(g, i).distanceTo(p);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

for (const type of PRIMITIVES) {
  test(`${type} is a closed, welded, sculptable mesh`, () => {
    const g = createPrimitiveGeometry(type);
    assert.ok(g.index, 'indexed');
    assert.ok(g.attributes.normal, 'has normals');
    assert.ok(g.attributes.position.count > 3000, 'dense enough to sculpt');
    const edges = new Map();
    const idx = g.index.array;
    for (let i = 0; i < idx.length; i += 3) {
      const t = [idx[i], idx[i + 1], idx[i + 2]];
      assert.equal(new Set(t).size, 3, 'no degenerate triangles');
      for (let k = 0; k < 3; k++) {
        const a = t[k], b = t[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    const open = [...edges.values()].filter((n) => n !== 2).length;
    assert.equal(open, 0, 'every edge is shared by exactly two triangles (watertight)');
  });
}

test('push brush dents the surface away from the fingertip', () => {
  const g = createPrimitiveGeometry('sphere');
  const top = new THREE.Vector3(0, 0.11, 0);
  const i = nearestIndex(g, top);
  const tip = new THREE.Vector3(0, 0.115, 0); // just above the surface
  for (let k = 0; k < 30; k++) { pushBrush(g, tip, 0.02, 0.5); finishEdit(g); }
  const p = vec(g, i);
  assert.ok(p.y < 0.1, `top vertex pushed down (y=${p.y.toFixed(4)})`);
  assert.ok(p.distanceTo(tip) >= 0.0195, 'vertex ends outside the fingertip sphere');
  const far = nearestIndex(g, new THREE.Vector3(0, -0.11, 0));
  assert.ok(Math.abs(vec(g, far).y + 0.11) < 1e-3, 'far side untouched');
});

test('inflate moves along normals; negative amount carves', () => {
  const g = createPrimitiveGeometry('sphere');
  const i = nearestIndex(g, new THREE.Vector3(0.11, 0, 0));
  const before = vec(g, i).length();
  inflateBrush(g, vec(g, i), 0.03, 0.005);
  assert.ok(vec(g, i).length() > before + 0.004);
  inflateBrush(g, vec(g, i), 0.03, -0.01);
  assert.ok(vec(g, i).length() < before);
});

test('smooth brush relaxes a spike', () => {
  const g = createPrimitiveGeometry('sphere');
  const i = nearestIndex(g, new THREE.Vector3(0, 0, 0.11));
  g.attributes.position.setZ(i, 0.15);
  const adj = buildAdjacency(g);
  for (let k = 0; k < 10; k++) smoothBrush(g, adj, vec(g, i), 0.03, 0.5);
  assert.ok(vec(g, i).z < 0.12, `spike smoothed (z=${vec(g, i).z.toFixed(4)})`);
});

test('grab stroke pulls the pinched region with falloff', () => {
  const g = createPrimitiveGeometry('sphere');
  const c = new THREE.Vector3(0.11, 0, 0);
  const i = nearestIndex(g, c);
  const edge = nearestIndex(g, new THREE.Vector3(0.105, 0.03, 0));
  const start = [vec(g, i), vec(g, edge)];
  const s = new GrabStroke(g, c, 0.04);
  assert.ok(!s.empty);
  s.update(new THREE.Vector3(0.05, 0, 0));
  assert.ok(vec(g, i).x - start[0].x > 0.045, 'center follows the hand');
  const edgeMove = vec(g, edge).x - start[1].x;
  assert.ok(edgeMove > 0 && edgeMove < 0.045, 'edge follows partially');
});

test('mirrored grab moves the opposite side symmetrically', () => {
  const g = createPrimitiveGeometry('sphere');
  const c = new THREE.Vector3(0.11, 0, 0);
  const right = nearestIndex(g, c);
  const left = nearestIndex(g, new THREE.Vector3(-0.11, 0, 0));
  const s = new GrabStroke(g, c, 0.04, true);
  s.update(new THREE.Vector3(0.03, 0.01, 0));
  assert.ok(Math.abs(vec(g, right).x + vec(g, left).x) < 1e-3, 'x mirrored');
  assert.ok(Math.abs(vec(g, right).y - vec(g, left).y) < 1e-3, 'y matches');
});

test('nearestVertexDistance reports surface proximity', () => {
  const g = createPrimitiveGeometry('cube');
  assert.ok(nearestVertexDistance(g, new THREE.Vector3(0, 0.12, 0)) < 0.021);
  assert.ok(nearestVertexDistance(g, new THREE.Vector3(0, 0.3, 0)) > 0.19);
});

test('geometry undo/redo restores sculpt strokes', () => {
  const mesh = new THREE.Mesh(createPrimitiveGeometry('sphere'));
  const h = new History();
  const before = captureGeometry(mesh);
  pushBrush(mesh.geometry, new THREE.Vector3(0, 0.115, 0), 0.03, 1);
  h.push(geometryEntry(mesh, before));
  const after = captureGeometry(mesh);
  h.undo();
  assert.deepEqual(captureGeometry(mesh), before);
  h.redo();
  assert.deepEqual(captureGeometry(mesh), after);
});
