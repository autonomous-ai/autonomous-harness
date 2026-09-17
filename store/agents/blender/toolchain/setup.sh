#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with `bpy` — Blender as a Python module, the
# whole of Blender minus its window — at the pinned version. The wheel is Python-version specific.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat BPY_VERSION)"
PY=""; for c in python3.11 python3; do if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 11) else 1)' 2>/dev/null; then PY="$c"; break; fi; done
[ -n "$PY" ] || { echo "miss python 3.11 exactly — the bpy ${VERSION} wheel is built for it (brew install python@3.11)"; exit 1; }
echo "ok   $($PY --version)"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "     installing bpy ${VERSION} (Blender as a module, ~300 MB, a few minutes the first time)"
.venv/bin/python -m pip install --quiet "bpy==${VERSION}" numpy
echo "ok   blender $(.venv/bin/python -c 'import bpy; print(bpy.app.version_string)')"
echo "     render check (Workbench, headless)"
.venv/bin/python - <<'PY'
import bpy, tempfile, os
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add()
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam")); bpy.context.scene.collection.objects.link(cam)
cam.location = (4, -4, 3); cam.rotation_euler = (1.1, 0, 0.78); bpy.context.scene.camera = cam
s = bpy.context.scene; s.render.engine = "BLENDER_WORKBENCH"; s.render.resolution_x = 64; s.render.resolution_y = 64
s.render.filepath = os.path.join(tempfile.gettempdir(), "harness-bpy-check.png"); bpy.ops.render.render(write_still=True)
print("ok   headless rendering works")
PY
