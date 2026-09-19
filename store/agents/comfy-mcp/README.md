# Comfy MCP · Variation garden

Follow a visual thread. Explore a family of forms, collect your favourites, and keep the recipe with every image.

![Variation garden running the local starter](screenshots/studio.png)

```sh
harness dsh install autonomous/comfy-mcp
```

Open a workspace in Harness. Setup fetches upstream sources at the commit in `upstream.lock.json`,
installs a package-local Python 3.11 environment, and verifies the local tools. The starter runs
without credentials or a cloud account. Studio Viewer provides controls, history, downloads,
live agent updates, and failure recovery. Setup never edits an application's preferences.

## What runs here

The local starter creates deterministic procedural SVG artwork and a contact sheet. It is not diffusion or an AI-generated image claim. The native action submits the saved API workflow to an existing local ComfyUI, polls its result, and collects actual output images. The supplied native workflow uses no model and no paid API.

Edit `studio.json`, then run:

```sh
"$STUDIO_TOOLCHAIN/run.sh" generate  # Grow variations
"$STUDIO_TOOLCHAIN/run.sh" comfy  # Run ComfyUI workflow
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

[Comfy MCP](https://github.com/Comfy-Org/comfy-mcp) is maintained by Comfy Org. Its sources are
fetched unchanged at `d067bf7dc44b497d88f20c9cd227c64f2ac3e2af`. Upstream licensing: AGPL-3.0-or-later or commercial; wrapper MIT.
The original license is preserved in `LICENSE-upstream`; dependency terms still apply.

OpenHarness contributors wrote the MIT wrapper, local starter, and viewer integration. This is
an independent integration, not an upstream endorsement. Upstream bugs belong with the upstream
project; wrapper bugs belong in OpenHarness. Maintainers are welcome to take over this package.
