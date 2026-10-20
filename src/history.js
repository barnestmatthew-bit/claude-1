// Undo / redo of scene edits.
//
// Each entry has undo() and redo(). Helpers below capture the common cases:
// transforms, geometry (sculpt strokes), and adding/removing objects.

const LIMIT = 40;

export class History {
  constructor(onChange = () => {}) {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange = onChange;
  }

  push(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.onChange();
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    e.undo();
    this.redoStack.push(e);
    this.onChange();
    return true;
  }

  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    e.redo();
    this.undoStack.push(e);
    this.onChange();
    return true;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.onChange();
  }
}

export function captureTransform(obj) {
  return {
    position: obj.position.clone(),
    quaternion: obj.quaternion.clone(),
    scale: obj.scale.clone(),
  };
}

function applyTransform(obj, t) {
  obj.position.copy(t.position);
  obj.quaternion.copy(t.quaternion);
  obj.scale.copy(t.scale);
}

export function transformEntry(obj, before) {
  const after = captureTransform(obj);
  return {
    undo: () => applyTransform(obj, before),
    redo: () => applyTransform(obj, after),
  };
}

export function captureGeometry(mesh) {
  return mesh.geometry.attributes.position.array.slice();
}

export function geometryEntry(mesh, before, onApply) {
  const after = captureGeometry(mesh);
  const apply = (arr) => {
    mesh.geometry.attributes.position.array.set(arr);
    mesh.geometry.attributes.position.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
    onApply?.(mesh);
  };
  return { undo: () => apply(before), redo: () => apply(after) };
}

export function addEntry(parent, obj, onApply) {
  return {
    undo: () => { parent.remove(obj); onApply?.(); },
    redo: () => { parent.add(obj); onApply?.(); },
  };
}

export function removeEntry(parent, obj, onApply) {
  return {
    undo: () => { parent.add(obj); onApply?.(); },
    redo: () => { parent.remove(obj); onApply?.(); },
  };
}

// Several entries treated as one step (e.g. clearing the scene).
export function groupEntry(entries) {
  return {
    undo: () => { for (let i = entries.length - 1; i >= 0; i--) entries[i].undo(); },
    redo: () => { for (const e of entries) e.redo(); },
  };
}
