# Studio verification

Verified September 18, 2026 on this Intel Mac: macOS 26.6.2, Python 3.11.15,
Chrome 152.0.7977.83, and Playwright WebKit 26.0. Node 26.7.0 ran the main checks;
Node 22.23.2 ran WebKit. The user selected **this Mac and local simulations**.

All eight packages pass the complete local acceptance matrix. The
[machine-readable snapshot](verification.json) records the source commit, source hashes,
individual checks, and exact coverage denominators.

## Acceptance results

| Layer | Result |
| --- | --- |
| Chrome browser workflows | 8/8 studios; 136/136 workflow checks |
| WebKit browser workflows | 8/8 studios; 136/136 workflow checks |
| Harness linked-install lifecycle | 8/8 packages; 112/112 lifecycle checks |
| Clean sparse installation | Package and dependent viewer fetched from the pushed revision; real MIDI/WAV produced |
| Viewer recovery interactions | 14/14 checks |
| Optional native-result display contracts | 3/3 explicit rendering fixtures |
| Python artifact, source-fetch, and runtime tests | 41/41 tests |
| Viewer server and audition/export contracts | 16/16 tests |
| Original native C++ renderer | 9/9 executions, including all waveforms and error exits |
| Existing Store/catalog/manifest/materialization/viewer regressions | 249/249 tests |

Every browser row covers doctor, initialization, viewer, empty state, every visible control,
domain interactions, execution, all artifact downloads, a browser download, history,
pause/resume, concurrent agent edits, stale draft protection, reload, a 390-pixel layout,
reduced motion, and recovery from malformed project data. The lifecycle suite uses the real
Harness installer, materializer, skill discovery, verdict, viewer manager, run API, stop,
restoration, and removal with a disposable installed index. A separate clean sparse install
checks that a package and its viewer work outside this checkout.

Recovery tests exercise transient module failures, text controls, duplicate clicks, missing
history, failed jobs, cancellation failures, stopping a job, retries, and delayed polling.
Server tests include path/symlink confinement, local host/origin checks, validation, concurrent
submissions, forced termination, file limits, exact downloads, and HTTP byte ranges. WebKit's
real WAV playback verifies the range behavior required by the Mac rendering engine.

## Measured code coverage

These are enforced gates, not a count of checked boxes or a claim that every possible input
has been tested. No uncovered source lines or branches are suppressed to reach the thresholds.

| Instrumented first-party code | Lines or statements | Branches | Functions |
| --- | --- | --- | --- |
| Viewer server and music-pattern helper, c8 | 215/215 (100%) | 194/194 (100%) | 17/17 (100%) |
| All eight domain views and three shared browser modules, Chrome V8 | 307/307 (100%) | 536/536 (100%) | 68/68 (100%) |
| Eight Python workflows, editable training script, and two shared helpers, coverage.py | 690/690 (100%) | 216/216 (100%) | — |
| Original JUCE C++ starter, LLVM coverage | 45/45 (100%) | 28/28 (100%) | 3/3 (100%) |

The C++ renderer also covers 38/38 regions. The music helper appears in both independent
JavaScript reports; the rows are not added together. Identical package-local Python helper
copies are checked by `sync-studios.mjs --check` and counted once in the coverage denominator.
Browser coverage rejects stale source text and requires all eleven browser modules.

Upstream JUCE, SUMO, MuJoCo, IfcOpenShell, NumPy, application/model dependencies, Bash/CMake
installers, and the rest of Harness are outside these instrumented code denominators.
Installers are exercised by the real lifecycle tests. The reported 100% scope is the new
viewer, original workflow logic, shared Python helpers, and original C++ renderer.

## Local engines and external boundaries

