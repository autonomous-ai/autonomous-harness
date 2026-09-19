---
name: bonsai-mcp
description: Create and inspect architecture projects in the Bonsai MCP Harness workspace, including its local starter and optional upstream integration.
---

# House of ideas

Read `studio.json` to understand the current controls; `"$STUDIO_TOOLCHAIN/../studio.config.json"`
describes their ranges. Run `"$STUDIO_TOOLCHAIN/run.sh" build` to make a new result.
Successful artifacts and their measurements are in `out/runs/<id>/`; `out/latest.json` names the
current result. A failed run preserves the last success and records the error in the verdict.

The local workflow creates and reopens a real IFC4 building with IfcOpenShell, including storeys, slabs, walls, spaces and quantities. The in-pane drawing is a schematic model inspector. It does not certify structural adequacy or code compliance. Blender/Bonsai editing remains available through the pinned optional bridge.

Use `"$STUDIO_TOOLCHAIN/../README.md"` for the integration contract and commands. Read the relevant
files under `$STUDIO_UPSTREAM` before using an upstream API. Keep controls within their documented
ranges, preserve the data needed to reproduce a comparison, and distinguish preview results from
native service or hardware output. The viewer supports history and artifact downloads; tell the
user which run contains the result, and what was actually measured.

## Author and check building data

Choose the footprint, storeys, height, and room use, then run `build`. Reopen `building.ifc`
with IfcOpenShell, inspect spaces/walls/openings, and read the quantity sets. Match their
areas and volumes to `quantities.csv`. The canvas is a schematic view; IFC is the source
artifact for downstream editing. Preserve element identifiers when extending an existing model.

Read `$STUDIO_UPSTREAM/docs/examples.md` for Bonsai edits and read-back verification,
`docs/installation.md` for the bridge, and `docs/tools.md` before native commands. The
wrapper's `bonsai` action only requests scene information from an existing Blender session.
