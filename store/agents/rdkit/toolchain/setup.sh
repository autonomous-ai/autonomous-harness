#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Two vendored toolchains, both inside this directory and
# nothing on the user's machine: a venv with the pinned RDKit for the chemistry, and node_modules with
# 3Dmol.js for the pane.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
. ./VERSIONS
PY=""; for c in python3.12 python3.11 python3.13 python3; do if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; raise SystemExit(0 if (3, 10) <= sys.version_info < (3, 14) else 1)' 2>/dev/null; then PY="$c"; break; fi; done
[ -n "$PY" ] || { echo "miss python 3.10–3.13 (brew install python@3.12)"; exit 1; }
echo "ok   $($PY --version)"
[ -x .venv/bin/python ] || "$PY" -m venv .venv
.venv/bin/python -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
echo "     installing rdkit ${RDKIT}"
.venv/bin/python -m pip install --quiet "rdkit==${RDKIT}" "numpy==${NUMPY}" "pandas==${PANDAS}"
echo "ok   rdkit $(.venv/bin/python -c 'import rdkit; print(rdkit.__version__)') · numpy $(.venv/bin/python -c 'import numpy; print(numpy.__version__)') · pandas $(.venv/bin/python -c 'import pandas; print(pandas.__version__)')"
echo "     chemistry check (build, embed, depict)"
PYTHONPATH="$PWD/toolchain" .venv/bin/python - <<'PY'
import tempfile, pathlib
from harness_rdkit import design, similarity, substructure, mol_from_smiles
with tempfile.TemporaryDirectory() as tmp:
    report = design("CN1C=NC2=C1C(=O)N(C)C(=O)N2C", "caffeine", out=tmp)
    assert report["conformers"] == 1 and report["formula"] == "C8H10N4O2", report
    assert pathlib.Path(tmp, "caffeine.sdf").stat().st_size > 1000
    assert pathlib.Path(tmp, "caffeine.png").stat().st_size > 1000
assert round(similarity("c1ccccc1O", "c1ccccc1O"), 3) == 1.0
assert substructure(mol_from_smiles("c1ccccc1O"), "[OX2H]c1ccccc1")
print("ok   3D embedding, MMFF minimisation and 2D depiction work")
PY
command -v node >/dev/null 2>&1 || { echo "miss node >= 18 on PATH (the pane)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH (the pane)"; exit 1; }
echo "     npm ci (3Dmol.js $(node -p "require('./package.json').dependencies['3dmol']"))"
npm ci --silent --no-audit --no-fund
[ -f node_modules/3dmol/build/3Dmol-min.js ] || { echo "miss the 3Dmol.js bundle after npm ci"; exit 1; }
echo "ok   3dmol $(node -p "require('3dmol/package.json').version")"
