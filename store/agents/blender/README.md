# Blender, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Blender](https://www.blender.org): describe an object, a scene, a shot in the chat pane; watch it
take shape in the 3D Viewer pane — modelled in Blender's Python, exported as glTF on every run and
shown as a live viewport (outliner, properties in mm, shading modes, measure, section, the scene
camera, the timeline), with the rendered turntable and still beside it — and get it as glTF or STL.
Runs on Claude Code.

- `harness.json` — engine, template, skill, toolchain, `viewer.use: autonomous/model-viewer`.
- `toolchain/setup.sh` — one venv with `bpy` (Blender as a Python module) at the pinned version
  (`BPY_VERSION`; the wheel needs Python 3.11 exactly); `harness_blender.py` gives a script the
  scene, camera, glTF export (names, collections, materials, camera, lights, animation and per-object
  facts as extras, written atomically), renders and report, and keeps `.harness/build.json` current
  while it runs; `verdict.py` judges what `out/` holds and names the glTF as the artifact.
- `skills/blender/` — the Blender skill (ours). `template/` — a mug, exported first, then rendered and turned.

## Credit and stewardship

Blender is the Blender Foundation's and its community's — [blender/blender](https://projects.blender.org/blender/blender),
GPL-2.0-or-later (`LICENSE-blender`); `bpy` is Blender itself, installed from PyPI as released.
Nothing of it is changed here. This folder is the Harness wrapper — the manifest, a skill, the
helper, the template, the verdict — written by Autonomous to bring Blender into Harness, on the
project's behalf, to bootstrap the catalogue. The wrapper's own files are MIT; scripts that import
`bpy` run under Blender's GPL terms, as every Blender add-on does.

If you maintain Blender and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Blender belong upstream, bugs in
the wrapper belong here, and a newer Blender is a bump of `BPY_VERSION`.

```sh
harness dsh check .                                # conformance
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without bpy
```
