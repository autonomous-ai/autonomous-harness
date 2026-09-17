#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. One venv with the pinned MuJoCo and the pieces that
# turn a simulation into a video; the MuJoCo Menagerie robots the skill names, at a pinned commit,
# sparsely (their meshes are most of the repository). Training extras are a second script.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./VERSIONS
PY=""; for c in python3.12 python3.11 python3.13 python3; do if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)' 2>/dev/null; then PY="$c"; break; fi; done
[ -n "$PY" ] || { echo "miss python 3.10–3.13 (brew install python@3.12)"; exit 1; }
echo "ok   $($PY --version)"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "     installing mujoco ${MUJOCO}"
.venv/bin/python -m pip install --quiet "mujoco==${MUJOCO}" numpy "imageio[ffmpeg]"
echo "ok   mujoco $(.venv/bin/python -c 'import mujoco; print(mujoco.__version__)')"
if [ ! -f menagerie/.harness-commit ] || [ "$(cat menagerie/.harness-commit)" != "${MENAGERIE_COMMIT}" ]; then
  echo "     fetching MuJoCo Menagerie @ ${MENAGERIE_COMMIT} (${MENAGERIE_ROBOTS})"
  rm -rf menagerie; mkdir menagerie; cd menagerie
  git init -q; git remote add origin https://github.com/google-deepmind/mujoco_menagerie.git
  git sparse-checkout init --cone >/dev/null; git sparse-checkout set ${MENAGERIE_ROBOTS} >/dev/null
  git fetch -q --depth 1 --filter=blob:none origin "${MENAGERIE_COMMIT}"
  git checkout -q FETCH_HEAD
  echo "${MENAGERIE_COMMIT}" > .harness-commit; cd ..
fi
for r in ${MENAGERIE_ROBOTS}; do [ -f "menagerie/$r/scene.xml" ] || { echo "miss menagerie/$r/scene.xml"; exit 1; }; done
echo "ok   menagerie: ${MENAGERIE_ROBOTS}"
echo "     rendering check"
.venv/bin/python - <<'PY'
import mujoco
m = mujoco.MjModel.from_xml_string('<mujoco><worldbody><light pos="0 0 3"/><geom type="sphere" size=".1"/></worldbody></mujoco>')
d = mujoco.MjData(m); r = mujoco.Renderer(m, 64, 64); mujoco.mj_forward(m, d); r.update_scene(d); r.render()
print("ok   offscreen rendering works")
PY
