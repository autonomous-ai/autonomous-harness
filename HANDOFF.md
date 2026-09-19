# Harness experience release handoff

Work in `/private/tmp/harness-store-voxel`, branch `codex/harness-store-voxel`.
The main checkout is shared with other sessions; leave it alone.

The branch now contains seven original, offline, editable experiences and an updated shared web
viewer. These replace the earlier placeholder artifacts. See [verification](work/VERIFICATION.md),
[performance](work/PERFORMANCE.md) and the [audit](work/REVIEW.md) for the evidence and its limits.

| Store harness | Starter | User capability |
|---|---|---|
| `autonomous/voxel-worlds` | Tidelands | Walk, build, explore, change daylight, save and restore an island |
| `autonomous/generative-art` | Fieldwork | Explore reproducible print editions and export large PNGs |
| `autonomous/music-studio` | Afterhours | Edit five tracks, arrange finite music and export a WAV |
| `autonomous/creative-direction` | Forme | Shape a coordinated identity and export SVG art and design tokens |
| `autonomous/drone-pilot` | Vector | Fly a canyon course, study the autopilot and export telemetry |
| `autonomous/game-master` | Relay | Compare strategies, replay matches and run a 32-map tournament |
| `autonomous/lab-bench` | Signal | Change a synthetic experiment, inspect statistics and export observations |

## Source and verification

Reviewable sources live in `store/tools/experiences/`. Run
`node store/tools/build-experiences.mjs` after source edits and `--check` to detect drift.
Generated template artifacts are self-contained HTML. Each installed workspace also has
`node tools/check.mjs --seeds 100`, which tests the model extracted from its actual edited HTML.
No runtime package install, remote model API, CDN or paid service is required for the starter.

Use `store/tools/experience-tests/README.md` for the model, browser, performance and running-daemon
checks. The old scripts in `work/` delegate to these portable checks. Raw screenshots/downloads
are ignored under `work/experience-evidence`; reviewed Store images live under `store/showcase`.

The iframe bug is fixed in `store/viewers/web-viewer/preview.html`: trusted workspace apps get
same-origin APIs, forms, downloads and pointer lock. The shell also preserves seeds, supports
paused automatic refresh, reports errors and recovers from a missing artifact. Scripts plus
same-origin access are **not an isolation boundary**; the viewer README states this explicitly.
The server still restricts hosts, paths, hidden files, symlinks and request methods.

## Installation and publishing

All seven agents and the viewer were installed with absolute `--link` paths to this worktree for
real daemon integration tests. New local workspaces use those files. Existing workspaces keep
what was already materialized; updating a package does not overwrite a person's artifact.

The user explicitly requested publication to the Harness Store. Publish through a reviewed
source diff/PR to `main`; the **Publish Store catalog** workflow writes the `store-catalog`
branch. Verify the live catalog's package refs, actual artifact bytes and screenshot URLs before
reporting publication complete. No additional user confirmation is required for this release.

Never repeat the earlier “100% browser coverage” or “106 ms painted preview” claims. The first
measured Node helpers; the second observed a URL change. Current checks cover finite samples and
actual browser controls, with measured save-to-ready-and-paint timings in the performance report.
