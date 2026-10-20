import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { App } from './app.js';
import { XRInteraction } from './xr.js';
import { DesktopControls } from './desktop.js';

const app = new App(document.getElementById('viewport'));
const xr = new XRInteraction(app);
const desktop = new DesktopControls(app, document.getElementById('toolbar'));

const toastEl = document.getElementById('toast');
const showVR = app.toast;
app.toast = (msg) => {
  showVR(msg);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl.timer);
  toastEl.timer = setTimeout(() => toastEl.classList.remove('show'), 2500);
};

const sessionInit = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'] };
document.body.appendChild(VRButton.createButton(app.renderer, sessionInit));

app.renderer.xr.addEventListener('sessionstart', () => desktop.setEnabled(false));
app.renderer.xr.addEventListener('sessionend', () => desktop.setEnabled(true));

const clock = new THREE.Clock();
app.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (app.renderer.xr.isPresenting) xr.update(dt);
  else desktop.update();
  app.updateHelpers(clock.elapsedTime);
  app.renderer.render(app.scene, app.camera);
});

// Handy for debugging from the console.
window.handsculpt = { app, xr, desktop };
