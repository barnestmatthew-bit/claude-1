// Scene, shared state and editing actions used by both the VR (hand
// tracking) front end and the desktop (mouse) front end.
import * as THREE from 'three';
import { PRIMITIVES, createPrimitiveGeometry, createIconGeometry } from './primitives.js';
import {
  pushBrush, inflateBrush, smoothBrush, buildAdjacency, finishEdit, mirrorX,
} from './sculpt.js';
import {
  History, captureTransform, transformEntry, captureGeometry, geometryEntry,
  addEntry, removeEntry, groupEntry,
} from './history.js';
import { exportGLB, deliver } from './exporter.js';

export const COLORS = ['#d8a27c', '#ece9e2', '#5b8def', '#e5604d', '#62c07f'];
export const BRUSH_SIZES = { S: 0.01, M: 0.018, L: 0.03, XL: 0.05 };
export const TOOLS = ['push', 'inflate', 'smooth', 'carve'];

const TABLE_HEIGHT = 0.85;
export const WORK_CENTER = new THREE.Vector3(0, TABLE_HEIGHT + 0.25, -0.5);
const TRASH_POS = new THREE.Vector3(0.62, 0, -0.35);
const TRASH_HEIGHT = 0.7;
const TRASH_RADIUS = 0.13;

const baseGeometry = new Map();
function geometryFor(type) {
  if (!baseGeometry.has(type)) baseGeometry.set(type, createPrimitiveGeometry(type));
  return baseGeometry.get(type).clone();
}

const titleCase = (s) => s[0].toUpperCase() + s.slice(1);

