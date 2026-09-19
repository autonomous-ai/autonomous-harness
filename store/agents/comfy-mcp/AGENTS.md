# Comfy MCP workspace

This harness turns a request into a real, inspectable generative media artifact. Start with
the `comfy-mcp` skill. The editable project is `studio.json` plus files in this workspace.
The viewer follows `out/latest.json` and the run history; save small useful changes as you work.

Run `"$STUDIO_TOOLCHAIN/run.sh" generate` after a change. The runner validates controls,
records provenance, writes artifacts, and updates `.harness/verdict.json`. Do not hand-edit the
verdict to claim a run succeeded. Inspect the produced artifact before describing the result.

The local starter creates deterministic procedural SVG artwork and a contact sheet. It is not diffusion or an AI-generated image claim. The native action submits the saved API workflow to an existing local ComfyUI, polls its result, and collects actual output images. The supplied native workflow uses no model and no paid API.

The installed sources are at `$STUDIO_UPSTREAM`. Preserve upstream credit and use the pinned
instructions when extending the domain workflow. Local simulations are the default. Ask before
using a paid generation service or operating physical hardware unless the user already authorized it.

When developing this package itself, keep it independently installable from its folder; shared
runtime copies are synchronized by `store/tools/sync-studios.mjs` and `sync-runtimes.mjs`.
