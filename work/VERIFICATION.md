# Release verification — 2026-09-19

The final local release candidate passed the checks below. These are reproducible finite samples,
not a claim of complete product coverage. Tests ran against this worktree's artifacts and viewer.

## Automated model, package and server checks

**83 tests passed; zero failed or skipped.** This consists of 49 harness toolchain/manifest tests,
12 domain-model tests and 22 shared-viewer server/lifecycle tests.

```sh
node store/tools/build-experiences.mjs --check
node --test store/tools/experience-tests/models.test.mjs \
  store/agents/{voxel-worlds,generative-art,music-studio,creative-direction,drone-pilot,game-master,lab-bench}/test/*.test.mjs \
  store/viewers/web-viewer/test/*.test.mjs
```

Model sampling covers 100 seeds for art, brand, synthetic data, score events, finite arena matches
and autopilot flights; 16 complete audio renders; and 32 walkable voxel worlds. Checks include
finite geometry, legal movement, all-gate completion, match termination, exact same-seed score/PCM,
headroom, computed statistics, known fits, SVG escaping and corrupt world import rejection.
All seven generated `tools/check.mjs` programs also passed in independent copied workspaces with
three seeds each. Those check the pure model extracted from the actual HTML artifact.

All seven agent packages and the viewer conform to spec 1 (`harness dsh check`). Their setup and
doctor checks passed after local installation. Catalog validation passed with 44 packages; all
seven have a viewer dependency, example prompt and actual 1600 × 1000 output screenshot.
The new Experience checks workflow runs source-drift, model, package, server and catalog checks.

## Actual Chrome interactions

The browser suite passed all seven experiences plus a separate shared-viewer regression fixture.
The fixture verifies sibling fetch (`FETCH-OK`), localStorage, ES modules and missing-file recovery.
The user's original `/tmp/wv_ui/sandboxtest.cjs` also returned `ARTIFACT TITLE: FETCH-OK` against the
store viewer. Forms, audio, pointer lock and downloads are exercised by the experience checks.

| Experience | Verified user behavior |
|---|---|
| generative-art | manifest launch, pixel deterministic, different seeds, technique control, 1600×2000 PNG, seed survives reload, pause/resume file reload, 390px layout, no runtime errors |
| creative-direction | manifest launch, direction change, custom brand, palette lock, SVG and tokens, seed survives reload, pause/resume file reload, 390px layout, no runtime errors |
| lab-bench | manifest launch, cohort filters, statistics respond to effect, collection replay, filtered CSV, seed survives reload, pause/resume file reload, 390px layout, no runtime errors |
| music-studio | manifest launch, audio running, replay same PCM, step editing, WAV export, seed survives reload, pause/resume file reload, 390px layout, no runtime errors |
| game-master | manifest launch, step/rewind/scrub, finite outcome, 32-match tournament, replay export, seed survives reload, pause/resume file reload, 390px layout, no runtime errors |
| drone-pilot | manifest launch, autopilot motion, manual steering, telemetry export, reset, seed survives reload, pause/resume file reload, 390px layout, no runtime errors |
| voxel-worlds | manifest launch, pointer lock, walk and collide, break/place blocks, world save/restore, overview, seed survives reload, pause/resume file reload, 390px layout, no runtime errors |

The suite reads each real manifest, materializes a temporary workspace and expands its actual
viewer URL. Screenshots were visually inspected at desktop and 390px widths. It captures page
exceptions and checks exported PNG dimensions, WAV headers, SVG text, filtered CSV rows and JSON
payload contents. Store screenshots are generated from the live starter, not promotional mockups.

## Running Harness app

The optional `daemon.mjs` suite passed **all seven harnesses** through the real local daemon and
installed viewer. For each, it created an idle Claude session through the desktop WebSocket
protocol, waited for engine readiness, verified framework materialization and AGENTS instructions,
checked the exact nested artifact URL and not-ready initial verdict, opened it in Chrome, then
saved a revision and observed the painted new document. It deleted its own temporary session and
workspace in cleanup. No prompt was submitted; no inference output is represented as tested.

The seven agents and `autonomous/web-viewer` are locally linked to this isolated worktree for
immediate testing. Existing user workspaces are preserved. Start a new workspace to see a starter.

## Scope and limitations

- Browser verification used Chrome 153 on macOS, native graphics. Earlier development checks also
  exercised SwiftShader. Safari, Firefox, real touch devices and remote preview hosts were not tested.
- Audio verification covers running AudioContext, repeatable PCM, finite length, signal/headroom
  and WAV structure. It is not a human listening review or a claim about musical taste.
- Drone flight is an illustrative browser simulation; arena agents are deterministic heuristic
  policies; the lab's dataset is synthetic and its confidence interval is an approximate normal
  interval. Their interfaces state these distinctions.
- The viewer runs trusted workspace scripts with same-origin access. Its sandbox is not a security
  boundary from the shell; path/host/private-file protections remain tested at the server.
- Timings are local samples recorded in `PERFORMANCE.md`. Repeated seeded output on one machine
  does not establish identical graphics or audio on every device.

Portable commands, prerequisites and environment overrides are in
`store/tools/experience-tests/README.md`. Raw reports, screenshots and exports stay in ignored
`work/experience-evidence/`; the actual Store images are committed under `store/showcase/`.
