# Blender, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Blender](https://www.blender.org): describe an object, a scene, a shot in the chat pane; watch it
take shape in the Video Viewer pane — modelled in Blender's Python, rendered headless, the turntable
playing on every run — and get it as glTF or STL. Runs on Claude Code.

- `harness.json` — engine, template, skill, toolchain, `viewer.use: autonomous/video-viewer`.
- `toolchain/setup.sh` — one venv with `bpy` (Blender as a Python module) at the pinned version
  (`BPY_VERSION`; the wheel needs Python 3.11 exactly); `harness_blender.py` gives a script the
  scene, camera, renders, exports and report; `verdict.py` judges what `out/` holds.
- `skills/blender/` — the Blender skill (ours). `template/` — a mug, built, rendered, turned, exported.

## Credit and stewardship

Blender is the Blender Foundation's and its community's — [blender/blender](https://projects.blender.org/blender/blender),
GPL-2.0-or-later (`LICENSE-blender`); `bpy` is Blender itself, installed from PyPI as released.
Nothing of it is changed here. This repository is the Harness wrapper — the manifest, a skill, the
helper, the template, the verdict — written by Autonomous to bring Blender into Harness, on the
project's behalf, to bootstrap the catalogue. The wrapper's own files are MIT; scripts that import
`bpy` run under Blender's GPL terms, as every Blender add-on does.

If you maintain Blender and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in Blender belong upstream, bugs in
the wrapper belong here, and a newer Blender is a bump of `BPY_VERSION`.

```sh
harness dsh check .                                # conformance
harness dsh install . --link                       # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without bpy
```
