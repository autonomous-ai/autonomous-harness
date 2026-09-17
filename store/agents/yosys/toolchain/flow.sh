#!/usr/bin/env bash
#
#   flow.sh [top]        prompt to silicon, in the workspace
#
# Seven steps, in this order, each one logged and each one allowed to fail:
#
#   sim        iverilog + vvp   rtl/*.v + tb/<top>_tb.v   -> out/sim.vvp, out/sim.vcd
#   waves      vcd2json.py      out/sim.vcd               -> out/waves.json
#   synth      yosys synth_ice40                          -> out/<top>.json      (the PnR netlist)
#   schematic  yosys prep                                 -> out/<top>_schematic.json
#   svg        netlistsvg                                 -> out/<top>.svg       (the drawing)
#   pnr        nextpnr-ice40                              -> out/<top>.asc, out/<top>_pnr.json
#   pack       icepack                                    -> out/<top>.bin       (the bitstream)
#
# `set -e` is deliberately NOT on: a step that fails must still leave the ones before it standing,
# and the verdict — not this script's exit code — is how failure reaches the user. The verdict is
# rewritten after EVERY step, so the pane fills in as the flow runs instead of jumping at the end.
#
# Environment (all optional):
#   YOSYS_TOP        the top module; the argument wins over this
#   YOSYS_DEVICE     nextpnr device flag, default --up5k
#   YOSYS_PACKAGE    nextpnr package, default sg48
#   YOSYS_TOOLCHAIN  this directory; set by the harness
#   HARNESS_DSH_DIR  the install dir (netlistsvg lives in its node_modules)

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_DIR="${HARNESS_DSH_DIR:-$(cd "$HERE/.." && pwd)}"
WS="${HARNESS_WORKSPACE:-$PWD}"
cd "$WS" || { echo "no workspace at $WS" >&2; exit 2; }

# Homebrew's bin is not always on the PATH of a process the daemon spawned; put it there when the
# tools are not visible, rather than making every caller remember to.
command -v yosys >/dev/null 2>&1 || export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

TOP="${1:-${YOSYS_TOP:-}}"
if [ -z "$TOP" ]; then
  # No name given: the single testbench in tb/ names the top.
  for tb in tb/*_tb.v; do [ -e "$tb" ] || continue; TOP="$(basename "$tb" _tb.v)"; break; done
fi
[ -n "$TOP" ] || { echo "flow.sh: no top module — pass one, or put tb/<top>_tb.v in the workspace" >&2; exit 2; }

DEVICE="${YOSYS_DEVICE:---up5k}"
PACKAGE="${YOSYS_PACKAGE:-sg48}"
NETLISTSVG="$DSH_DIR/node_modules/.bin/netlistsvg"
LOGS="out/logs"
STEPS=(sim waves synth schematic svg pnr pack)

shopt -s nullglob
RTL=(rtl/*.v)
shopt -u nullglob
TB="tb/${TOP}_tb.v"
PCF="constraints/${TOP}.pcf"

mkdir -p out "$LOGS"
rm -f "$LOGS"/*.log "$LOGS"/*.exit
printf '%s\n' "$TOP" > out/.top

verdict() { python3 "$HERE/verdict.py" "$TOP" >/dev/null 2>&1; }

# run <step> — runs step_<step> with everything it prints captured, records the exit code, and
# refreshes the verdict so the pane moves. Returns the step's own status.
run() {
  local step="$1" code
  printf '\n\033[2m→ %s\033[0m\n' "$step"
  "step_$step" >"$LOGS/$step.log" 2>&1
  code=$?
  printf '%s\n' "$code" > "$LOGS/$step.exit"
  verdict
  if [ "$code" -eq 0 ]; then
    tail -4 "$LOGS/$step.log" | sed 's/^/  /'
  else
    echo "  failed (exit $code) — $LOGS/$step.log"
    tail -12 "$LOGS/$step.log" | sed 's/^/  /'
  fi
  return "$code"
}

step_sim() {
  [ ${#RTL[@]} -gt 0 ] || { echo "no rtl/*.v to simulate"; return 1; }
  [ -f "$TB" ] || { echo "no testbench at $TB"; return 1; }
  iverilog -g2012 -Wall -o out/sim.vvp "${RTL[@]}" "$TB" || return 1
  vvp out/sim.vvp || return 1
  [ -f out/sim.vcd ] || { echo "no out/sim.vcd — the testbench needs \$dumpfile(\"out/sim.vcd\") and \$dumpvars"; return 1; }
}

step_waves() {
  python3 "$HERE/vcd2json.py" out/sim.vcd out/waves.json
}

step_synth() {
  [ ${#RTL[@]} -gt 0 ] || { echo "no rtl/*.v to synthesise"; return 1; }
  yosys -p "read_verilog ${RTL[*]}; synth_ice40 -top $TOP -json out/$TOP.json; stat"
}

step_schematic() {
  # `prep` leaves the design technology-independent, which is what reads as a schematic: gates and
  # adders, not the SB_LUT4s that synth_ice40 maps everything to.
  yosys -q -p "read_verilog ${RTL[*]}; prep -top $TOP; write_json out/${TOP}_schematic.json"
}

step_svg() {
  [ -x "$NETLISTSVG" ] || { echo "no netlistsvg at $NETLISTSVG — run toolchain/setup.sh"; return 1; }
  "$NETLISTSVG" "out/${TOP}_schematic.json" -o "out/${TOP}.svg"
}

step_pnr() {
  command -v nextpnr-ice40 >/dev/null 2>&1 || { echo "nextpnr-ice40 is not installed — run toolchain/setup.sh"; return 127; }
  [ -f "$PCF" ] || { echo "no pin constraints at $PCF — every port needs a set_io line"; return 1; }
  nextpnr-ice40 "$DEVICE" --package "$PACKAGE" \
    --json "out/$TOP.json" --pcf "$PCF" \
    --asc "out/$TOP.asc" --report "out/${TOP}_pnr.json"
}

step_pack() {
  command -v icepack >/dev/null 2>&1 || { echo "icepack is not installed — run toolchain/setup.sh"; return 127; }
  icepack "out/$TOP.asc" "out/$TOP.bin"
}

echo "flow: $TOP  ($DEVICE --package $PACKAGE, ${#RTL[@]} RTL file(s))"
verdict  # a verdict with everything pending, before the first step

run sim  && run waves
run synth && { run schematic && run svg; run pnr && run pack; }

echo
python3 "$HERE/verdict.py" "$TOP"
