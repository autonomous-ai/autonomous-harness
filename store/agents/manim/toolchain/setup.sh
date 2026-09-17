#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with the pinned Manim Community release.
# ffmpeg must be on the machine (brew install ffmpeg); LaTeX is optional (only for Tex/MathTex).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat MANIM_VERSION)"
# 3.12 first: it is the interpreter the most wheels exist for; pycairo still builds from source on
# every version, which is what cairo + pkg-config below are for.
PY=""; for c in python3.12 python3.11 python3.13 python3; do if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then PY="$c"; break; fi; done
[ -n "$PY" ] || { echo "miss python 3.11+ (brew install python@3.12)"; exit 1; }
echo "ok   $($PY --version)"
if [ "$(uname -s)" = Darwin ]; then
  need=""
  command -v pkg-config >/dev/null 2>&1 || need="$need pkgconf"
  pkg-config --exists cairo 2>/dev/null || need="$need cairo"
  if [ -n "$need" ]; then echo "miss pycairo builds from source and needs:$need — run: brew install$need"; exit 1; fi
  echo "ok   cairo $(pkg-config --modversion cairo) (manimpango ships its own pango)"
fi
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "     installing manim ${VERSION} (a couple of minutes the first time)"
.venv/bin/python -m pip install --quiet "manim==${VERSION}"
echo "ok   manim $(.venv/bin/manim --version 2>/dev/null | head -1)"
command -v ffmpeg >/dev/null 2>&1 && echo "ok   ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | cut -d' ' -f3)" || echo "warn ffmpeg not on PATH — renders need it: brew install ffmpeg"
