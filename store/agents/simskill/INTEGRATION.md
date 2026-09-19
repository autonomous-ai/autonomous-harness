# Actual headless Eclipse SUMO traffic simulation

`simulate` builds an original intersection with `netconvert`, identifies the east/west phase from generated connection link indices, runs `sumo`, and parses floating-car and trip records. Delay statistics identify their completed-trip denominator and report unfinished trips. Intel macOS compiles pinned SUMO 1.27.1 with GUI and optional geo libraries disabled, using package-local Xerces 3.3.0. Other supported platforms use the pinned SUMO wheel.

## Verification scope

All animation positions come from SUMO vehicle traces. The local experiment is not a calibrated real-city forecast. The package includes the relevant upstream SimSkill procedures for building intersections and analyzing outputs.

The browser acceptance suite lives in `store/viewers/studio-viewer/test/studios.e2e.mjs`.
`TESTING.md` beside that viewer records commands, outcomes, screenshots and coverage.
Upstream source revisions are in `upstream.lock.json`; install-time Python dependencies are
hash-locked in `requirements.lock`. No user application configuration is written by setup.
