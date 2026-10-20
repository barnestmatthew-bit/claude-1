// Export the workspace as binary glTF (.glb), which Blender imports natively
// (File > Import > glTF 2.0, or automatically via blender/handsculpt_bridge.py).
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

export async function exportGLB(root) {
  const exporter = new GLTFExporter();
  return exporter.parseAsync(root, { binary: true, onlyVisible: true });
}

function timestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `handsculpt-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.glb`;
}

// Upload to the companion server (saved into exports/ where the Blender add-on
// picks it up). If no server is listening, fall back to a browser download.
export async function deliver(buffer, filename = timestampName()) {
  try {
    const res = await fetch('api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'model/gltf-binary', 'X-Filename': filename },
      body: buffer,
    });
    if (res.ok) {
      const { path } = await res.json();
      return { via: 'server', filename, path };
    }
  } catch {
    // No companion server; use a download instead.
  }
  const url = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { via: 'download', filename };
}
