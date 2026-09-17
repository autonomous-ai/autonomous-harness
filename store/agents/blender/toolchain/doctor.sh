#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."
if [ -x .venv/bin/python ] && .venv/bin/python -c 'import bpy' 2>/dev/null; then echo "ok   blender $(.venv/bin/python -c 'import bpy; print(bpy.app.version_string)')"; else echo "miss .venv with bpy — run toolchain/setup.sh"; exit 1; fi
if command -v ffmpeg >/dev/null 2>&1; then echo "ok   ffmpeg (turntables)"; else echo "warn ffmpeg not on PATH — turntables stay as frames (brew install ffmpeg)"; fi
