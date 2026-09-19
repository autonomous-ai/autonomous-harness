# Bonsai MCP workspace

This harness turns a request into a real, inspectable architecture artifact. Start with
the `bonsai-mcp` skill. The editable project is `studio.json` plus files in this workspace.
The viewer follows `out/latest.json` and the run history; save small useful changes as you work.

Run `"$STUDIO_TOOLCHAIN/run.sh" build` after a change. The runner validates controls,
records provenance, writes artifacts, and updates `.harness/verdict.json`. Do not hand-edit the
verdict to claim a run succeeded. Inspect the produced artifact before describing the result.

The local workflow creates and reopens a real IFC4 building with IfcOpenShell, including storeys, slabs, walls, spaces and quantities. The in-pane drawing is a schematic model inspector. It does not certify structural adequacy or code compliance. Blender/Bonsai editing remains available through the pinned optional bridge.

The installed sources are at `$STUDIO_UPSTREAM`. Preserve upstream credit and use the pinned
instructions when extending the domain workflow. Local simulations are the default. Ask before
using a paid generation service or operating physical hardware unless the user already authorized it.

When developing this package itself, keep it independently installable from its folder; shared
runtime copies are synchronized by `store/tools/sync-studios.mjs` and `sync-runtimes.mjs`.
