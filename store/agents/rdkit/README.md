# RDKit, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[RDKit](https://www.rdkit.org): describe a molecule in the chat pane — a drug, an analogue, a
scaffold, a series — and watch it appear in the molecule pane as a 3D conformer you can rotate, with
its properties beside it and its 2D depiction in the corner. Runs on Codex.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `viewer.mjs` — the pane: 3Dmol.js from this package's own `node_modules` (the UMD build, no CDN),
  stick-and-ball in Jmol colours over a dark background, Spin and Surface (VDW, 60 %) toggles, the
  properties panel from `out/properties.json`, the 2D PNG in the corner, reloaded over SSE on change.
- `toolchain/setup.sh` — one venv with the pinned RDKit, numpy and pandas (`VERSIONS`) plus `npm ci`;
  `harness_rdkit.py` builds from SMILES, embeds a conformer (ETKDGv3 + MMFF94) and writes the SDF,
  the depiction, the properties and the report; `verdict.py` judges Design / Embed / Review.
- `skills/rdkit/` — the RDKit skill (ours): SMILES and SMARTS, the helper API, scaffolds, analogue
  series, similarity, conformers, and the pitfalls. `template/` — ibuprofen, built in six lines.

## Credit and stewardship

RDKit is the RDKit contributors' work, led by Greg Landrum —
[rdkit/rdkit](https://github.com/rdkit/rdkit), BSD-3-Clause (`LICENSE-rdkit`) — and the pane is
[3Dmol.js](https://3dmol.csb.pitt.edu), David Koes and contributors at the University of Pittsburgh,
BSD-3-Clause (`LICENSE-3dmol`). Nothing of either is changed here: RDKit is installed from PyPI as
released and 3Dmol.js is loaded as they publish it on npm. This repository is the Harness wrapper —
the manifest, the pane server, a skill, the helper, the template, the verdict — written by Autonomous
to bring RDKit into Harness, on the project's behalf, to bootstrap the catalogue.

If you maintain RDKit or 3Dmol.js and want to own this package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in RDKit belong upstream, bugs in the
wrapper belong here, and a newer RDKit is a bump of `VERSIONS`.

Nothing in this package predicts activity, binding or safety. It computes what RDKit computes —
molecular weight, Crippen cLogP, TPSA, hydrogen-bond counts, Lipinski, QED, fingerprints, geometry —
and says so.

```sh
harness dsh check .                                # conformance
harness dsh install . --link                       # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without rdkit
```
