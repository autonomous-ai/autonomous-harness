# Harness V2 performance checks

Measured on 2026-09-12 with Apple M2 Max, macOS 26.6.2, Flutter 3.47.2 and Dart 3.13.2.

The explicit benchmark runs in the headless Flutter test runner with isolated synthetic sessions. It never opens a sample-data app or connects to a real agent. Run it from `desktop/`:

```bash
flutter test --no-pub --reporter expanded test/benchmarks/swarm_benchmark.dart
```

It prints `SWARM_BENCH` JSON records. Its filename deliberately does not end in `_test.dart`, so ordinary correctness runs do not include timing measurements.

## Recorded measurements

| Operation | Earlier median / p95 | After native/canvas polish median / p95 |
| --- | ---: | ---: |
| Search 2,000 agents across 8 machines | 1.06 / 1.13 ms | 1.16 / 1.34 ms |
| Group the same catalog into 50 projects | 1.14 / 1.27 ms | 1.31 / 1.52 ms |
| Switch tab and pump a frame: 4 swarms, 16 terminals | 18.45 / 25.88 ms | 24.32 / 31.76 ms |
| Switch tab and pump a frame: 12 swarms, 48 terminals | 14.51 / 16.95 ms | 19.40 / 22.14 ms |
| Decode and parse a 16 KiB ASCII output frame | 0.51 / 0.68 ms | 0.55 / 0.73 ms |
| Decode and parse a 16 KiB Unicode output frame | 0.31 / 0.35 ms | 0.34 / 0.43 ms |

That repetition followed the native/canvas polish while the workstation was in active use. All five benchmark cases passed and retained rebuild counts stayed at 1,491 and 1,625, but timings were higher across all workloads. This was not a controlled paired comparison, so it neither isolates a cause nor establishes unchanged user-visible performance. Preserve this result and measure under controlled load in the native release app; do not report only the faster earlier run. Its local log is `/private/tmp/harness-v2-benchmark-polish.log`.

Catalog operations use 20 warmups and 100 samples. Each terminal has 1,000 scrollback lines; the window is 1280 × 800 with four visible terminals. Tab checks warm up for three full cycles, then take 60 samples. They retain one renderer per session and include Flutter frame work and test-runner overhead. Network, persistence I/O, AppKit titlebar rendering and physical display latency are outside these measurements.

These are **debug CPU measurements**, not end-to-end input latency or release frame budgets. JIT warming and host load affect timings; the later 12-swarm case being faster does not establish that more tabs make the app faster. Use the structural counts below to assess the specific optimization.

The output checks call the production `TerminalSession.handleBinary` with 16 KiB packets that repeatedly repaint one row, keeping scrollback size fixed. Each uses 20 warmups and 100 samples. They include the normal frame queue, UTF-8 decoder and terminal parser, with transport callbacks isolated; they create no widgets and exclude painting. Run only these checks with `--plain-name 'terminal output CPU benchmark'`.

## Reduced work when switching tabs

Previously, switching between two swarms rebuilt headers, gestures and menus for terminals in every previously visited swarm. Hidden panes now retain their widget configuration as well as their renderer, with stable identities in the parked list. Session replacement updates a parked view; showing it applies current machine and agent metadata.

With 16 retained terminals, one switch went from **2,480 to 1,491 widget rebuilds**, a 40% reduction. With 48 retained terminals, it rebuilt 1,625 widgets. Background output continues reaching the session buffer. Regression checks cover renderer identity, hidden geometry, input ownership, selection, scroll position, renaming while hidden and session replacement.

Rapid navigation also coalesces pending arrangement writes. While the first write is in flight, only the latest subsequent snapshot is retained. Tests with 100 rapid tab changes verify that the first and final snapshots are written, including recovery after the first write fails. Normal quit waits for the final snapshot with a one-second bound for stalled storage.

