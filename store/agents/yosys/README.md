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
                                                     ├─> out/<top>_pnr.json     utilisation, Fmax, critical paths
                                                     └─> out/<top>_routed.json  every cell's BEL, every net's wires
```

Everything lands in `out/<top>.report.json`, which is the artifact the pane draws and the verdict
names. Beside each step's log in `out/logs/` the flow keeps `<step>.start`, `<step>.time` and
`<step>.exit`, and `out/logs/run.json` says which run it is and whether it has finished — which is
how the pane shows the step that is running *now*.

- `harness.json` — the manifest: engine, template, skill, toolchain, viewer, verdict.
- `skills/yosys/` — the skill (ours): the synthesisable Verilog-2005 subset, the testbench shape,
  the iCEBreaker pinout, how to read utilisation and Fmax, the pitfalls, and ready-made
  UART / PWM / debounce blocks. Every code block in it compiles and synthesises.
- `toolchain/setup.sh` installs the four tools from Homebrew (idempotent — it skips what is already
  on PATH) and netlistsvg into `node_modules`; `doctor.sh` checks all of them;
  `flow.sh <top>` is the whole flow; `vcd2json.py` turns the VCD into a summary for the verdict;
  `verdict.py` writes `out/<top>.report.json` and `.harness/verdict.json` **before and after every
  step**, so the pane fills in while the flow runs.
- `viewer.mjs` + `viewer/` — the pane. A small node server (`viewer/lib/`: a VCD reader, the
  netlist hierarchy, netlistsvg in a worker, the floorplan from nextpnr's routed JSON, the PCF, the
  live flow state) and a page of plain ES modules (`viewer/public/`), no framework, no CDN:
  - **Pipeline** in the header — Simulate → Synthesize → Place & route → Bitstream, live: the step
    running now with its elapsed time and the line its tool just printed, results as they land,
    a failed step in red with its error line and its log a click away.
  - **Waves** — GTKWave/Surfer-style: a signal browser over the VCD's scopes with search (and
    parameters with their values), add/remove/reorder, radix per bus (hex, unsigned, signed,
    binary, octal, ASCII), buses as analog step plots, a UART 8N1 decoder with the baud measured
    off the line, zoom and pan by wheel, trackpad, keys and ruler drag, a cursor and a marker with
    Δt and 1/Δt, a value for every signal at the cursor, edge-to-edge stepping, clocks that stay
    readable at any zoom. The whole dump is read, not a sample.
  - **Schematic** — every module of the hierarchy drawn by netlistsvg on demand: pan/zoom,
    hover to name a cell or net, click a net to trace it, search across all modules, open an
    instance, jump to the RTL line, show a net in the waves.
  - **Chip** — nextpnr's view of the iCE40 die: every tile, every placed logic cell (by module or
    by kind), routes at tile resolution, the critical path; utilisation per hard block; Fmax
    against the PCF's target with slack; the critical paths hop by hop with RTL sources.
  - **Board** — the iCEBreaker drawn with the UP5K's 48 pins and a trace from every used one to
    the part it reaches; the pin table with direction and active-low notes; unconstrained ports
    and pin clashes flagged; what is still free.
  - **Flow** — each step's tool, time and log (errors highlighted, live while running), findings,
    testbench checks, cells by type, the bitstream and the `iceprog` line.
  Keyboard throughout (`?` lists it); view state (signals, zoom, cursor) survives every new run.
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
npm test                                                  # the pane's readers, the judge and the VCD reader, without a toolchain
```
