# Yosys, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for the open-source
FPGA flow — [Yosys](https://yosyshq.net/yosys/), [nextpnr](https://github.com/YosysHQ/nextpnr),
[Project IceStorm](https://prjicestorm.readthedocs.io) and
[Icarus Verilog](https://steveicarus.github.io/iverilog/). Describe a digital circuit in the chat
pane; get Verilog, a simulation with waveforms, a synthesized gate-level schematic and a bitstream
you can flash to an iCE40 board. Runs on Claude Code.

```
     rtl/*.v ──iverilog/vvp──> out/sim.vcd ──> out/waves.json          the waveforms
             │
             ├──yosys prep───> out/<top>_schematic.json ──netlistsvg──> out/<top>.svg
             │
             └──synth_ice40──> out/<top>.json ──nextpnr-ice40──> .asc ──icepack──> out/<top>.bin
                                                     │
                                                     └─> utilisation, Fmax
```

Everything lands in `out/<top>.report.json`, which is the artifact the pane draws and the verdict
names.

- `harness.json` — the manifest: engine, template, skill, toolchain, viewer, verdict.
- `skills/yosys/` — the skill (ours): the synthesisable Verilog-2005 subset, the testbench shape,
  the iCEBreaker pinout, how to read utilisation and Fmax, the pitfalls, and ready-made
  UART / PWM / debounce blocks. Every code block in it compiles and synthesises.
- `toolchain/setup.sh` installs the four tools from Homebrew (idempotent — it skips what is already
  on PATH) and netlistsvg into `node_modules`; `doctor.sh` checks all of them;
  `flow.sh <top>` is the whole flow; `vcd2json.py` turns the VCD into the pane's lanes;
  `verdict.py` writes `out/<top>.report.json` and `.harness/verdict.json` **after every step**, so
  the pane fills in while the flow runs.
- `viewer.mjs` — the pane, dependency-free: the schematic with pan and zoom, a waveform viewer
  drawn on a canvas (digital lanes, hex buses, zoom, pan, a cursor with per-signal values),
  utilisation bars, Fmax against the clock the PCF asks for, and where the bitstream is.
- `template/` — a fresh workspace: `rtl/blink.v` (a 12 MHz → 1 Hz LED blinker), its testbench, a
  commented iCEBreaker PCF, and `out/`.

Default target: **iCEBreaker**, a Lattice iCE40UP5K in the SG48 package. Another board is a
different `constraints/<top>.pcf` plus `YOSYS_DEVICE` / `YOSYS_PACKAGE`.

## Credit and stewardship

Yosys, nextpnr and Project IceStorm are **YosysHQ's** — Claire Xenia Wolf, gatecat and the YosysHQ
team — [YosysHQ/yosys](https://github.com/YosysHQ/yosys),
[YosysHQ/nextpnr](https://github.com/YosysHQ/nextpnr),
[YosysHQ/icestorm](https://github.com/YosysHQ/icestorm), all ISC (`LICENSE-yosys`,
`LICENSE-nextpnr`, `LICENSE-icestorm`). Icarus Verilog is Stephen Williams's,
[steveicarus/iverilog](https://github.com/steveicarus/iverilog), GPL-2.0-or-later
(`LICENSE-iverilog`). netlistsvg is Neil Turley's,
[nturley/netlistsvg](https://github.com/nturley/netlistsvg), MIT (`LICENSE-netlistsvg`). The pin
numbers in the template's PCF are the
[iCEBreaker project's](https://codeberg.org/icebreaker-fpga/icebreaker-verilog-examples), cited in
the file itself.

Nothing of any of them is changed or redistributed here: `setup.sh` installs them from Homebrew and
npm as their authors publish them. This folder is the Harness wrapper — the manifest, a skill,
the template, the toolchain, the verdict and the viewer — written by Autonomous to bring the
open-source FPGA flow into Harness. We did that work on the projects' behalf, to bootstrap the
catalogue.

If you maintain any of these projects and want to own this Harness package, it is yours: open an
issue on [autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we
transfer this package and point the registry entry at it. Until then: bugs in the tools belong
upstream, bugs in the wrapper belong here, and a newer toolchain is a `brew upgrade`.

```sh
harness dsh check .                                      # conformance
harness dsh install "$PWD" --link                        # this checkout as the installed agent
harness dsh doctor autonomous/yosys                       # what this machine is missing
python3 -m unittest discover -s toolchain -p "test_*.py"  # the judge and the VCD reader, without a toolchain
```
