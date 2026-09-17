#!/usr/bin/env bash
# Runs once at install, cwd = the install dir. Two halves:
#
#   1. The open-source FPGA flow — yosys, nextpnr-ice40, icestorm, icarus-verilog — from Homebrew.
#      These are compilers and a bitstream packer; they belong on PATH, not vendored in this folder,
#      and Homebrew is how they are published for macOS. Already-installed formulas are left alone,
#      so running this twice costs nothing.
#   2. netlistsvg (and its elkjs layout engine) into this directory's node_modules, from the
#      lockfile. Nothing global.
#
# On a machine without Homebrew, or on Linux, this says exactly which tools are missing and where to
# get them; it never installs a package manager.
set -euo pipefail
cd "$(dirname "$0")/.."

FORMULAS=(yosys nextpnr-ice40 icestorm icarus-verilog)
# formula:binary — the binary is how we know the formula is really there.
BINARIES=(yosys nextpnr-ice40 icepack iverilog)

have() { command -v "$1" >/dev/null 2>&1; }
have yosys || export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

missing=()
for i in "${!FORMULAS[@]}"; do
  have "${BINARIES[$i]}" || missing+=("${FORMULAS[$i]}")
done

if [ ${#missing[@]} -eq 0 ]; then
  echo "ok   yosys, nextpnr-ice40, icestorm, icarus-verilog already on PATH"
elif have brew; then
  echo "     brew install ${missing[*]}  (the open-source FPGA flow; a few minutes the first time)"
  HOMEBREW_NO_AUTO_UPDATE=1 brew install "${missing[@]}"
else
  echo "miss ${missing[*]} and no brew to install them with."
  echo "     macOS:  /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\" then re-run this"
  echo "     Linux:  apt install yosys nextpnr-ice40 fpga-icestorm iverilog"
  echo "     Either: the YosysHQ oss-cad-suite tarball, https://github.com/YosysHQ/oss-cad-suite-build/releases"
  exit 1
fi

for i in "${!BINARIES[@]}"; do
  have "${BINARIES[$i]}" || { echo "miss ${BINARIES[$i]} even after installing ${FORMULAS[$i]}"; exit 1; }
done

have node >/dev/null || { echo "miss node >= 18 on PATH (the viewer and netlistsvg)"; exit 1; }
have npm >/dev/null || { echo "miss npm on PATH"; exit 1; }
have python3 >/dev/null || { echo "miss python3 (the VCD reader and the verdict)"; exit 1; }

echo "     npm ci (netlistsvg $(node -p "require('./package.json').dependencies.netlistsvg"), for the schematic)"
npm ci --silent --no-audit --no-fund
[ -x node_modules/.bin/netlistsvg ] || { echo "miss node_modules/.bin/netlistsvg after npm ci"; exit 1; }

echo "ok   $(yosys -V 2>&1 | head -1)"
echo "ok   nextpnr-ice40 · icepack · $(iverilog -V 2>&1 | head -1)"
echo "ok   netlistsvg $(node -p "require('netlistsvg/package.json').version") · node $(node -v)"
