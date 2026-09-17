#!/usr/bin/env bash
set -u; cd "$(dirname "$0")/.."; bad=0
if [ -x .venv/bin/python ] && .venv/bin/python -c 'import rdkit' 2>/dev/null; then echo "ok   rdkit $(.venv/bin/python -c 'import rdkit; print(rdkit.__version__)')"; else echo "miss .venv with rdkit — run toolchain/setup.sh"; bad=1; fi
if [ -x .venv/bin/python ] && .venv/bin/python -c 'import pandas' 2>/dev/null; then echo "ok   pandas $(.venv/bin/python -c 'import pandas; print(pandas.__version__)') · numpy $(.venv/bin/python -c 'import numpy; print(numpy.__version__)')"; else echo "warn pandas/numpy missing — tables and enumerations need them"; fi
if [ -f node_modules/3dmol/build/3Dmol-min.js ]; then echo "ok   3dmol $(node -p "require('3dmol/package.json').version") (the pane)"; else echo "miss node_modules — run toolchain/setup.sh"; bad=1; fi
exit $bad
