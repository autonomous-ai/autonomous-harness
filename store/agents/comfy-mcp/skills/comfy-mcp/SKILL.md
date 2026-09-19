---
name: comfy-mcp
description: Create and inspect generative media projects in the Comfy MCP Harness workspace, including its local starter and optional upstream integration.
---

# Variation garden

Read `studio.json` to understand the current controls; `"$STUDIO_TOOLCHAIN/../studio.config.json"`
describes their ranges. Run `"$STUDIO_TOOLCHAIN/run.sh" generate` to make a new result.
Successful artifacts and their measurements are in `out/runs/<id>/`; `out/latest.json` names the
current result. A failed run preserves the last success and records the error in the verdict.

The local starter creates deterministic procedural SVG artwork and a contact sheet. It is not diffusion or an AI-generated image claim. The native action submits the saved API workflow to an existing local ComfyUI, polls its result, and collects actual output images. The supplied native workflow uses no model and no paid API.

Use `"$STUDIO_TOOLCHAIN/../README.md"` for the integration contract and commands. Read the relevant
files under `$STUDIO_UPSTREAM` before using an upstream API. Keep controls within their documented
ranges, preserve the data needed to reproduce a comparison, and distinguish preview results from
native service or hardware output. The viewer supports history and artifact downloads; tell the
user which run contains the result, and what was actually measured.

## Grow a reproducible family

Choose a palette and seed, run `generate`, then inspect each study and its saved recipe.
The SVG hashes verify reproducibility. These local vector studies do not use a diffusion
model. Keep selected studies and their seed/parameters together when making a new family.

For an installed ComfyUI, read `$STUDIO_UPSTREAM/README.md` and its `src/` tools before
using the MCP workflow. Save API-format nodes in workspace `workflow.json`. The supplied
EmptyImage/SaveImage workflow needs no model weights. Run `comfy` against loopback
`COMFYUI_URL`, inspect its job history, and retain the returned PNGs. A timeout means the
remote queue may still be running; inspect it before resubmitting expensive work.
