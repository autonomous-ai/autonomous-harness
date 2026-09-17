#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
if [ -x .venv/bin/manim ]; then echo "ok   manim $(cat MANIM_VERSION)"; else echo "miss .venv/bin/manim — run toolchain/setup.sh"; bad=1; fi
if [ "$(uname -s)" = Darwin ] && ! (command -v pkg-config >/dev/null 2>&1 && pkg-config --exists cairo 2>/dev/null); then echo "miss cairo and pkg-config (brew install cairo pkgconf)"; bad=1; fi
if command -v ffmpeg >/dev/null 2>&1; then echo "ok   ffmpeg"; else echo "miss ffmpeg on PATH (brew install ffmpeg)"; bad=1; fi
if command -v latex >/dev/null 2>&1; then echo "ok   latex (Tex/MathTex available)"; else echo "warn latex not on PATH — Tex/MathTex scenes need it (brew install --cask mactex-no-gui); Text() works without"; fi
exit $bad