| Package | Executed locally | Optional integration boundary |
| --- | --- | --- |
| JUCE Agent Toolkit | Python DSP; actual JUCE 9.0.2 compilation and WAV rendering | No VST3 host or DAW export claimed |
| Foam-Agent | Real D2Q9 flow solver for all three obstacle shapes | OpenFOAM adapter tested with isolated command fixtures; OpenFOAM/Docker not installed |
| autoresearch-mlx | NumPy model training, checkpoint validation, independent holdout evaluation | MLX requires Apple Silicon; platform/preparation/output contracts tested with fixtures |
| Ableton AI | MIDI/WAV generation and 432 audition/export parameter combinations | Pinned upstream socket client tested against an isolated responder; Ableton Live not launched |
| DimOS | Actual MuJoCo 3.3.7 dynamics, route planning, arrival and contact checks | Native CLI status contract tested; no physical robot or full perception stack |
| SimSkill | Native SUMO 1.27.1 and netconvert, real trip and vehicle trace records | Original intersection, without real-city calibration |
| Bonsai MCP | IfcOpenShell 0.8.5 IFC4 creation, geometry tessellation, quantity read-back | Pinned framed bridge client tested locally; Blender/Bonsai not launched |
| Comfy MCP | Deterministic SVG studies, recipes, hashes, gallery and exports | Local HTTP job/output/error contracts tested with a responder; no diffusion model run |

Native-result browser fixtures verify display contracts for JUCE, MLX, and ComfyUI. They are
explicit test fixtures, not generated evidence of live external applications. Browser checks
run standalone Chrome and WebKit plus Harness's real viewer manager; they do not drive the
packaged Flutter desktop application itself.

## Reproduce

Start at the repository root. The package setup scripts install managed runtimes and pinned
sources. Intel Mac SUMO setup compiles two headless tools on its first run; later runs reuse
the pinned build. Xcode Command Line Tools are needed for SUMO and native JUCE.

```sh
for studio_package in juce-agent-toolkit foam-agent autoresearch-mlx ableton-ai dimos simskill bonsai-mcp comfy-mcp; do
  "store/agents/$studio_package/toolchain/setup.sh"
done
cd store/viewers/studio-viewer
npm ci
uv pip install --python ../../agents/ableton-ai/.venv/bin/python \
  --target test-results/python-tools -r test/requirements.txt
```

Chrome must be installed. Install the test-only WebKit browser with Node 22 and
`node node_modules/playwright/cli.js install webkit`. Node 26 stalled during browser archive
extraction on this machine; using the managed Node 22 runtime completed the install.

```sh
npm run test:coverage
npm run test:browser
npm run test:ui
npm run test:result-views
npm run coverage:browser
npm run test:webkit

mkdir -p test-results/native-render-workspace
cp -R ../../agents/juce-agent-toolkit/template/. test-results/native-render-workspace/
STUDIO_NATIVE_JUCE_WORKSPACE="$PWD/test-results/native-render-workspace" npm run test:workflow-coverage
npm run test:native-coverage

cd ../../../cli
HARNESS_STUDIO_INTEGRATION=1 HARNESS_STUDIO_FRESH_INSTALL=1 \
  npx vitest run src/dsh/studios.integration.spec.ts
npx vitest run src/dsh/store.spec.ts src/dsh/catalogPublisher.spec.ts \
  src/dsh/manifest.spec.ts src/dsh/materialize.spec.ts src/dsh/viewer.spec.ts
```

The fresh-install check fetches the current commit from GitHub, so push it first. Override
`HARNESS_STUDIO_INSTALL_SOURCE` and `HARNESS_STUDIO_INSTALL_REF` to test another published
repository/revision. Omit `HARNESS_STUDIO_FRESH_INSTALL` to run only the eight linked lifecycle
cases. `STUDIO_TEST_PACKAGES` selects a comma-separated subset for development; the complete
coverage gates require all packages.

Raw coverage, browser reports, downloaded artifacts, native profiles, and screenshots go to
ignored `test-results/` and `coverage/` directories. Package `screenshots/` folders contain the
checked-in desktop and narrow captures. Temporary workspaces and installed indexes are removed
after the suites; no user application configuration or existing project is changed.

From the repository root, also run:

```sh
node store/tools/sync-runtimes.mjs --check
node store/tools/sync-studios.mjs --check
git diff --check
```
