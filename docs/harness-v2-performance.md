# Harness V2 performance checks

Measured on 2026-09-12 with Apple M2 Max, macOS 26.6.2, Flutter 3.47.2 and Dart 3.13.2.

The explicit benchmark runs in the headless Flutter test runner with isolated synthetic sessions. It never opens a sample-data app or connects to a real agent. Run it from `desktop/`:

```bash
flutter test --no-pub --reporter expanded test/benchmarks/swarm_benchmark.dart
```

It prints `SWARM_BENCH` JSON records. Its filename deliberately does not end in `_test.dart`, so ordinary correctness runs do not include timing measurements.

## Current measurements

| Operation | Median CPU time | p95 CPU time |
| --- | ---: | ---: |
| Search 2,000 agents across 8 machines | 1.06 ms | 1.13 ms |
| Group the same catalog into 50 projects | 1.14 ms | 1.27 ms |
| Switch tab and pump a frame: 4 swarms, 16 terminals | 18.45 ms | 25.88 ms |
| Switch tab and pump a frame: 12 swarms, 48 terminals | 14.51 ms | 16.95 ms |
| Decode and parse a 16 KiB ASCII output frame | 0.51 ms | 0.68 ms |
| Decode and parse a 16 KiB Unicode output frame | 0.31 ms | 0.35 ms |

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

## Native follow-up

The optimized real-data app builds and runs locally. A separate windowless AppKit check covers tab overflow geometry, resizing, accessibility order and disabled actions (`bash tool/check_swarm_titlebar.sh`, with an optional Flutter SDK path). Measure release input-to-display and tab-switch latency in the unlocked native window before making latency claims. The screen was locked during this pass, so native end-to-end drag and visual inspection remain in the development handoff.
