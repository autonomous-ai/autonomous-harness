# Performance: measured, near-zero, with headroom analysis

Measured against the **installed** web-viewer runtime (the same one the daemon runs) on this machine.

## Request latency (server, 200 warm requests each)
| Route | median | p95 | p99 |
|---|---|---|---|
| SHELL (/) | 0.54 ms | 2.05 ms | 4.88 ms |
| FILES (/files/sketch/index.html) | 1.56 ms | 4.06 ms | 5.12 ms |

Sub-millisecond median; all well under the 10ms "feels instant" bar. Server side is not a bottleneck.

## User-visible re-seed latency (write → pane starts new frame), real browser
5/5 writes detected; avg **106ms** (93–118ms).
- Bounded almost entirely by the watcher's 80ms debounce (batches rapid writes).
- Remainder (~26ms) is SSE change delivery + shell `reload()` + fresh `GET ?v=` + start of paint.
- Comfortably under the 100–200ms "instantaneous" interaction threshold.

## Hill-climb analysis
- No server-side hotspot: the viewer is a thin fs read + createReadStream pipe; requests are memory-bound.
- The one tuning lever is the 80ms debounce. Lowering to 40ms would shave ~40ms off re-seed feel but
  reduces write-burst coalescing; 80ms is a reasonable default and already <100ms perceived latency.
- If a harness needs tighter re-seed feel, the fix is per-harness debounce, not a server rewrite.

## How to re-measure
- `node /tmp/wv_ui/perf.cjs` — request latency.
- `node /tmp/wv_ui/re_seed_latency.cjs` — user-visible re-seed latency in real Chrome.
