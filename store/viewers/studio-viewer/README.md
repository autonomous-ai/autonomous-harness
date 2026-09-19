# Studio Viewer

A shared host for the eight specialist studios. Each harness supplies `studio.config.json`,
`view.mjs`, and `toolchain/run.sh`; the viewer provides bounded file access, live state,
validated controls, one running job at a time, cancellation, history, and artifact downloads.
It has no production npm dependencies. The package installs independently.

Run `./setup.sh`, then launch with `HARNESS_WORKSPACE`, `HARNESS_DSH_DIR`, and
`HARNESS_VIEWER_PORT`. `studio.json` belongs to the workspace; configurations and executable
code belong to the installed harness. A failed run preserves the previous successful result.
Run provenance is visible beside the output, including when a starter is a local simulation.

Development: `npm ci`, `npm test`, and `npm run test:browser`. See `TESTING.md` for the
coverage matrix and the difference between local workflows and external integrations.

## Credit and stewardship

OpenHarness contributors maintain this MIT-licensed viewer. Domain packages credit their
respective upstream authors. Bugs in this host belong in OpenHarness.

## Studios

Instrument maker, Wind tunnel, Research notebook, Loop room, Mission control, City lab,
House of ideas, and Variation garden each provide their own controls and artifact inspection.
The host supports live agent edits, safe draft conflict handling, immutable run history,
cancellation, keyboard controls, reduced motion, narrow panes, and byte-range audio playback
for the Mac webview. [Verification and coverage](TESTING.md) include real screenshots and
reproducible commands.
