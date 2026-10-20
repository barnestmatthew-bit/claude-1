"""HandSculpt Bridge — live import of HandSculpt VR exports into Blender.

Install: Edit > Preferences > Add-ons > Install from Disk… and pick this file
(Blender 4.2+: the dropdown in the top right of the Add-ons tab), then enable
"HandSculpt Bridge".

Use: 3D Viewport > Sidebar (N) > HandSculpt. Point "Folder" at the exports
folder of server/serve.py (the repo's exports/ by default) and turn on
"Auto Import". Every time you press Export in VR, the model appears here.
"""

bl_info = {
    "name": "HandSculpt Bridge",
    "author": "HandSculpt",
    "version": (0, 1, 0),
    "blender": (3, 6, 0),
    "location": "3D Viewport > Sidebar > HandSculpt",
    "description": "Auto-import models exported from HandSculpt VR (.glb)",
    "category": "Import-Export",
}

import os

import bpy

COLLECTION = "HandSculpt"
POLL_SECONDS = 1.5

_seen = {}  # path -> mtime already handled
_status = {"text": "Idle"}


def _glb_files(folder):
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    out = []
    for n in names:
        if n.lower().endswith(".glb"):
            p = os.path.join(folder, n)
            try:
                out.append((os.path.getmtime(p), p))
            except OSError:
                pass
    return sorted(out)


def _folder(scene):
    return bpy.path.abspath(scene.handsculpt_folder) if scene.handsculpt_folder else ""


def _find_layer_collection(layer, name):
    if layer.name == name:
        return layer
    for child in layer.children:
        found = _find_layer_collection(child, name)
        if found:
            return found
    return None


def _ui_override():
    wm = bpy.context.window_manager
    for window in wm.windows:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                region = next((r for r in area.regions if r.type == "WINDOW"), None)
                return {"window": window, "screen": window.screen, "area": area, "region": region}
    if wm.windows:
        return {"window": wm.windows[0], "screen": wm.windows[0].screen}
    return {}


def import_glb(scene, path, replace):
    coll = bpy.data.collections.get(COLLECTION)
    if coll is None:
        coll = bpy.data.collections.new(COLLECTION)
    if coll.name not in scene.collection.children:
        scene.collection.children.link(coll)

    if replace:
        for obj in list(coll.all_objects):
            data = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            if isinstance(data, bpy.types.Mesh) and data.users == 0:
                bpy.data.meshes.remove(data)

    view_layer = bpy.context.view_layer
    previous = view_layer.active_layer_collection
    target = _find_layer_collection(view_layer.layer_collection, coll.name)
    if target:
        view_layer.active_layer_collection = target
    try:
        with bpy.context.temp_override(**_ui_override()):
            bpy.ops.import_scene.gltf(filepath=path)
    finally:
        view_layer.active_layer_collection = previous

    _status["text"] = f"Imported {os.path.basename(path)}"


def _poll():
    scene = bpy.context.scene
    if scene is None or not scene.handsculpt_auto:
        return None  # stop the timer
    folder = _folder(scene)
    if not folder:
        _status["text"] = "Set a folder to watch"
        return POLL_SECONDS
    fresh = [(m, p) for m, p in _glb_files(folder) if _seen.get(p) != m]
    if fresh:
        mtime, path = fresh[-1]  # newest only; skip a backlog
        for m, p in fresh:
            _seen[p] = m
        try:
            import_glb(scene, path, scene.handsculpt_replace)
        except Exception as exc:  # keep watching even if one file fails
            _status["text"] = f"Import failed: {exc}"
            print("HandSculpt Bridge:", exc)
    return POLL_SECONDS


def _toggle_auto(self, context):
    if self.handsculpt_auto:
        # Only import exports made from now on.
        for m, p in _glb_files(_folder(self)):
            _seen[p] = m
        _status["text"] = "Watching for exports…"
        if not bpy.app.timers.is_registered(_poll):
            bpy.app.timers.register(_poll, first_interval=POLL_SECONDS, persistent=True)
    else:
        _status["text"] = "Idle"
        if bpy.app.timers.is_registered(_poll):
            bpy.app.timers.unregister(_poll)


@bpy.app.handlers.persistent
def _on_load(_dummy):
    # Resume watching in .blend files saved with Auto Import on.
    scene = bpy.context.scene
    if scene and scene.handsculpt_auto:
        _toggle_auto(scene, bpy.context)


class HANDSCULPT_OT_import_latest(bpy.types.Operator):
    bl_idname = "handsculpt.import_latest"
    bl_label = "Import Latest"
    bl_description = "Import the newest .glb in the watched folder"

    def execute(self, context):
        files = _glb_files(_folder(context.scene))
        if not files:
            self.report({"WARNING"}, "No .glb exports found in the folder")
            return {"CANCELLED"}
        mtime, path = files[-1]
        _seen[path] = mtime
        import_glb(context.scene, path, context.scene.handsculpt_replace)
        self.report({"INFO"}, _status["text"])
        return {"FINISHED"}


class HANDSCULPT_PT_panel(bpy.types.Panel):
    bl_label = "HandSculpt VR"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "HandSculpt"

    def draw(self, context):
        layout = self.layout
        scene = context.scene
        layout.prop(scene, "handsculpt_folder", text="Folder")
        layout.prop(scene, "handsculpt_auto")
        layout.prop(scene, "handsculpt_replace")
        layout.operator(HANDSCULPT_OT_import_latest.bl_idname, icon="IMPORT")
        layout.label(text=_status["text"])


CLASSES = (HANDSCULPT_OT_import_latest, HANDSCULPT_PT_panel)


def register():
    bpy.types.Scene.handsculpt_folder = bpy.props.StringProperty(
        name="Folder", subtype="DIR_PATH", description="Folder HandSculpt exports are saved to",
    )
    bpy.types.Scene.handsculpt_auto = bpy.props.BoolProperty(
        name="Auto Import", default=False, update=_toggle_auto,
        description="Import each new export as soon as it arrives",
    )
    bpy.types.Scene.handsculpt_replace = bpy.props.BoolProperty(
        name="Replace Previous", default=True,
        description="Remove the previous import before bringing in a new one",
    )
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.app.handlers.load_post.append(_on_load)


def unregister():
    if _on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load)
    if bpy.app.timers.is_registered(_poll):
        bpy.app.timers.unregister(_poll)
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)
    del bpy.types.Scene.handsculpt_folder
    del bpy.types.Scene.handsculpt_auto
    del bpy.types.Scene.handsculpt_replace


if __name__ == "__main__":
    register()
