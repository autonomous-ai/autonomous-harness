#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Two vendored toolchains, both inside this directory and
# nothing on the user's machine: a venv with the pinned RDKit for the chemistry (the agent's toolchain,
# and the pane's worker for SDFs the toolchain did not write), and node_modules with 3Dmol.js for the pane.
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
echo "     chemistry check (build, conformers, depict, describe, series)"
PYTHONPATH="$PWD/toolchain" .venv/bin/python - <<'PY'
import json, tempfile, pathlib
from harness_rdkit import design, similarity, substructure, mol_from_smiles
with tempfile.TemporaryDirectory() as tmp:
    report = design("CC(C)Cc1ccc(cc1)C(C)C(=O)O", "ibuprofen", out=tmp)
    assert report["conformers"] > 1 and report["formula"] == "C13H18O2", report
    analogue = design("CC(C)(O)Cc1ccc(C(C)C(=O)O)cc1", "ibuprofen_oh", out=tmp)
    assert analogue["parent"]["name"] == "ibuprofen" and analogue["parent"]["change"] == "+O", analogue["parent"]
    out = pathlib.Path(tmp)
    for name in ("ibuprofen.sdf", "ibuprofen.conformers.sdf", "ibuprofen.png", "ibuprofen.svg", "ibuprofen_oh.molecule.json"):
        assert (out / name).stat().st_size > 1000, name
    record = json.loads((out / "ibuprofen_oh.molecule.json").read_text())
    assert all(a["q"] is not None for a in record["atoms"]) and record["parent"]["changed"], record["parent"]
    assert [m["name"] for m in json.loads((out / "series.json").read_text())["molecules"]] == ["ibuprofen", "ibuprofen_oh"]
assert round(similarity("c1ccccc1O", "c1ccccc1O"), 3) == 1.0
assert substructure(mol_from_smiles("c1ccccc1O"), "[OX2H]c1ccccc1")
print("ok   conformer search, MMFF minimisation, Gasteiger charges, 2D depiction and the series work")
PY
command -v node >/dev/null 2>&1 || { echo "miss node >= 18 on PATH (the pane)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "miss npm on PATH (the pane)"; exit 1; }
echo "     npm ci (3Dmol.js $(node -p "require('./package.json').dependencies['3dmol']"))"
npm ci --silent --no-audit --no-fund
[ -f node_modules/3dmol/build/3Dmol-min.js ] || { echo "miss the 3Dmol.js bundle after npm ci"; exit 1; }
[ -f pane/app.js ] && [ -f pane/index.html ] || { echo "miss the pane (pane/index.html, pane/app.js)"; exit 1; }
echo "ok   3dmol $(node -p "require('3dmol/package.json').version")"