export class App {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1c1f26);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 50);
    this.camera.position.set(0, 1.45, 0.35);

    this.state = {
      mode: 'build',      // 'build' | 'sculpt'
      tool: 'push',       // touch tool in sculpt mode
      brush: 'M',
      snap: false,
      mirror: false,
      allFingers: false,  // sculpt with every fingertip, not just the index
      color: COLORS[0],
    };
    this.listeners = new Set();
    this.history = new History(() => this.changed());
    this.selected = null;
    this.toast = (msg) => console.info(msg);

    this.buildEnvironment();

    this.workspace = new THREE.Group();
    this.workspace.name = 'HandSculpt';
    this.scene.add(this.workspace);

    this.selectionBox = new THREE.BoxHelper(undefined, 0x9fb4ff);
    this.selectionBox.visible = false;
    this.scene.add(this.selectionBox);

    this.mirrorPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.mirrorPlane.visible = false;
    this.scene.add(this.mirrorPlane);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    // A starter lump of clay on the table.
    this.spawn('sphere', WORK_CENTER.clone(), { record: false });
  }

  buildEnvironment() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a3226, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1.5, 3, 1);
    s.add(key);
    const rim = new THREE.DirectionalLight(0x9fb4ff, 0.8);
    rim.position.set(-2, 2, -2);
    s.add(rim);

    const grid = new THREE.GridHelper(10, 40, 0x3a4050, 0x2a2e38);
    s.add(grid);

    const table = new THREE.Mesh(
      new THREE.BoxGeometry(1.0, 0.04, 0.55),
      new THREE.MeshStandardMaterial({ color: 0x3b3f4a, roughness: 0.8 }),
    );
    table.position.set(0, TABLE_HEIGHT - 0.02, -0.55);
    s.add(table);
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.06, TABLE_HEIGHT - 0.04, 16),
      table.material,
    );
    leg.position.set(0, (TABLE_HEIGHT - 0.04) / 2, -0.55);
    s.add(leg);

    // Shelf of primitives to pinch-and-drag from.
    this.shelf = [];
    const iconMat = new THREE.MeshStandardMaterial({ color: 0xb9c3d9, roughness: 0.4 });
    PRIMITIVES.forEach((type, i) => {
      const icon = new THREE.Mesh(createIconGeometry(type), iconMat);
      icon.scale.setScalar(0.4);
      const x = (i - (PRIMITIVES.length - 1) / 2) * 0.13;
      icon.position.set(x, TABLE_HEIGHT + 0.06, -0.73);
      icon.userData.primitive = type;
      s.add(icon);
      this.shelf.push(icon);
    });

    // Drop objects here to delete them.
    const trash = new THREE.Mesh(
      new THREE.CylinderGeometry(TRASH_RADIUS, TRASH_RADIUS * 0.8, TRASH_HEIGHT, 32, 1, true),
      new THREE.MeshStandardMaterial({ color: 0xc0504d, roughness: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }),
    );
    trash.position.copy(TRASH_POS).setY(TRASH_HEIGHT / 2);
    s.add(trash);
    this.trash = trash;
  }

  // --- state -------------------------------------------------------------

  onChange(fn) {
    this.listeners.add(fn);
  }

  changed() {
    for (const fn of this.listeners) fn();
  }

  set(key, value) {
    this.state[key] = value;
    this.changed();
  }

  get brushRadius() {
    return BRUSH_SIZES[this.state.brush];
  }

  statusText() {
    const { mode, tool, brush, mirror, snap } = this.state;
    const extras = [
      mode === 'sculpt' && mirror ? 'mirror X' : null,
      mode === 'sculpt' && this.state.allFingers ? '5 fingers' : null,
      mode === 'build' && snap ? 'snap' : null,
    ]
      .filter(Boolean).join(' · ');
    const main = mode === 'sculpt' ? `Sculpt · ${titleCase(tool)} · ${brush}` : 'Build';
    return extras ? `${main} · ${extras}` : main;
  }

  objects() {
    return this.workspace.children.filter((o) => o.isMesh);
  }

  select(obj) {
    this.selected = obj;
    this.changed();
  }

  // --- objects -------------------------------------------------------------

  createObject(type, color = this.state.color) {
    const mesh = new THREE.Mesh(
      geometryFor(type),
      new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0 }),
    );
    // Sculpting can push vertices outside the cached bounds; never cull.
    mesh.frustumCulled = false;
    const n = this.objects().filter((o) => o.userData.primitive === type).length;
    mesh.name = n ? `${titleCase(type)}.${String(n).padStart(3, '0')}` : titleCase(type);
    mesh.userData.primitive = type;
    mesh.material.name = mesh.name;
    return mesh;
  }

  spawn(type, position, { record = true } = {}) {
    const mesh = this.createObject(type);
    mesh.position.copy(position);
    this.workspace.add(mesh);
    if (record) this.history.push(addEntry(this.workspace, mesh, () => this.validateSelection()));
    this.select(mesh);
    return mesh;
  }

  duplicate(obj = this.selected) {
    if (!obj) return null;
    const copy = obj.clone();
    copy.geometry = obj.geometry.clone();
    copy.material = obj.material.clone();
    copy.name = `${obj.name}-copy`;
    copy.material.name = copy.name;
    copy.userData = { primitive: obj.userData.primitive };
    copy.position.x += 0.06 * Math.max(...obj.scale.toArray());
    this.workspace.add(copy);
    this.history.push(addEntry(this.workspace, copy, () => this.validateSelection()));
    this.select(copy);
    return copy;
  }

  remove(obj = this.selected) {
    if (!obj || obj.parent !== this.workspace) return;
    this.workspace.remove(obj);
    this.history.push(removeEntry(this.workspace, obj, () => this.validateSelection()));
    this.validateSelection();
  }

  clear() {
    const objs = this.objects();
    if (!objs.length) return;
    const entries = objs.map((o) => {
      this.workspace.remove(o);
      return removeEntry(this.workspace, o, () => this.validateSelection());
    });
    this.history.push(groupEntry(entries));
    this.validateSelection();
    this.toast('Cleared (Undo to restore)');
  }

  setColor(color) {
    this.set('color', color);
    const obj = this.selected;
    if (!obj) return;
    const before = obj.material.color.clone();
    const after = new THREE.Color(color);
    obj.material.color.copy(after);
    this.history.push({
      undo: () => obj.material.color.copy(before),
      redo: () => obj.material.color.copy(after),
    });
  }

  validateSelection() {
    if (this.selected && this.selected.parent !== this.workspace) this.select(null);
    else this.changed();
  }

  undo() {
    if (!this.history.undo()) this.toast('Nothing to undo');
  }

  redo() {
    if (!this.history.redo()) this.toast('Nothing to redo');
  }

  // Record a transform edit started earlier with captureTransform().
  commitTransform(obj, before) {
    if (this.state.snap) snapTransform(obj);
    if (this.isOverTrash(obj)) {
      obj.position.copy(before.position);
      obj.quaternion.copy(before.quaternion);
      obj.scale.copy(before.scale);
      this.remove(obj);
      this.toast(`Deleted ${obj.name}`);
      return;
    }
    this.history.push(transformEntry(obj, before));
  }

  // Record a piece pulled from the shelf once it has been placed.
  commitSpawn(obj) {
    if (this.state.snap) snapTransform(obj);
    this.history.push(addEntry(this.workspace, obj, () => this.validateSelection()));
  }

  isOverTrash(obj) {
    const p = obj.getWorldPosition(new THREE.Vector3());
    const dx = p.x - TRASH_POS.x, dz = p.z - TRASH_POS.z;
    return Math.hypot(dx, dz) < TRASH_RADIUS && p.y < TRASH_HEIGHT + 0.08;
  }

  // Nearest object whose bounding box (expanded by margin) contains p.
  pick(p, margin = 0.02) {
    let best = null, bestD = Infinity;
    const local = new THREE.Vector3();
    for (const o of this.objects()) {
      local.copy(p);
      o.worldToLocal(local);
      const box = o.geometry.boundingBox;
      const scale = Math.max(...o.scale.toArray());
      const m = margin / scale;
      const expanded = box.clone().expandByScalar(m);
      if (!expanded.containsPoint(local)) continue;
      const d = box.distanceToPoint(local) * scale;
      const c = box.getCenter(new THREE.Vector3()).distanceTo(local) * scale;
      const score = d + c * 0.01; // prefer the box you're inside, then the nearest center
      if (score < bestD) { bestD = score; best = o; }
    }
    return best;
  }

  // --- sculpting -----------------------------------------------------------

  // Snapshot a mesh before sculpting it. The returned closer finalizes the
  // stroke and records it for undo (pass false if nothing actually changed).
  beginGeometryEdit(mesh) {
    const before = captureGeometry(mesh);
    return (changed = true) => {
      if (!changed) return;
      finishEdit(mesh.geometry, { bounds: true });
      this.history.push(geometryEntry(mesh, before));
    };
  }

  adjacency(mesh) {
    if (!mesh.userData.adjacency || mesh.userData.adjacencyFor !== mesh.geometry) {
      mesh.userData.adjacency = buildAdjacency(mesh.geometry);
      mesh.userData.adjacencyFor = mesh.geometry;
    }
    return mesh.userData.adjacency;
  }

  // Apply the current touch tool at a world-space point. Returns true when
  // the mesh changed. `dt` keeps strength frame-rate independent.
  touchBrush(mesh, worldPoint, dt, tool = this.state.tool) {
    const scale = Math.max(...mesh.scale.toArray());
    const radius = this.brushRadius / scale;
    const local = mesh.worldToLocal(worldPoint.clone());

    const sphere = mesh.geometry.boundingSphere;
    if (local.distanceTo(sphere.center) > sphere.radius + radius) return false;

    const points = [local];
    if (this.state.mirror && Math.abs(local.x) > radius * 0.25) points.push(mirrorX(local));

    const frameK = Math.min(1, dt * 72);
    let changed = false;
    for (const p of points) {
      switch (tool) {
        case 'push':
          changed = pushBrush(mesh.geometry, p, radius, 0.5 * frameK) || changed;
          break;
        case 'inflate':
          changed = inflateBrush(mesh.geometry, p, radius * 1.4, (0.03 * dt) / scale) || changed;
          break;
        case 'carve':
          changed = inflateBrush(mesh.geometry, p, radius * 1.4, (-0.03 * dt) / scale) || changed;
          break;
        case 'smooth':
          changed = smoothBrush(mesh.geometry, this.adjacency(mesh), p, radius * 1.5, 0.5 * frameK) || changed;
          break;
      }
    }
    if (changed) finishEdit(mesh.geometry);
    return changed;
  }

  // --- export ----------------------------------------------------------------

  async export() {
    if (!this.objects().length) {
      this.toast('Nothing to export');
      return;
    }
    this.toast('Exporting…');
    // Export with the tabletop as the origin, so models sit on Blender's floor.
    // Clones share geometry and materials, so this is cheap.
    const root = new THREE.Group();
    root.name = 'HandSculpt';
    root.position.set(0, -TABLE_HEIGHT, -WORK_CENTER.z);
    for (const o of this.objects()) root.add(o.clone());
    try {
      const buffer = await exportGLB(root);
      const result = await deliver(buffer);
      this.toast(result.via === 'server' ? `Sent to Blender: ${result.filename}` : `Downloaded ${result.filename}`);
    } catch (err) {
      console.error(err);
      this.toast(`Export failed: ${err.message}`);
    }
  }

  // --- per frame -------------------------------------------------------------

  updateHelpers(time) {
    for (const icon of this.shelf) icon.rotation.y = time * 0.5;

    const sel = this.selected;
    this.selectionBox.visible = !!sel;
    if (sel) this.selectionBox.setFromObject(sel);

    const showMirror = !!sel && this.state.mode === 'sculpt' && this.state.mirror;
    this.mirrorPlane.visible = showMirror;
    if (showMirror) {
      const box = sel.geometry.boundingBox;
      const size = box.getSize(new THREE.Vector3());
      this.mirrorPlane.position.set(0, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
      this.mirrorPlane.position.applyMatrix4(sel.matrixWorld);
      this.mirrorPlane.quaternion.copy(sel.getWorldQuaternion(new THREE.Quaternion()))
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
      const s = sel.getWorldScale(new THREE.Vector3());
      this.mirrorPlane.scale.set(size.z * s.z * 1.3, size.y * s.y * 1.3, 1);
    }
  }
}

function snapTransform(obj) {
  const step = 0.01;
  obj.position.set(
    Math.round(obj.position.x / step) * step,
    Math.round(obj.position.y / step) * step,
    Math.round(obj.position.z / step) * step,
  );
  const e = new THREE.Euler().setFromQuaternion(obj.quaternion);
  const a = THREE.MathUtils.degToRad(15);
  e.set(Math.round(e.x / a) * a, Math.round(e.y / a) * a, Math.round(e.z / a) * a);
  obj.quaternion.setFromEuler(e);
}

export { captureTransform };
