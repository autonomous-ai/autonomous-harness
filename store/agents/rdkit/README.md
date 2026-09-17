# RDKit, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[RDKit](https://www.rdkit.org): describe a molecule in the chat pane — a drug, an analogue, a
scaffold, a series — and watch it appear in the molecule pane: its conformers in 3D, its 2D depiction
linked atom-for-atom, its properties and rule badges, and the series it belongs to. Runs on Codex.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `pane/` + `viewer.mjs` — the pane, read-only, 3Dmol.js from this package's own `node_modules` (the
  UMD build, no CDN). 3D: wire / stick / ball-and-stick / spacefill, hydrogens all / polar / none,
  colour by element, Gasteiger charge, Crippen lipophilicity or change from the parent, VDW / SAS / SES
  surfaces coloured by electrostatic or lipophilicity potential, soft shadows or outlines on a light or
  dark stage, spin. Hover an atom (3D or 2D) for its charge, hybridisation, CIP label and groups; click
  atoms for distances, angles and dihedrals labelled in the scene. The RDKit SVG depiction is linked to
  the 3D model atom-for-atom, with chips for functional groups, PAINS/Brenk alerts and what changed from
  the parent. Properties with Lipinski / Veber / QED / alert badges, deltas against the parent and
  plain-language flags; SMILES / InChI / InChIKey to copy. The conformer ensemble with MMFF energies,
  play / step, an all-conformers overlay and the parent superposed on the shared atoms. The series as a
  strip of cards and a sortable comparison table; the newest opens, and the pane follows new molecules as
  they are written, keeping the camera, representation and measurements, with "embedding…" while
  `design` works. PNG of the view, SVG, SDF (lowest or all conformers) and MOL export. Keyboard: `?`.
  The server reads `<name>.molecule.json`; for an SDF the toolchain did not write it asks a long-lived
  `harness_rdkit.py serve` worker, so older workspaces get the same pane.
- `toolchain/setup.sh` — one venv with the pinned RDKit, numpy and pandas (`VERSIONS`) plus `npm ci`;
  `harness_rdkit.py` builds from SMILES, searches conformers (ETKDGv3 + MMFF94), describes the molecule
  (charges, groups, alerts, depiction, parent and change) and writes the SDFs, the depiction, the
  record, the series, the properties and the report; `verdict.py` judges Design / Embed / Review.
- `skills/rdkit/` — the RDKit skill (ours): SMILES and SMARTS, the helper API, scaffolds, analogue
  series, similarity, conformers, and the pitfalls. `template/` — ibuprofen, built in six lines.

## Credit and stewardship

RDKit is the RDKit contributors' work, led by Greg Landrum —
[rdkit/rdkit](https://github.com/rdkit/rdkit), BSD-3-Clause (`LICENSE-rdkit`) — and the pane is
[3Dmol.js](https://3dmol.csb.pitt.edu), David Koes and contributors at the University of Pittsburgh,
BSD-3-Clause (`LICENSE-3dmol`). Nothing of either is changed here: RDKit is installed from PyPI as
released and 3Dmol.js is loaded as they publish it on npm. This folder is the Harness wrapper —
the manifest, the pane server, a skill, the helper, the template, the verdict — written by Autonomous
to bring RDKit into Harness, on the project's behalf, to bootstrap the catalogue.

If you maintain RDKit or 3Dmol.js and want to own this package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in RDKit belong upstream, bugs in the
wrapper belong here, and a newer RDKit is a bump of `VERSIONS`.

Nothing in this package predicts activity, binding or safety. It computes what RDKit computes —
molecular weight, Crippen cLogP, TPSA, hydrogen-bond counts, Lipinski, QED, fingerprints, geometry —
and says so.

```sh
harness dsh check .                                # conformance
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without rdkit
```
