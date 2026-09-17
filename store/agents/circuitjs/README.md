# CircuitJS, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[CircuitJS1](https://www.falstad.com/circuit/), Paul Falstad's interactive circuit simulator:
describe a circuit in the terminal, watch it run in the pane while the agent writes it — charge
moving along the wires, scope traces drawing, sliders you can turn while it runs. Runs on Codex.

The pane is the real simulator, not a picture of one. Drag a part, change a value, open the
Circuits menu and load one of the 373 examples: it keeps running, and the agent's next save lands in
the app without a reload.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `viewer.mjs` — the pane: CircuitJS1 in a same-origin iframe served off loopback, plus a header
  bar with the file name, the element count and the simulation clock. A change on disk becomes a
  `CircuitJS1.importCircuit()` call through the app's own JavaScript interface, so the app keeps its
  window and its run state.
- `toolchain/setup.sh` — fetches CircuitJS1 into `upstream/` (gitignored); `verdict.py` parses the
  circuit and writes `.harness/verdict.json`; `doctor.sh` says what is missing.
- `skills/circuitjs/` — the file format, the layout rules and nine of upstream's own circuits.
  `template/` — a 555 astable flashing an LED, with three scopes.

```sh
harness dsh check .                                  # conformance
harness dsh install . --link                         # this checkout as the installed agent
harness dsh doctor autonomous/circuitjs              # what the machine is missing
python3 -m unittest toolchain/test_verdict.py        # the judge's own tests
```

## Credit and stewardship

CircuitJS1 is Paul Falstad's and Iain Sharp's — [pfalstad/circuitjs1](https://github.com/pfalstad/circuitjs1),
**GPL-2.0** (`LICENSE-circuitjs1`). Nothing of it is changed and nothing of it is vendored here:
`toolchain/setup.sh` downloads it at install time, pinned in `VERSIONS`, and the pane serves it as
published. `THIRD_PARTY_NOTICES.md` says exactly what is fetched, from where, and the two
serving-time edits the pane makes to `circuitjs.html`. This repository is the Harness wrapper — the
manifest, the pane server, a skill, the verdict — written by Autonomous to bring CircuitJS1 into
Harness, on the project's behalf, to bootstrap the catalogue.

Upstream commits no compiled output and cuts no releases; its own CI publishes the build to
[pfalstad.github.io/circuitjs1](https://pfalstad.github.io/circuitjs1/circuitjs.html), which the
upstream README names as the hosted development version, and that is where `setup.sh` takes the
compiled module from. If that ever changes — a release, a published artefact — `VERSIONS` is the one
place to point somewhere better.

If you maintain CircuitJS1 and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in CircuitJS1 belong upstream, bugs
in the wrapper belong here, and a newer CircuitJS1 is a bump in `VERSIONS`.
