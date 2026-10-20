// Hand-tracking state: turns raw WebXR joint poses into gestures
// (pinch, fist grab, fingertip poke, palm direction).
import * as THREE from 'three';

const PINCH_ON = 0.018;   // meters between thumb and index tips
const PINCH_OFF = 0.032;  // hysteresis so a pinch doesn't flicker
const CURL_RATIO = 1.3;   // tip-to-wrist vs knuckle-to-wrist below this = curled

const FINGERS = ['index', 'middle', 'ring', 'pinky'];
const TIP_JOINTS = ['thumb-tip', ...FINGERS.map((f) => `${f}-finger-tip`)];

export class TrackedHand {
  constructor(group) {
    this.group = group;          // from renderer.xr.getHand(i)
    this.handedness = null;      // 'left' | 'right'
    this.connected = false;
    this.tracked = false;

    this.indexTip = new THREE.Vector3();
    this.thumbTip = new THREE.Vector3();
    this.wrist = new THREE.Vector3();
    this.palm = new THREE.Vector3();
    this.pinchPoint = new THREE.Vector3();
    this.palmNormal = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.tipRadius = 0.009;

    this.pinching = false;
    this.pinchStarted = false;
    this.pinchEnded = false;
    this.fist = false;
    this.fistStarted = false;
    this.fistEnded = false;

    group.addEventListener('connected', (e) => {
      if (!e.data?.hand) return;
      this.handedness = e.data.handedness;
      this.connected = true;
    });
    group.addEventListener('disconnected', () => {
      this.connected = false;
      this.handedness = null;
    });

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
  }

  joint(name) {
    return this.group.joints?.[name];
  }

  jointPos(name, target) {
    const j = this.joint(name);
    return j ? j.getWorldPosition(target) : null;
  }

  update() {
    const wasPinching = this.pinching;
    const wasFist = this.fist;

    const tip = this.joint('index-finger-tip');
    const wrist = this.joint('wrist');
    this.tracked = this.connected && !!tip && !!wrist && tip.visible && wrist.visible;

    if (this.tracked) {
      this.jointPos('index-finger-tip', this.indexTip);
      this.jointPos('thumb-tip', this.thumbTip);
      this.jointPos('wrist', this.wrist);
      wrist.getWorldQuaternion(this.quaternion);
      this.tipRadius = tip.jointRadius || 0.009;

      this.pinchPoint.addVectors(this.indexTip, this.thumbTip).multiplyScalar(0.5);
      const pinchDist = this.indexTip.distanceTo(this.thumbTip);
      this.pinching = this.pinching ? pinchDist < PINCH_OFF : pinchDist < PINCH_ON;

      // Palm center and normal from the knuckles.
      const indexBase = this.jointPos('index-finger-phalanx-proximal', this._a);
      const pinkyBase = this.jointPos('pinky-finger-phalanx-proximal', this._b);
      const middleKnuckle = this.jointPos('middle-finger-phalanx-proximal', new THREE.Vector3());
      if (indexBase && pinkyBase && middleKnuckle) {
        this.palm.addVectors(this.wrist, middleKnuckle).multiplyScalar(0.5);
        indexBase.sub(this.wrist);
        pinkyBase.sub(this.wrist);
        if (this.handedness === 'left') this.palmNormal.crossVectors(indexBase, pinkyBase);
        else this.palmNormal.crossVectors(pinkyBase, indexBase);
        this.palmNormal.normalize();
      }

      this.fist = !this.pinching && this.curledFingerCount() >= 4;
    } else {
      this.pinching = false;
      this.fist = false;
    }

    this.pinchStarted = this.pinching && !wasPinching;
    this.pinchEnded = !this.pinching && wasPinching;
    this.fistStarted = this.fist && !wasFist;
    this.fistEnded = !this.fist && wasFist;
  }

  curledFingerCount() {
    let curled = 0;
    const t = new THREE.Vector3();
    const k = new THREE.Vector3();
    for (const f of FINGERS) {
      if (!this.jointPos(`${f}-finger-tip`, t) || !this.jointPos(`${f}-finger-phalanx-proximal`, k)) continue;
      const tipDist = t.distanceTo(this.wrist);
      const knuckleDist = k.distanceTo(this.wrist);
      if (knuckleDist > 0 && tipDist / knuckleDist < CURL_RATIO) curled++;
    }
    return curled;
  }

  // World positions of the fingertips used as sculpting tools.
  tips(allFingers) {
    if (!allFingers) return [this.indexTip];
    this._tips ||= TIP_JOINTS.map(() => new THREE.Vector3());
    TIP_JOINTS.forEach((name, i) => this.jointPos(name, this._tips[i]));
    return this._tips;
  }

  // World matrix of the hand's grab frame (position at `point`, wrist rotation).
  frame(point, target = new THREE.Matrix4()) {
    return target.compose(point, this.quaternion, new THREE.Vector3(1, 1, 1));
  }
}

export class HandSystem {
  constructor(renderer, scene) {
    this.hands = [0, 1].map((i) => {
      const group = renderer.xr.getHand(i);
      scene.add(group);
      return new TrackedHand(group);
    });
  }

  update() {
    for (const h of this.hands) h.update();
  }

  get left() {
    return this.hands.find((h) => h.handedness === 'left') || null;
  }

  get right() {
    return this.hands.find((h) => h.handedness === 'right') || null;
  }
}
