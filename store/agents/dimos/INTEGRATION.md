# A* navigation and MuJoCo dynamics

`simulate` creates an original rover/world MJCF, plans on an inflated obstacle grid, executes velocity controls in MuJoCo, and records positions, contacts and arrival. Viewer playback uses those positions. The `dimos` action only runs `dimos status` if that executable is available. The full pinned DimOS source and agent instructions are available under `upstream/`; its installer and perception extras are separate from the small local runtime.

## Verification scope

The local mission is actual MuJoCo simulation with no physical hardware. It is not a Unitree model or a claim of physical mission completion. MuJoCo 3.3.7 is pinned because it provides an Intel Mac wheel.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
