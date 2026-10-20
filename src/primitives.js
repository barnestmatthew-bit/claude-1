// Sculptable primitive geometry.
//
// Every primitive is built as a closed, indexed, evenly subdivided mesh with
// welded seams, so brushes can deform it without tearing and Blender receives
// clean manifold geometry. Sizes are in meters (roughly hand-sized).
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const PRIMITIVES = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'capsule'];

// Lathe a 2D profile (x = radius, y = height) around the Y axis.
function lathe(profile, radial) {
  return new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), radial);
}

// Points along a straight segment, excluding the start point.
function segment(from, to, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]);
  }
  return pts;
}

function rawGeometry(type) {
  switch (type) {
    case 'cube':
      return new THREE.BoxGeometry(0.2, 0.2, 0.2, 36, 36, 36);
    case 'sphere':
      return new THREE.IcosahedronGeometry(0.11, 32);
    case 'cylinder': {
      const r = 0.08, h = 0.2;
      const p = [[0, -h / 2]];
      p.push(...segment([0, -h / 2], [r, -h / 2], 14));
      p.push(...segment([r, -h / 2], [r, h / 2], 36));
      p.push(...segment([r, h / 2], [0, h / 2], 14));
      return lathe(p, 96);
    }
    case 'cone': {
      const r = 0.1, h = 0.22;
      const p = [[0, -h / 2]];
      p.push(...segment([0, -h / 2], [r, -h / 2], 16));
      p.push(...segment([r, -h / 2], [0, h / 2], 44));
      return lathe(p, 96);
    }
    case 'torus':
      return new THREE.TorusGeometry(0.09, 0.04, 40, 112);
    case 'capsule': {
      const r = 0.06, half = 0.06;
      const p = [];
      const arc = 20;
      for (let i = 0; i <= arc; i++) {
        const a = -Math.PI / 2 + (i / arc) * (Math.PI / 2);
        p.push([Math.cos(a) * r, -half + Math.sin(a) * r]);
      }
      p.push(...segment([r, -half], [r, half], 18));
      for (let i = 1; i <= arc; i++) {
        const a = (i / arc) * (Math.PI / 2);
        p.push([Math.cos(a) * r, half + Math.sin(a) * r]);
      }
      p[0][0] = 0;
      p[p.length - 1][0] = 0;
      return lathe(p, 96);
    }
    default:
      throw new Error(`Unknown primitive: ${type}`);
  }
}

// Strip seams/UVs and weld coincident vertices into one indexed mesh.
export function makeSculptable(geometry) {
  let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name);
  }
  g = mergeVertices(g, 1e-5);
  g = removeDegenerateTriangles(g);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// Welding a lathe's pole collapses some triangles to lines; drop them.
function removeDegenerateTriangles(g) {
  const idx = g.index.array;
  const keep = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2];
    if (a !== b && b !== c && a !== c) keep.push(a, b, c);
  }
  g.setIndex(keep);
  return g;
}

export function createPrimitiveGeometry(type) {
  return makeSculptable(rawGeometry(type));
}

// A light, low-poly version used for the shelf icons.
export function createIconGeometry(type) {
  switch (type) {
    case 'cube': return new THREE.BoxGeometry(0.2, 0.2, 0.2);
    case 'sphere': return new THREE.IcosahedronGeometry(0.11, 3);
    case 'cylinder': return new THREE.CylinderGeometry(0.08, 0.08, 0.2, 24);
    case 'cone': return new THREE.ConeGeometry(0.1, 0.22, 24);
    case 'torus': return new THREE.TorusGeometry(0.09, 0.04, 12, 32);
    case 'capsule': return new THREE.CapsuleGeometry(0.06, 0.12, 6, 16);
    default: throw new Error(`Unknown primitive: ${type}`);
  }
}
