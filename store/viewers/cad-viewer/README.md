# CAD Viewer, as a Harness viewer package

The 3D pane for CAD agents in [Harness](https://github.com/autonomous-ai/autonomous-harness):
Jake's **CAD Viewer** from [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad),
run from the `cadgen` release it ships in, unchanged. Any harness points at it with

```json
"viewer": { "use": "autonomous/cad-viewer" }
```

and gets the pane beside its terminal: STEP, GLB, glTF, STL, 3MF, DXF, URDF, SRDF and SDF, with
MoveIt2 inverse kinematics for robots. `?file=` follows the artifact the harness's verdict names.

This package is a viewer, not an agent: it has no engine, no workspace and no verdict, and it is
never a tile. It is installed once per machine and shared by every harness that uses it.

- `harness.json` — the manifest (spec 1.1, `kind: viewer`).
- `setup.sh` — one venv with the pinned `cadgen` (see `CADGEN_VERSION`); pulls OpenCascade.
- `doctor.sh` — can this machine run it.
- `viewer.sh` — `cadgen viewer --host 127.0.0.1 --port $HARNESS_VIEWER_PORT` in the workspace.

## Credit and stewardship

The CAD Viewer is Jake Fitzgerald's: part of `cadgen` from [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad), MIT, copyright 2026 Thompson Labs LLC (`LICENSE-cadgen`, `THIRD_PARTY_NOTICES.md`). Nothing of it is changed here.
This repository is the Harness wrapper — the manifest and three shell scripts — written by Autonomous to bring the CAD Viewer into
Harness. We did that work on the project's behalf, to bootstrap the catalogue; the credit for what
the agent can do belongs upstream.

If you maintain the CAD Viewer and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in the CAD Viewer belong upstream, bugs in the
wrapper belong here, and a newer release is a bump of `CADGEN_VERSION`.

```sh
harness dsh check .           # conformance
harness dsh install . --link  # this checkout as the installed viewer
```
