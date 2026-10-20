#!/usr/bin/env python3
"""HandSculpt companion server.

Serves the web app and receives exports from the headset, saving each one into
a folder that the Blender add-on (blender/handsculpt_bridge.py) watches.

    python3 server/serve.py                 # http://localhost:8000
    python3 server/serve.py --https         # https://<this-pc-ip>:8443 (self-signed)
    python3 server/serve.py --exports ~/handsculpt

WebXR only runs on secure origins, so a headset on your Wi-Fi needs --https
(accept the certificate warning once), or use `adb reverse tcp:8000 tcp:8000`
over USB and open http://localhost:8000 on the headset.
"""
import argparse
import http.server
import json
import os
import re
import socket
import ssl
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAX_UPLOAD = 256 * 1024 * 1024


def safe_name(name: str) -> str:
    name = os.path.basename(name or "")
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._") or "handsculpt"
    if not name.lower().endswith(".glb"):
        name += ".glb"
    return name


class Handler(http.server.SimpleHTTPRequestHandler):
    exports_dir: Path = ROOT / "exports"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Always serve fresh code while iterating.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        if self.path.rstrip("/") != "/api/export":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_UPLOAD:
            self.send_error(413 if length > MAX_UPLOAD else 400)
            return
        data = self.rfile.read(length)
        if data[:4] != b"glTF":
            self.send_error(400, "Expected a binary glTF (.glb) file")
            return

        self.exports_dir.mkdir(parents=True, exist_ok=True)
        target = self.exports_dir / safe_name(self.headers.get("X-Filename"))
        # Write then rename so watchers never see a half-written file.
        tmp = target.with_suffix(".part")
        tmp.write_bytes(data)
        os.replace(tmp, target)
        print(f"  saved export -> {target}")

        body = json.dumps({"path": str(target)}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def ensure_cert(cert_dir: Path, ip: str):
    cert, key = cert_dir / "cert.pem", cert_dir / "key.pem"
    if cert.exists() and key.exists():
        return cert, key
    cert_dir.mkdir(parents=True, exist_ok=True)
    print("Creating a self-signed certificate (requires openssl)...")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
            "-keyout", str(key), "-out", str(cert), "-subj", "/CN=HandSculpt",
            "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
        ],
        check=True,
        capture_output=True,
    )
    return cert, key


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int)
    p.add_argument("--https", action="store_true", help="serve over HTTPS with a self-signed certificate")
    p.add_argument("--cert", help="certificate file (PEM) to use instead of a self-signed one")
    p.add_argument("--key", help="private key file (PEM) for --cert")
    p.add_argument("--exports", default=str(ROOT / "exports"), help="folder to save exports into")
    args = p.parse_args()

    use_tls = args.https or bool(args.cert)
    port = args.port or (8443 if use_tls else 8000)
    Handler.exports_dir = Path(args.exports).expanduser().resolve()

    server = http.server.ThreadingHTTPServer((args.host, port), Handler)
    ip = lan_ip()
    if use_tls:
        cert, key = (args.cert, args.key) if args.cert else ensure_cert(ROOT / ".certs", ip)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)

    scheme = "https" if use_tls else "http"
    print(f"HandSculpt running:\n  {scheme}://localhost:{port}\n  {scheme}://{ip}:{port}  (open this on the headset)")
    print(f"Exports will be saved to: {Handler.exports_dir}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
