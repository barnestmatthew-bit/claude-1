# HandSculpt VR

Hand-tracked 3D modeling and sculpting in VR, with one-tap export to Blender.

No controllers: you pull basic shapes off a shelf and drop them where you want them,
then shape them like clay with your fingertips. Press **Export** on your wrist and the
model shows up in Blender.

It's a WebXR app built on [three.js](https://threejs.org), so it runs in the
headset's browser (built for Meta Quest Browser; other WebXR browsers with hand tracking
should work too) with nothing to install on the headset.

## Controls

### Build mode: drag and drop pieces

| Gesture | Action |
| --- | --- |
| Pinch a shape on the shelf and pull | Take a new piece (cube, sphere, cylinder, cone, torus, capsule) and drop it anywhere |
| Pinch a piece | Move and rotate it with your hand |
| Pinch one piece with **both** hands | Scale it (pull hands apart or together) and rotate it |
| Drop a piece into the red bin | Delete it |
| Make a fist on a piece (any mode) | Grab it and turn it, e.g. to sculpt the other side |

### Sculpt mode: hands-on clay

| Gesture | Action |
| --- | --- |
| Touch the surface with your index fingertip | Use the current tool: **Push** (dent the clay), **Inflate** (build it up), **Smooth**, **Carve** |
| Pinch near the surface and pull | Grab the clay and stretch it out (or push it in) |
| **5 Fing.** toggle | Sculpt with every fingertip at once, to squish the clay with your whole hand |
| **Mirror** toggle | Symmetric sculpting across the piece's X axis |
| **S / M / L / XL** | Brush size (1 cm to 5 cm) |

A wireframe sphere on your fingertip shows the brush size. It turns orange while it's
changing the clay.

### Wrist menu

Turn your **left palm toward your face** and a menu appears above it. Poke its buttons
with your right index finger:
Build / Sculpt, Snap (1 cm and 15° snapping), Mirror, Export, tools, brush sizes,
Undo / Redo, Copy, Delete, Clear, and colors.

### Desktop (no headset)

Open the same page in a desktop browser to keep working or to test:
drag to orbit · **W/E/R** move/rotate/scale gizmo · **Tab** Build/Sculpt ·
drag on clay to sculpt, **Shift+drag** to pull · **1–4** tools · **[ ]** brush size ·
**Ctrl+Z / Ctrl+Shift+Z** undo/redo · **D** duplicate · **Del** delete · **Ctrl+S** export.

## Quick start

You need Python 3 on the computer that runs Blender.

```bash
python3 server/serve.py --https
```

It prints an address like `https://192.168.1.20:8443`.

1. Put on the headset, open that address in its browser, and accept the self-signed
   certificate warning (WebXR only works on secure origins).
2. Press **Enter VR** and put the controllers down. Hand tracking switches on
   automatically. On Quest, make sure *Settings > Movement tracking > Hand tracking*
   is enabled.

**USB alternative (Quest):** run `python3 server/serve.py` (plain HTTP), connect the
headset over USB, run `adb reverse tcp:8000 tcp:8000`, and open `http://localhost:8000`
in the headset. `localhost` counts as secure.

To test on desktop only, open `http://localhost:8000`.

## Getting models into Blender

Every export is a binary glTF (`.glb`): watertight meshes with welded vertices,
smooth normals, named objects, and a material per piece (base color). Units are meters
and the tabletop is the origin.

**Live link (recommended)**

1. In Blender: *Edit > Preferences > Add-ons > Install from Disk…* and pick
   `blender/handsculpt_bridge.py`, then enable **HandSculpt Bridge**.
2. *3D Viewport > Sidebar (N) > HandSculpt*: set **Folder** to this repo's `exports/`
   folder (or whatever you passed to `serve.py --exports`), then tick **Auto Import**.
3. Press **Export** in VR. The model appears in a `HandSculpt` collection in a second
   or two. With **Replace Previous** on, each export swaps out the last one, so you can
   go back and forth between the headset and Blender.

**Manual**

If the page isn't served by `serve.py`, Export downloads the `.glb` instead. In Blender,
use *File > Import > glTF 2.0 (.glb/.gltf)*.

Common next steps in Blender: *Remesh* or *Voxel Remesh* to merge overlapping pieces into
one sculpt, then keep refining in Sculpt Mode.

## Project layout

```
index.html            page shell, import map (three.js from CDN), desktop toolbar
src/main.js           entry point: wires the app, VR, and desktop front ends together
src/app.js            scene, shared state, actions (spawn, delete, color, undo, export)
src/xr.js             hand-tracked interaction: shelf drag/drop, two-hand scale, sculpting
src/hands.js          gesture detection from WebXR joints: pinch, fist, palm direction
src/ui.js             wrist menu (pokeable buttons) and in-VR toast messages
src/sculpt.js         brushes: push, inflate/carve, smooth, grab (pure, unit-tested)
src/primitives.js     dense, watertight, sculptable primitive meshes
src/history.js        undo/redo
src/exporter.js       glTF export + upload to the companion server (download fallback)
src/desktop.js        mouse/keyboard controls
server/serve.py       static server + export receiver (+ self-signed HTTPS)
blender/handsculpt_bridge.py   Blender add-on: watches the exports folder and imports
tests/                unit tests for geometry and brushes
```

## Development

```bash
npm install     # only needed for the tests (pulls three.js locally)
npm test
```

The app itself has no build step. Edit a file and reload. To try hand-tracking input on
a desktop browser without a headset, install Meta's
[Immersive Web Emulator](https://github.com/meta-quest/immersive-web-emulator) extension.

## Known limitations / next steps

- Mesh resolution is fixed per primitive (about 8–11k vertices). Very long pulls stretch
  triangles. Dynamic subdivision (topology that refines under the brush) would be the
  next big upgrade.
- No collisions between pieces. Pieces stay separate objects (combine them in Blender).
- The menu is on the left wrist and pressed with the right hand. A left-handed option
  would be easy to add.
- Hand tracking only. Controllers aren't mapped yet.
- Sessions aren't saved in the app; your exports are the save files.
