# Measured preview performance

Measured 2026-09-19 on this macOS development machine, Chrome 153.0.8010.48, headless,
native graphics (AMD Radeon Pro 5500 XT through ANGLE Metal), Node 26.7.0.
These are local measurements, not cross-device performance guarantees.

| Experience | File request median | File request p95 | Save → ready + paint median | Maximum of 5 saves |
|---|---:|---:|---:|---:|
| generative-art | 2.46 ms | 2.87 ms | 216.5 ms | 231.9 ms |
| creative-direction | 2.39 ms | 4.48 ms | 217.2 ms | 219.5 ms |
| lab-bench | 1.91 ms | 8.87 ms | 218.3 ms | 233.7 ms |
| music-studio | 1.46 ms | 3.62 ms | 532.6 ms | 667.4 ms |
| game-master | 1.62 ms | 2.31 ms | 233.4 ms | 239.0 ms |
| drone-pilot | 2.85 ms | 4.91 ms | 231.6 ms | 233.4 ms |
| voxel-worlds | 3.09 ms | 5.08 ms | 233.9 ms | 252.8 ms |

## Method

`store/tools/experience-tests/performance.mjs` materializes each real template in a temporary
workspace and starts the checkout viewer. It makes 40 sequential artifact requests, discards the
first 10, and measures receipt of the full response body. It then saves five distinct document
revisions, waits for the changed iframe body to report ready, and waits two animation frames.
The timer starts immediately before each file write. Browser polling adds measurement overhead.

The watcher retains its 80 ms debounce. The remaining time includes fetching, parsing, generating
the experience and painting. Music includes rendering the complete audio buffer. Art drawing
batches paths and uses a reusable seeded grain texture; the voxel scene stops drawing when idle.

The earlier 106 ms number measured an iframe URL change, not a completed visible preview.
It is superseded here. The original software-rendered run exposed costly art drawing and idle
voxel redraws; native and software rendering timings are not directly comparable.

## Reproduce

Install the pinned browser-test dependency as described in
`store/tools/experience-tests/README.md`, then run:

```sh
node store/tools/experience-tests/performance.mjs
```

`BROWSER_EXECUTABLE` selects Chrome; `PLAYWRIGHT_MODULE` selects an existing Playwright Core
installation. `SOFTWARE_WEBGL=1` explicitly selects SwiftShader. Raw per-save samples are written
to `work/experience-evidence/performance.json` and intentionally stay out of source control.
