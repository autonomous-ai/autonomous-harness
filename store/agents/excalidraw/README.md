# Excalidraw, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Excalidraw](https://excalidraw.com): describe a diagram in the chat pane, watch it appear
hand-drawn in the Excalidraw pane as the agent writes the `.excalidraw` file. Runs on Claude Code.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `viewer.mjs` — the pane: Excalidraw's editor in view mode, from the package's own `node_modules`
  (`@excalidraw/excalidraw` UMD build with React 18), no CDN, redrawn on every save.
- `toolchain/scene.py` — the helper the agent draws with: boxes, arrows bound at both ends, frames,
  notes, Excalidraw's palette; `verdict.py` validates the scene; `setup.sh` is `npm ci`.
- `skills/excalidraw/` — the Excalidraw skill (ours). `template/` — a starter diagram and its script.

## Credit and stewardship

Excalidraw is the Excalidraw team's — [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw),
MIT (`LICENSE-excalidraw`). Nothing of it is changed here; the pane loads the package as they publish
it. This repository is the Harness wrapper — the manifest, the pane server, a skill, the helper, the
verdict — written by Autonomous to bring Excalidraw into Harness, on the project's behalf, to
bootstrap the catalogue.

If you maintain Excalidraw and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in Excalidraw belong upstream, bugs in
the wrapper belong here, and a newer Excalidraw is a bump in `package.json`.

```sh
harness dsh check .                              # conformance
harness dsh install . --link                     # this checkout as the installed agent
python3 -m unittest toolchain/test_scene.py      # the helper and the verdict
```