Incoming binary data now skips unrelated sessions before awaiting the matching renderer queue. This removes one async scheduling turn per unrelated view from each frame's dispatch, while retaining socket FIFO, current stream identity and machine isolation. This change is verified by routing tests; the CPU table above does not measure network delivery.

## Terminal output allocations

Ordinary output packets now decode directly from their existing byte view. Previously every packet was copied into a joined list and copied again to select the decodable prefix. A joined buffer is still used when a UTF-8 character crosses packet boundaries, and the decoder reads a bounded range without copying that prefix. Malformed-byte replacement and terminal recovery behavior are unchanged.

In the paired headless checks, median decoding-and-parsing time fell from 0.683 to 0.514 ms for the ASCII workload and from 0.484 to 0.314 ms for Unicode. Corresponding p95 values were 1.088 to 0.680 ms and 0.686 to 0.348 ms. These measurements establish the benefit for these workloads; they do not measure user-visible latency or every terminal output pattern. Existing terminal-session regressions cover split UTF-8, compressed keyframes, parser sequences and recovery.

## Jump navigation

Cmd+P opens without a route transition or backdrop filter. Search normalizes a catalog once on opening and refreshes it on app-state changes; typing ranks that snapshot in memory without discovery, disk or network calls. List rows are built on demand. Recent-work history retains at most 64 string identities, not controllers or terminal buffers.

Existing-view activation is focus-only. It changes destination Swarm and pane focus in one notification, preserves its arrangement, and never retries or takes over the terminal. Selecting a Swarm preserves its saved focus and zoom. A fresh view is an explicit action, revalidated against current membership and the originally captured destination.

The continuation's headless debug run produced the following measurements in `/private/tmp/harness-v2-benchmark-jump.log`:

| Operation | Median | p95 |
| --- | ---: | ---: |
| Build jump catalog: 2,000 agents, 8 machines | 1.424 ms | 1.689 ms |
| Rank cached jump catalog for `agent 12 machine 3` | 1.059 ms | 1.154 ms |
| Welcome search: same 2,000 agents | 1.119 ms | 1.236 ms |
| Project grouping: 50 projects | 1.239 ms | 1.359 ms |
| Switch and pump: 4 Swarms / 16 terminals | 20.420 ms | 30.016 ms |
| Switch and pump: 12 Swarms / 48 terminals | 16.105 ms | 18.258 ms |
| Decode and parse: 16 KiB ASCII | 0.531 ms | 0.693 ms |
| Decode and parse: 16 KiB Unicode | 0.330 ms | 0.362 ms |

All five benchmark cases passed; retained rebuild counts remained 1,491 / 1,625. This repetition was not a controlled paired comparison with the prior run. The new search measurements establish CPU cost for that query and catalog, excluding widget layout, AppKit input and physical display. Correctness checks verify the first terminal key after a jump goes only to its destination, but they do not measure native keystroke latency.

## Native follow-up

The optimized real-data app builds and runs locally. The desktop is now unlocked, and native visual review is underway. The tab strip uses AppKit's compact unified title bar: the old right accessory was clipped to 32 points; the container now supplies 40 points and aligns controls with the system traffic lights.

The native check covers overflow, resizing, accessibility order and disabled actions. `bash tool/check_swarm_titlebar.sh /path/to/flutter --window-layout` adds actual container checks in a hidden window at three widths, for 170 assertions total. No Flutter engine, account or terminal is accessed.

Wallpaper is built only for the empty New swarm. Populated Swarms paint a flat color matching the selected native tab, and the disposed wallpaper evicts its own decoded cache entry. This removes wallpaper painting/cache retention from the active terminal canvas; no process-memory reduction has been measured yet.

Measure release input-to-display, focus, search, scrolling, layout and tab-switch latency before making user-visible performance claims. The first App Launch Instruments recording overlapped a stale Debug preview and is not a clean baseline. Native end-to-end timings and drag/overflow review remain in the development handoff; passing headless CPU checks does not establish zero latency.
