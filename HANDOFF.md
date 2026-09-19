# HANDOFF — Harness Store Voxel worktree

**Takeover session: read this first. All original research lives in `work/` (see below).**

## Where and what
- **Worktree:** `/private/tmp/harness-store-voxel` (isolated — do NOT touch `/Users/d/code/autonomous-harness` main checkout; other sessions work there)
- **Branch:** `codex/harness-store-voxel` — everything is **committed and working tree is clean**
- **Goal (Dee's `/goal`):** research cool things built on Claude/Codex, turn them into Harness-store harnesses, with the best possible viewers, at an extremely high quality bar: end-to-end tests, 100% coverage target, real browser/computer-use user testing, near-zero latency, simple intuitive UI, developer audience.

## Status: what is DONE
8 harnesses built, all conform to spec 1, all unit tests green (70/70 total):
| Harness | Marker (served under /files/) | Notes |
|---|---|---|
| autonomous/voxel-worlds | world/index.html | static, determinism 6/6 PERFECT (pre-existing) |
| autonomous/generative-art | sketch/index.html | commit 52fa9181 |
| autonomous/music-studio | piece/index.html | commit b2ace278 |
| autonomous/creative-direction | board/index.html | commit 94d8c462 (built by main session) |
| autonomous/drone-pilot | flight/index.html | commit b42a02e9 (bg subagent) |
| autonomous/game-master | game/index.html | commit 155da325 (bg subagent) |
| autonomous/lab-bench | bench/index.html | commit 718b7f7c (bg subagent) |
| autonomous/web-viewer (viewer) | — | **REWRITTEN** live-preview shell, commit 8048fda6 |

Toolchain: each harness has `toolchain/{setup.sh,doctor.sh,init-workspace.sh}`, `skills/`, `template/` (with marker), `test/*.test.mjs`, `harness.json`. Verdict path `.harness/verdict.json` drives the pane.

## Status: in-progress (where the last session stopped)
Closing the **real E2E** gap through the live Harness daemon/CLI. Just verified:
- `harness dsh install /private/tmp/harness-store-voxel/store/agents/generative-art --link` **SUCCEEDED**
  → `autonomous/generative-art` shows `installed (linked) @ 718b7f7c` in `harness dsh list`
  → its viewer dependency `autonomous/web-viewer` cloned to `/Users/d/.harness/dsh/autonomous/web-viewer/` and `harness dsh doctor` passed (`ok node v26.7.0`, setup+install done)
- **NEXT / NOT YET DONE:** launch the *actually-installed* runtime (viewer command per installed `harness.json`: `./viewer.sh`, url `http://127.0.0.1:${port}/?file=index.html`) and drive it in real Chrome — the full install → pane → live re-seed E2E. This is the main outstanding item.

## Testing already done (evidence)
- Unit: `(cd store/agents/<name> && node --test test/*.test.mjs)` → all green.
- Conformance: `harness dsh check store/agents/<name>` → conforms, no marker warnings.
- Viewer coverage: `node --test --experimental-test-coverage test/viewer.test.mjs test/process.test.mjs` → viewer.mjs **97.8% lines** (uncovered lines 30, 70).
- Latency (web-viewer, measured): SHELL median 0.38ms p95 1.00ms; FILES median 0.66ms p95 1.74ms → sub-millisecond.
- Real-browser smoke: `/tmp/wv_ui/browser_smoke.cjs` → all 7 marker files render in headless Chrome.
- Determinism: `/tmp/wv_ui/determinism.cjs` → voxel-worlds 6/6 identical screenshot hash; animated placeholders mismatch is a measurement artifact (rAF/setTimeout), not a defect.
- See also `/tmp/wv_ui/`: `grid.cjs` (seed-grid PNGs), `census.cjs` (generic census — unreliable blank-detection, superseded by grid+determinism).

## KNOWN PITFALLS / HARD LESSONS (do not relitigate)
1. **`init-workspace.sh` must NOT copy the template into the workspace** — the framework copies it. Copying flips the placeholder marker → verdict `ready:true` prematurely (music-studio hit this; fixed).
2. **`verdict.json` `ready` must be a JSON boolean** (`true`/`false`), not `1`/`0` (creative-direction hit this).
3. **`harness dsh install <path> --link` requires an ABSOLUTE path** (relative → `INVALID_SOURCE`).
4. **Chained `sleep` in Bash is blocked by policy** — use `Monitor` with an until-loop or `run_in_background`, not `sleep; cmd`.
5. **Do NOT `cp` marker files by hand in determinism/smoke scripts** — use a function-based runner (spaces in the `for spec` string broke it).
6. **Bash/Write classifier intermittently returns "DeepSeek-V4-Flash-0731 temporarily unavailable"** — retry after a short wait, or do read-only work (Read/Glob, Explore agent) until it clears.
7. **Robot-arm research is ALREADY covered** by existing `autonomous/mujoco` + `mujoco-viewer` — do NOT duplicate.

## Worktree ops
- Always commit in this worktree; attribution line for commits/PRs per CLAUDE.md (Co-Authored-By: Claude Code <noreply@anthropic.com>).
- Verify you are in the worktree (`git branch --show-current` → `codex/harness-store-voxel`) before committing.

## Reference facts for the runtime
- CLI: `harness dsh check|install|doctor|list`. Daemon running + logged in (`harness status` ok).
- web-viewer serves: shell `/`, files `/files/<path>`, SSE `/events`. Env `HARNESS_WORKSPACE` + `HARNESS_VIEWER_PORT`.
- Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (headless=new). playwright-core at `/tmp/wv_ui/node_modules/playwright-core` (require by absolute path).
- Viewer shell improvements (commit 8048fda6): status pill (live/dead/building), "Building…" overlay on 404, open-in-new-tab button, R-key reload, reduced-motion, safe-area.
