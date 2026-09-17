#!/usr/bin/env bash
# One line per check; exit 0 when this machine can take a Verilog file all the way to a bitstream.
set -u; cd "$(dirname "$0")/.."; bad=0
command -v yosys >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

line() { # line <label> <command...>
  local label="$1"; shift
  if v="$("$@" 2>&1 | head -1)" && [ -n "$v" ]; then echo "ok   $label — $v"; else echo "miss $label"; bad=1; fi
}

if command -v yosys >/dev/null 2>&1; then line "yosys, the synthesiser" yosys -V; else echo "miss yosys — run toolchain/setup.sh"; bad=1; fi
if command -v nextpnr-ice40 >/dev/null 2>&1; then
  echo "ok   nextpnr-ice40, place and route — $(nextpnr-ice40 --version 2>&1 | head -1)"
else echo "miss nextpnr-ice40 — run toolchain/setup.sh"; bad=1; fi
if command -v icepack >/dev/null 2>&1; then echo "ok   icepack, the bitstream packer (icestorm)"; else echo "miss icepack — run toolchain/setup.sh"; bad=1; fi
if command -v iverilog >/dev/null 2>&1; then line "iverilog, the simulator" iverilog -V; else echo "miss iverilog — run toolchain/setup.sh"; bad=1; fi
if command -v iceprog >/dev/null 2>&1; then echo "ok   iceprog, to flash a board over USB"; else echo "info iceprog not found — synthesis works, flashing a real board does not"; fi

if [ -x node_modules/.bin/netlistsvg ]; then echo "ok   netlistsvg $(node -p "require('netlistsvg/package.json').version" 2>/dev/null), the schematic"; else echo "miss node_modules — run toolchain/setup.sh"; bad=1; fi
if command -v node >/dev/null 2>&1; then echo "ok   node $(node -v) for the viewer"; else echo "miss node for the viewer"; bad=1; fi
if command -v python3 >/dev/null 2>&1; then echo "ok   $(python3 --version) for the waveforms and the verdict"; else echo "miss python3"; bad=1; fi

exit $bad
