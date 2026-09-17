# Manim, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Manim Community](https://www.manim.community): describe an explanation in the chat pane, watch it
animate in the Video Viewer pane as the scenes render. Runs on Claude Code.

- `harness.json` — engine, template, skill, toolchain, `viewer.use: autonomous/video-viewer`.
- `skills/manim/` — the Manim skill (ours): the library, the commands, the rules of a good scene.
- `toolchain/setup.sh` makes one venv with the pinned Manim (`MANIM_VERSION`); `doctor.sh` checks
  ffmpeg and LaTeX; `init-workspace.sh` renders the starter; `verdict.py` judges the newest render.
- `toolchain/render.py` is how the agent renders: `manim render` with `--media_dir out
  --save_sections`, plus `.harness/render.json` while it runs (scene, animation n of ~m, section,
  clips so far, the error and its line on failure) and `.harness/renders/<video>.json` when a scene
  lands (animations, sections, the clips before) — what the Video Viewer needs to play a render as it
  is made, show chapters, and mark what changed. It wraps a handful of Manim methods, each call
  through first, so a Manim it does not know still renders.
- `template/` — a fresh workspace with a starter scene.

## Credit and stewardship

Manim is the Manim Community's — [ManimCommunity/manim](https://github.com/ManimCommunity/manim),
MIT (`LICENSE-manim`), descended from Grant Sanderson's (3Blue1Brown) original. Nothing of it is
changed here; it is installed from PyPI as they release it. This folder is the Harness wrapper —
the manifest, a skill, the template, the toolchain and the verdict — written by Autonomous to bring
Manim into Harness. We did that work on the project's behalf, to bootstrap the catalogue.

If you maintain Manim and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Manim belong upstream, bugs in the
wrapper belong here, and a newer Manim is a bump of `MANIM_VERSION`.

```sh
harness dsh check .                                # conformance
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py toolchain/test_render.py   # verdict and wrapper, without manim
```
