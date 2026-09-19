# Procedural local studies and optional ComfyUI execution

`generate` writes deterministic original SVG artwork and a recipe with file hashes. It makes no model/API calls. `comfy` submits `workflow.json` to loopback ComfyUI, checks rejection/execution/timeout states, and collects returned PNG files. The supplied workflow uses EmptyImage and SaveImage and needs no weights or paid nodes. Change the workflow to use models already installed in your own ComfyUI. The official MCP source is pinned in `upstream/`; its README documents the optional `comfy-mcp` and `comfy` CLI setup.

## Verification scope

Local procedural generation, gallery inspection, recipes and downloads form the offline acceptance path. An isolated ComfyUI protocol responder tests job handling and output collection; it is not a diffusion-model benchmark or a live ComfyUI installation.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
