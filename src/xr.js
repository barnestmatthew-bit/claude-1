// Hand-tracked VR controls.
//
// Build mode
//   pinch a shelf shape ........ pull out a new piece and drop it anywhere
//   pinch a piece .............. move / rotate it with your hand
//   pinch it with both hands ... scale + rotate by pulling hands apart
//   drop it in the red bin ..... delete
// Sculpt mode
//   touch with a fingertip ..... current tool (push / inflate / smooth / carve)
//   pinch near the surface ..... grab clay and pull it
// Any mode
//   make a fist on a piece ..... grab and turn it
//   look at your left palm ..... wrist menu; poke buttons with right index
import * as THREE from 'three';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { HandSystem } from './hands.js';
import { WristMenu, Toast } from './ui.js';
import { GrabStroke, finishEdit, nearestVertexDistance } from './sculpt.js';
import { COLORS, BRUSH_SIZES, captureTransform } from './app.js';

const GRAB_RADIUS_FACTOR = 1.8; // pinch-grab pulls a wider area than a fingertip
const STROKE_IDLE = 0.35;       // seconds without change before a touch stroke ends

export class XRInteraction {
  constructor(app) {
    this.app = app;
    const { renderer, scene } = app;

    this.handSystem = new HandSystem(renderer, scene);
    const factory = new XRHandModelFactory();
    for (const h of this.handSystem.hands) {
      h.group.add(factory.createHandModel(h.group, 'mesh'));
      h.ix = { move: null, sculptGrab: null, touch: null };
    }

    this.menu = new WristMenu(this.menuRows(), () => app.statusText());
    scene.add(this.menu.group);
    app.onChange(() => this.menu.refresh());

    this.toast = new Toast();
    scene.add(this.toast.mesh);
    const log = app.toast;
    app.toast = (msg) => {
      log(msg);
      if (renderer.xr.isPresenting) this.toast.show(msg);
    };

    this.cursors = this.handSystem.hands.map(() => {
      const c = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0x9fb4ff, wireframe: true, transparent: true, opacity: 0.35 }),
      );
      c.visible = false;
      scene.add(c);
      return c;
    });

    this.twoHand = null;
  }

  menuRows() {
    const a = this.app;
    const st = a.state;
    return [
      [
        { label: 'Build', onPress: () => a.set('mode', 'build'), isActive: () => st.mode === 'build' },
        { label: 'Sculpt', onPress: () => a.set('mode', 'sculpt'), isActive: () => st.mode === 'sculpt' },
        { label: 'Snap', onPress: () => a.set('snap', !st.snap), isActive: () => st.snap },
        { label: 'Mirror', onPress: () => a.set('mirror', !st.mirror), isActive: () => st.mirror },
        { label: 'Export', onPress: () => a.export() },
      ],
      [
        ...['push', 'inflate', 'smooth', 'carve'].map((tool) => ({
          label: tool[0].toUpperCase() + tool.slice(1),
          onPress: () => { a.set('tool', tool); a.set('mode', 'sculpt'); },
          isActive: () => st.mode === 'sculpt' && st.tool === tool,
        })),
        { label: '5 Fing.', onPress: () => a.set('allFingers', !st.allFingers), isActive: () => st.allFingers },
      ],
      Object.keys(BRUSH_SIZES).map((size) => ({
        label: size, onPress: () => a.set('brush', size), isActive: () => st.brush === size,
      })),
      [
        { label: 'Undo', onPress: () => a.undo() },
        { label: 'Redo', onPress: () => a.redo() },
        { label: 'Copy', onPress: () => a.duplicate() },
        { label: 'Delete', onPress: () => a.remove() },
        { label: 'Clear', onPress: () => a.clear() },
      ],
      COLORS.map((color) => ({
        label: color, swatch: color, onPress: () => a.setColor(color), isActive: () => st.color === color,
      })),
    ];
  }

  update(dt) {
    const { app } = this;
    this.handSystem.update();
    const left = this.handSystem.left;
    const right = this.handSystem.right;

    const atMenu = this.menu.update(left, right, app.camera, dt);
    this.toast.update(app.camera, dt);

    this.handSystem.hands.forEach((h, i) => {
      const busyWithMenu = (atMenu && h === right) || (this.menu.group.visible && h === left);
      this.updateHand(h, dt, busyWithMenu);
      this.updateCursor(h, this.cursors[i]);
    });

    this.updateTwoHand();
  }

  updateHand(h, dt, busyWithMenu) {
    const { app } = this;
    const ix = h.ix;

    // Releases first, so a lost hand never leaves something stuck to it.
    if (ix.move && ((ix.move.by === 'pinch' && !h.pinching) || (ix.move.by === 'fist' && !h.fist))) {
      this.endMove(h);
    }
    if (ix.sculptGrab && !h.pinching) {
      ix.sculptGrab.close();
      ix.sculptGrab = null;
    }
    if (!h.tracked || busyWithMenu) {
      this.endTouch(h);
      return;
    }

    if (h.fistStarted && !ix.move) {
      const obj = app.pick(h.palm, 0.06);
      if (obj) this.startMove(h, obj, 'fist');
    }

    if (h.pinchStarted && !ix.move) {
      if (app.state.mode === 'build') this.pinchBuild(h);
      else this.pinchSculpt(h);
    }

    if (ix.move && !this.twoHand) {
      const point = ix.move.by === 'pinch' ? h.pinchPoint : h.palm;
      const m = h.frame(point).multiply(ix.move.offset);
      m.decompose(ix.move.obj.position, ix.move.obj.quaternion, ix.move.obj.scale);
    }

    if (ix.sculptGrab) {
      const { mesh, stroke, start } = ix.sculptGrab;
      const local = mesh.worldToLocal(h.pinchPoint.clone());
      stroke.update(local.sub(start));
      finishEdit(mesh.geometry);
    }

    if (app.state.mode === 'sculpt' && !h.pinching && !h.fist && !ix.move) this.touchSculpt(h, dt);
    else this.endTouch(h);
  }

  // --- moving pieces ---------------------------------------------------------

  pinchBuild(h) {
    const { app } = this;
    const icon = app.shelf.find((s) => s.getWorldPosition(new THREE.Vector3()).distanceTo(h.pinchPoint) < 0.055);
    if (icon) {
      const obj = app.spawn(icon.userData.primitive, h.pinchPoint, { record: false });
      obj.quaternion.identity();
      this.startMove(h, obj, 'pinch', { spawned: true });
      return;
    }
    const obj = app.pick(h.pinchPoint, 0.015);
    if (obj) this.startMove(h, obj, 'pinch');
  }

  startMove(h, obj, by, { spawned = false } = {}) {
    const { app } = this;
    app.select(obj);
    const other = this.handSystem.hands.find((o) => o !== h && o.ix.move?.obj === obj);
    obj.updateMatrixWorld();
    const point = by === 'pinch' ? h.pinchPoint : h.palm;
    h.ix.move = {
      obj, by, spawned,
      before: other ? other.ix.move.before : captureTransform(obj),
      offset: h.frame(point).invert().multiply(obj.matrixWorld),
    };
    if (other) {
      h.ix.move.spawned = other.ix.move.spawned;
      this.startTwoHand(obj, other, h);
    }
  }

  endMove(h) {
    const { app } = this;
    const move = h.ix.move;
    h.ix.move = null;
    const other = this.handSystem.hands.find((o) => o !== h && o.ix.move?.obj === move.obj);
    if (other) {
      // Keep holding with the remaining hand.
      this.twoHand = null;
      const point = other.ix.move.by === 'pinch' ? other.pinchPoint : other.palm;
      move.obj.updateMatrixWorld();
      other.ix.move.offset = other.frame(point).invert().multiply(move.obj.matrixWorld);
      return;
    }
    this.twoHand = null;
    if (move.spawned) {
      if (app.isOverTrash(move.obj)) {
        app.workspace.remove(move.obj);
        app.validateSelection();
        return;
      }
      app.commitSpawn(move.obj);
      return;
    }
    app.commitTransform(move.obj, move.before);
  }

  startTwoHand(obj, a, b) {
    const pa = a.ix.move.by === 'pinch' ? a.pinchPoint : a.palm;
    const pb = b.ix.move.by === 'pinch' ? b.pinchPoint : b.palm;
    this.twoHand = {
      obj, a, b,
      d0: Math.max(0.01, pa.distanceTo(pb)),
      m0: pa.clone().add(pb).multiplyScalar(0.5),
      v0: pb.clone().sub(pa).normalize(),
      p0: obj.position.clone(),
      q0: obj.quaternion.clone(),
      s0: obj.scale.clone(),
    };
  }

  updateTwoHand() {
    const t = this.twoHand;
    if (!t) return;
    const pa = t.a.ix.move.by === 'pinch' ? t.a.pinchPoint : t.a.palm;
    const pb = t.b.ix.move.by === 'pinch' ? t.b.pinchPoint : t.b.palm;
    const s = THREE.MathUtils.clamp(pa.distanceTo(pb) / t.d0, 0.05 / t.s0.x, 20 / t.s0.x);
    const m = pa.clone().add(pb).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(t.v0, pb.clone().sub(pa).normalize());
    t.obj.position.copy(t.p0).sub(t.m0).multiplyScalar(s).applyQuaternion(q).add(m);
    t.obj.quaternion.copy(q).multiply(t.q0);
    t.obj.scale.copy(t.s0).multiplyScalar(s);
  }

  // --- sculpting -------------------------------------------------------------

  pinchSculpt(h) {
    const { app } = this;
    let best = null, bestD = Infinity;
    for (const mesh of app.objects()) {
      const scale = Math.max(...mesh.scale.toArray());
      const local = mesh.worldToLocal(h.pinchPoint.clone());
      const d = nearestVertexDistance(mesh.geometry, local) * scale;
      if (d < bestD) { bestD = d; best = { mesh, local, scale }; }
    }
    if (!best || bestD > app.brushRadius * GRAB_RADIUS_FACTOR) return;
    const { mesh, local, scale } = best;
    const radius = (app.brushRadius * GRAB_RADIUS_FACTOR) / scale;
    app.select(mesh);
    h.ix.sculptGrab = {
      mesh,
      start: local,
      stroke: new GrabStroke(mesh.geometry, local, radius, app.state.mirror),
      close: app.beginGeometryEdit(mesh),
    };
  }

  touchSculpt(h, dt) {
    const { app } = this;
    const tips = h.tips(app.state.allFingers);
    const touch = h.ix.touch;
    let changedMesh = null;
    for (const mesh of app.objects()) {
      // Snapshot before the first change so undo restores the original.
      const near = tips.some((tip) => this.isNear(mesh, tip));
      if (!near) continue;
      if (!touch || touch.mesh !== mesh) {
        this.endTouch(h);
        h.ix.touch = { mesh, close: app.beginGeometryEdit(mesh), idle: 0, changed: false };
      }
      let changed = false;
      for (const tip of tips) changed = app.touchBrush(mesh, tip, dt) || changed;
      if (changed) changedMesh = mesh;
      break; // sculpt one piece at a time
    }
    const t = h.ix.touch;
    if (!t) return;
    if (changedMesh === t.mesh) {
      t.changed = true;
      t.idle = 0;
      app.selected !== t.mesh && app.select(t.mesh);
    } else if ((t.idle += dt) > STROKE_IDLE) {
      this.endTouch(h);
    }
  }

  isNear(mesh, worldPoint) {
    const local = mesh.worldToLocal(worldPoint.clone());
    const scale = Math.max(...mesh.scale.toArray());
    const sphere = mesh.geometry.boundingSphere;
    return local.distanceTo(sphere.center) < sphere.radius + (this.app.brushRadius * 1.5) / scale;
  }

  endTouch(h) {
    const t = h.ix.touch;
    if (!t) return;
    h.ix.touch = null;
    t.close(t.changed);
  }

  updateCursor(h, cursor) {
    const { app } = this;
    const sculpt = app.state.mode === 'sculpt' && h.tracked && !h.ix.move && !(this.menu.group.visible && h === this.handSystem.left);
    cursor.visible = sculpt;
    if (!sculpt) return;
    if (h.pinching || h.ix.sculptGrab) {
      cursor.position.copy(h.pinchPoint);
      cursor.scale.setScalar(app.brushRadius * GRAB_RADIUS_FACTOR);
      cursor.material.color.set(h.ix.sculptGrab ? 0xffc46b : 0x9fb4ff);
    } else {
      cursor.position.copy(h.indexTip);
      cursor.scale.setScalar(app.brushRadius);
      cursor.material.color.set(h.ix.touch?.changed ? 0xffc46b : 0x9fb4ff);
    }
  }
}
