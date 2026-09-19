# Bonsai MCP · House of ideas

Make room for a new idea. Shape a small building, inspect its spaces, and open the real IFC model anywhere.

![House of ideas running the local starter](screenshots/studio.png)

```sh
harness dsh install autonomous/bonsai-mcp
```

Open a workspace in Harness. Setup fetches upstream sources at the commit in `upstream.lock.json`,
installs a package-local Python 3.11 environment, and verifies the local tools. The starter runs
without credentials or a cloud account. Studio Viewer provides controls, history, downloads,
live agent updates, and failure recovery. Setup never edits an application's preferences.

## What runs here

The local workflow creates and reopens a real IFC4 building with IfcOpenShell, including storeys, slabs, walls, spaces and quantities. The in-pane drawing is a schematic model inspector. It does not certify structural adequacy or code compliance. Blender/Bonsai editing remains available through the pinned optional bridge.

Edit `studio.json`, then run:

```sh
"$STUDIO_TOOLCHAIN/run.sh" build  # Make this building
"$STUDIO_TOOLCHAIN/run.sh" bonsai  # Read Bonsai scene
```

The native command is optional and fails with a useful message when its external runtime is
unavailable. It never silently substitutes sample output. Use the upstream README in `upstream/`
for full native application setup. See `INTEGRATION.md` for the exact bridge and local test scope.

Every successful run owns a new folder under `out/runs/`, a `result.json` with parameters, engine,
source commit, timestamps, measured values, and downloadable artifacts. `.harness/verdict.json`
means the named artifact was produced, not that an engineering or aesthetic claim was certified.
The starter can be regenerated with no network after install.

## Development and testing

Install the shared viewer and this package with `harness dsh install <path> --link`.
`toolchain/doctor.sh` checks the local runtime. The repository's Studio Viewer browser suite
materializes temporary workspaces and exercises each shipped local workflow. Run it from
`store/viewers/studio-viewer` with `npm run test:browser`; exact results live in its `TESTING.md`.

## Credit and stewardship

[Bonsai MCP](https://github.com/Show2Instruct/bonsai-mcp) is maintained by Show2Instruct. Its sources are
fetched unchanged at `12cf135f6985cd042a6205c163bdfacdca23de3a`. Upstream licensing: MIT; IfcOpenShell LGPL-3.0.
The original license is preserved in `LICENSE-upstream`; dependency terms still apply.

OpenHarness contributors wrote the MIT wrapper, local starter, and viewer integration. This is
an independent integration, not an upstream endorsement. Upstream bugs belong with the upstream
project; wrapper bugs belong in OpenHarness. Maintainers are welcome to take over this package.
