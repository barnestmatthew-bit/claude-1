// In-VR UI: a palm-up wrist menu with pokeable buttons, plus a floating toast.
import * as THREE from 'three';

const PX_PER_M = 2400; // canvas resolution for labels

// A flat, canvas-textured rectangle used for buttons and text.
class CanvasPanel {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = Math.round(width * PX_PER_M);
    this.canvas.height = Math.round(height * PX_PER_M);
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false }),
    );
  }

  draw({ text, bg = '#2b2f3a', fg = '#f2f4f8', border = null, swatch = null, font = 0.45, align = 'center' }) {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height, r = Math.min(w, h) * 0.22;
    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.roundRect(2, 2, w - 4, h - 4, r);
    ctx.fillStyle = bg;
    ctx.fill();
    if (border) {
      ctx.lineWidth = Math.max(3, h * 0.07);
      ctx.strokeStyle = border;
      ctx.stroke();
    }
    if (swatch) {
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, h * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = swatch;
      ctx.fill();
    }
    if (text) {
      ctx.fillStyle = fg;
      let size = Math.round(h * font);
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      while (size > 8 && ctx.measureText(text).width > w * 0.9) {
        size -= 2;
        ctx.font = `600 ${size}px system-ui, sans-serif`;
      }
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, align === 'left' ? h * 0.35 : w / 2, h / 2 + 1);
    }
    this.texture.needsUpdate = true;
  }
}

class Button extends CanvasPanel {
  constructor({ label, onPress, isActive = () => false, swatch = null }) {
    super(0.052, 0.03);
    this.label = label;
    this.onPress = onPress;
    this.isActive = isActive;
    this.swatch = swatch;
    this.hover = false;
    this.armed = true;
    this._last = null;
    this.refresh();
  }

  refresh() {
    const active = this.isActive();
    const key = `${active}|${this.hover}`;
    if (key === this._last) return;
    this._last = key;
    this.draw({
      text: this.swatch ? null : this.label,
      swatch: this.swatch,
      bg: active ? '#4f7cff' : this.hover ? '#3d4352' : '#262a33',
      border: active && this.swatch ? '#ffffff' : this.hover ? '#9fb4ff' : null,
    });
  }
}

export class WristMenu {
  // rows: array of arrays of button specs ({label, onPress, isActive, swatch})
  constructor(rows, statusText) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.buttons = [];
    this.statusText = statusText;

    const cols = Math.max(...rows.map((r) => r.length));
    const gapX = 0.058, gapY = 0.036;
    const width = cols * gapX + 0.01;
    const height = (rows.length + 1) * gapY + 0.01;

    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color: 0x14161c, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    back.position.z = -0.002;
    back.renderOrder = 1; // always behind the buttons, whatever the viewing angle
    this.group.add(back);

    this.status = new CanvasPanel(width - 0.012, 0.028);
    this.status.mesh.position.set(0, height / 2 - gapY / 2 - 0.004, 0);
    this.status.mesh.renderOrder = 2;
    this.group.add(this.status.mesh);
    this._statusLast = '';

    rows.forEach((row, r) => {
      row.forEach((spec, c) => {
        const b = new Button(spec);
        b.mesh.renderOrder = 2;
        b.mesh.position.set(
          (c - (row.length - 1) / 2) * gapX,
          height / 2 - gapY * (r + 1.5) - 0.004,
          0,
        );
        this.group.add(b.mesh);
        this.buttons.push(b);
      });
    });

    this._local = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._toHead = new THREE.Vector3();
    this.cooldown = 0;
  }

  refresh() {
    for (const b of this.buttons) {
      b._last = null;
      b.refresh();
    }
  }

  // Follow the palm while it faces the head; buttons are poked with the
  // other hand's index fingertip.
  update(menuHand, pokeHand, camera, dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const head = camera.getWorldPosition(this._toHead.clone());

    let show = false;
    if (menuHand?.tracked) {
      this._toHead.copy(head).sub(menuHand.palm).normalize();
      show = menuHand.palmNormal.dot(this._toHead) > 0.45;
    }
    if (!show) {
      this.group.visible = false;
      return false;
    }

    this._target.copy(menuHand.palm).addScaledVector(menuHand.palmNormal, 0.09);
    if (!this.group.visible) this.group.position.copy(this._target);
    else this.group.position.lerp(this._target, Math.min(1, dt * 18));
    this.group.lookAt(head);
    this.group.visible = true;
    this.group.updateMatrixWorld(true);

    const status = this.statusText();
    if (status !== this._statusLast) {
      this._statusLast = status;
      this.status.draw({ text: status, bg: 'rgba(0,0,0,0)', fg: '#c9d3ea', font: 0.55 });
    }

    let consumed = false;
    for (const b of this.buttons) {
      let inside = false;
      let touching = false;
      if (pokeHand?.tracked) {
        this._local.copy(pokeHand.indexTip);
        b.mesh.worldToLocal(this._local);
        inside = Math.abs(this._local.x) < b.width / 2 && Math.abs(this._local.y) < b.height / 2;
        touching = inside && this._local.z < 0.008 && this._local.z > -0.03;
        if (inside && this._local.z < 0.04) consumed = true;
      }
      b.hover = inside && this._local.z < 0.04;
      if (touching && b.armed && this.cooldown === 0) {
        b.armed = false;
        this.cooldown = 0.25;
        b.onPress();
        this.refresh();
      }
      if (!inside || this._local.z > 0.02) b.armed = true;
      b.refresh();
    }
    return consumed; // true while the poking finger is at the menu
  }
}

// Short messages that float in front of the user.
export class Toast {
  constructor() {
    this.panel = new CanvasPanel(0.36, 0.05);
    this.panel.mesh.visible = false;
    this.panel.mesh.renderOrder = 10;
    this.time = 0;
    this._v = new THREE.Vector3();
  }

  get mesh() {
    return this.panel.mesh;
  }

  show(text) {
    this.panel.draw({ text, bg: 'rgba(20,22,28,0.9)', font: 0.42 });
    this.time = 2.5;
    this.panel.mesh.visible = true;
  }

  update(camera, dt) {
    if (this.time <= 0) return;
    this.time -= dt;
    if (this.time <= 0) {
      this.panel.mesh.visible = false;
      return;
    }
    // 0.6m ahead, slightly below eye level.
    camera.getWorldDirection(this._v);
    const head = camera.getWorldPosition(new THREE.Vector3());
    this.panel.mesh.position.copy(head).addScaledVector(this._v, 0.6).add(new THREE.Vector3(0, -0.12, 0));
    this.panel.mesh.lookAt(head);
  }
}
