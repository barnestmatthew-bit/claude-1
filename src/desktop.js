// Mouse + keyboard front end, for working without a headset and for testing.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { PRIMITIVES } from './primitives.js';
import { GrabStroke, finishEdit } from './sculpt.js';
import { COLORS, BRUSH_SIZES, TOOLS, WORK_CENTER, captureTransform } from './app.js';

const cap = (s) => s[0].toUpperCase() + s.slice(1);

export class DesktopControls {
  constructor(app, toolbar) {
    this.app = app;
    const { camera, renderer, scene } = app;
    const dom = renderer.domElement;

    this.orbit = new OrbitControls(camera, dom);
    this.orbit.target.copy(WORK_CENTER);
    this.orbit.enableDamping = true;
    this.orbit.update();

    this.gizmo = new TransformControls(camera, dom);
    this.gizmo.setSize(0.8);
    scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      const obj = this.gizmo.object;
      if (!obj) return;
      if (e.value) this.gizmoBefore = captureTransform(obj);
      else if (this.gizmoBefore) app.commitTransform(obj, this.gizmoBefore);
    });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.stroke = null;

    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('keydown', (e) => this.onKey(e));

    this.toolbar = toolbar;
    this.buildToolbar();
    app.onChange(() => this.sync());
    this.sync();
  }

  // --- toolbar -------------------------------------------------------------

  buildToolbar() {
    const a = this.app;
    const st = a.state;
    this.controls = [];
    const group = (title) => {
      const g = document.createElement('div');
      g.className = 'group';
      if (title) {
        const t = document.createElement('span');
        t.className = 'title';
        t.textContent = title;
        g.appendChild(t);
      }
      this.toolbar.appendChild(g);
      return g;
    };
    const button = (g, label, onClick, isActive, opts = {}) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (opts.title) b.title = opts.title;
      if (opts.color) { b.className = 'swatch'; b.style.background = opts.color; b.textContent = ''; b.ariaLabel = label; }
      b.addEventListener('click', onClick);
      g.appendChild(b);
      this.controls.push({ b, isActive });
    };

    const add = group('Add');
    for (const type of PRIMITIVES) {
      button(add, cap(type), () => {
        const p = WORK_CENTER.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.3, 0, (Math.random() - 0.5) * 0.15));
        a.spawn(type, p);
      });
    }

    const mode = group('Mode');
    button(mode, 'Build', () => a.set('mode', 'build'), () => st.mode === 'build', { title: 'Tab' });
    button(mode, 'Sculpt', () => a.set('mode', 'sculpt'), () => st.mode === 'sculpt', { title: 'Tab' });

    const tools = group('Tool');
    TOOLS.forEach((tool, i) => button(tools, cap(tool), () => { a.set('tool', tool); a.set('mode', 'sculpt'); },
      () => st.mode === 'sculpt' && st.tool === tool, { title: `${i + 1} — Shift+drag to grab/pull` }));

    const size = group('Brush');
    for (const s of Object.keys(BRUSH_SIZES)) button(size, s, () => a.set('brush', s), () => st.brush === s, { title: '[ / ]' });
    button(size, 'Mirror X', () => a.set('mirror', !st.mirror), () => st.mirror);
    button(size, 'Snap', () => a.set('snap', !st.snap), () => st.snap);

    const color = group('Color');
    for (const c of COLORS) button(color, c, () => a.setColor(c), () => st.color === c, { color: c });

    const edit = group();
    button(edit, 'Undo', () => a.undo(), null, { title: 'Ctrl+Z' });
    button(edit, 'Redo', () => a.redo(), null, { title: 'Ctrl+Shift+Z' });
    button(edit, 'Copy', () => a.duplicate(), null, { title: 'D' });
    button(edit, 'Delete', () => a.remove(), null, { title: 'Del' });
    button(edit, 'Clear', () => a.clear());
    button(edit, 'Export to Blender', () => a.export(), null, { title: 'Ctrl+S' });
  }

  sync() {
    for (const { b, isActive } of this.controls) b.classList.toggle('active', !!isActive?.());
    const { selected, state } = this.app;
    if (selected && state.mode === 'build') this.gizmo.attach(selected);
    else this.gizmo.detach();
  }

  // --- pointer -------------------------------------------------------------

  hit(e) {
    const r = this.app.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.app.camera);
    return this.raycaster.intersectObjects(this.app.objects(), false)[0] || null;
  }

  onDown(e) {
    if (e.button !== 0 || this.gizmo.dragging || this.gizmo.axis) return;
    this.downAt = [e.clientX, e.clientY];
    const { app } = this;
    const hit = this.hit(e);
    if (app.state.mode !== 'sculpt' || !hit) return;

    const mesh = hit.object;
    app.select(mesh);
    this.orbit.enabled = false;
    const close = app.beginGeometryEdit(mesh);
    if (e.shiftKey) {
      const local = mesh.worldToLocal(hit.point.clone());
      const scale = Math.max(...mesh.scale.toArray());
      const normal = app.camera.getWorldDirection(new THREE.Vector3()).negate();
      this.stroke = {
        kind: 'grab', mesh, close, start: local,
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point),
        grab: new GrabStroke(mesh.geometry, local, (app.brushRadius * 1.8) / scale, app.state.mirror),
      };
    } else {
      this.stroke = { kind: 'touch', mesh, close };
      this.applyTouch(hit);
    }
  }

  onMove(e) {
    const s = this.stroke;
    if (!s) return;
    if (s.kind === 'grab') {
      const r = this.app.renderer.domElement.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(this.pointer, this.app.camera);
      const p = this.raycaster.ray.intersectPlane(s.plane, new THREE.Vector3());
      if (!p) return;
      s.grab.update(s.mesh.worldToLocal(p).sub(s.start));
      finishEdit(s.mesh.geometry, { bounds: true });
    } else {
      const hit = this.hit(e);
      if (hit && hit.object === s.mesh) this.applyTouch(hit);
    }
  }

  applyTouch(hit) {
    const { app } = this;
    let point = hit.point;
    if (app.state.tool === 'push') {
      // Imagine a fingertip resting just above the surface and pressing in.
      const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
      point = hit.point.clone().addScaledVector(n, app.brushRadius * 0.6);
    }
    app.touchBrush(hit.object, point, 1 / 60);
    hit.object.geometry.computeBoundingSphere();
  }

  onUp(e) {
    const { app } = this;
    if (this.stroke) {
      this.stroke.close(true);
      this.stroke = null;
      this.orbit.enabled = true;
      return;
    }
    if (!this.downAt || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]);
    this.downAt = null;
    if (moved > 4 || this.gizmo.dragging) return;
    if (app.state.mode === 'build') app.select(this.hit(e)?.object || null);
  }

  onKey(e) {
    if (e.target instanceof HTMLInputElement) return;
    const a = this.app;
    const mod = e.ctrlKey || e.metaKey;
    const sizes = Object.keys(BRUSH_SIZES);
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.shiftKey ? a.redo() : a.undo(); e.preventDefault(); }
    else if (mod && k === 'y') { a.redo(); e.preventDefault(); }
    else if (mod && k === 's') { a.export(); e.preventDefault(); }
    else if (mod) return;
    else if (k === 'tab') { a.set('mode', a.state.mode === 'build' ? 'sculpt' : 'build'); e.preventDefault(); }
    else if (k === 'delete' || k === 'backspace') a.remove();
    else if (k === 'd') a.duplicate();
    else if (k === 'w') this.gizmo.setMode('translate');
    else if (k === 'e') this.gizmo.setMode('rotate');
    else if (k === 'r') this.gizmo.setMode('scale');
    else if (k >= '1' && k <= String(TOOLS.length)) { a.set('tool', TOOLS[+k - 1]); a.set('mode', 'sculpt'); }
    else if (k === '[' || k === ']') {
      const i = THREE.MathUtils.clamp(sizes.indexOf(a.state.brush) + (k === ']' ? 1 : -1), 0, sizes.length - 1);
      a.set('brush', sizes[i]);
    }
  }

  setEnabled(on) {
    this.orbit.enabled = on;
    this.gizmo.getHelper().visible = on;
    this.toolbar.style.display = on ? '' : 'none';
  }

  update() {
    this.orbit.update();
  }
}
