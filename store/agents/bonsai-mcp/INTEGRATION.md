# Real IFC4 authoring and an optional Bonsai scene snapshot

`build` uses IfcOpenShell to create storeys, slabs, walls, window openings/fillings and spaces with quantities. It reopens `building.ifc` and reads its quantity sets to produce the CSV. The canvas is a schematic inspector; the IFC is the portable source artifact. `bonsai` imports the pinned `BlenderBridgeClient` and sends only `get_scene_info` to the local bridge.

## Verification scope

IFC creation and read-back work headlessly without Blender. The native scene snapshot has isolated local protocol tests; the Blender/Bonsai application itself is optional. Geometry is not a structural or code-compliance assessment.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
