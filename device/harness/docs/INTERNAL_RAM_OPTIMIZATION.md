# Device Internal RAM Audit and Optimization

Status: selected scope implemented and hardware-validated with ESP-IDF 5.5.4
and firmware `0.1.67` on 2026-07-16. The final soak test is recorded in the
verification matrix below.

## Decision

The original device build was short on internal RAM because two large
reservations consumed almost all of the internal space available to the
application:

1. LVGL reserves a fixed 64 KiB internal pool at link time.
2. The normal display reserves 54,056 bytes of internal DMA memory at runtime.

The display buffers must remain internal. They are used by QSPI DMA, and the
current source records a watchdog failure when they shared PSRAM bandwidth with
voice recording. The primary fix is therefore to move most of the LVGL object
pool, not the display buffers, to PSRAM.

The implemented package is:

1. Fixed the `ui_project_clear_all()` pointer-sized `memset` before taking new
   heap measurements.
2. Kept an 8 KiB built-in LVGL pool, added a 64 KiB PSRAM pool immediately
   after `lv_init()`, and retained the existing internal DMA draw buffers.
3. Removed the 4,800-byte project reconcile snapshot and replaced the three
   static network-list arrays with direct NVS reads plus one transient PSRAM
   workspace.
4. Moved cJSON allocations and copied event-card text to PSRAM so large E2EE and
   `agents_list` frames do not create a second transient copy in internal RAM.
5. Measured task high-water marks before changing stack sizes. WebSocket,
   LVGL, and PTT remain unchanged. Refresh increased from 6 KiB to 7 KiB, main
   from 8 KiB to 10 KiB, and beep from 3 KiB to 4 KiB because hardware
   measurements did not meet the 25% plus 1 KiB free-stack gate at their old
   sizes.

The clean final linker map uses 138,479 bytes of DIRAM versus the 225,827-byte
baseline: an actual static recovery of 87,348 bytes (85.3 KiB). DIRAM BSS fell
from 111,224 to 23,424 bytes. This exceeds the original estimate without
reducing LVGL capacity, display draw buffers, normal WiFi/TCP settings, or
crypto limits.

The notification-tone split, outbound E2EE scratch rewrite, draw-buffer
reduction, WiFi tuning, and TCP-window reduction remain deliberately deferred.
They were not needed to meet the RAM gates and would expand the regression
surface.

### Hardware validation summary

| Scenario | Result |
| --- | --- |
| Normal remote-harness boot | E2EE ready, two agents loaded, `int_min=61,228`, largest internal block 31,744 B, effective LVGL pool 72,204 B at creation |
| Voice | 5-second and full 120-second captures passed; 1,923,840 B uploaded in 33.619 s; `int_min=62,964`; voice stack retained 1,916/6,144 B |
| Harness switch | Remote -> local loaded five agents; local -> remote rekeyed E2EE and loaded two agents; stale tiles were removed by backward reconciliation |
| Reconnect | Adapter stop/join and a no-PONG WebSocket destroy/recreate both recovered E2EE and the two-agent list without OOM |
| Completion | A real 1,898-byte frame emitted `done` then `summary`; busy closed and beep ran only for `done` |
| OTA | Dedicated updater used 6,524 B x2 draw buffers and 24/64 WiFi RX buffers; SHA/install/rollback confirmation passed; main retained 3,428/10,240 B |
| Allocator guards | `json_fb=0/0B` and `psram_fail=0/0B` throughout the completed hardware tests |
| Stress observation | 30 minutes produced 33 refreshes, 66 events, sleep/wake, harness changes, 15-agent loads, voice and repeated beeps; the exact final image then ran a further 10-refresh retest |

## Scope

This audit covers:

- All hand-written C and header files under `main/`.
- Generated fonts and icons by linker footprint, without reviewing generated
  glyph/image bodies line by line.
- Boot, provisioning, account pairing, normal harness operation, remote-harness
  E2EE, voice, reconnect, notification, screen-lock, and OTA boot modes.
- `sdkconfig.defaults`, the generated `sdkconfig`, component configuration,
  task creation, static objects, and explicit heap-capability allocations.

This document now combines the source/linker audit with serial traces from the
physical ESP32-S3 device. Provisioning and account-pairing scenarios that were
not rerun are called out explicitly in the verification matrix; they are not
implied by the RAM-focused tests.

## Baseline

Build command:

```bash
cd device/harness
source ~/esp/esp-idf/export.sh
idf.py -B build-arm build
idf.py -B build-arm size
```

The build completed successfully for ESP32-S3, firmware `0.1.67`.

| Static region | Used | Remaining | Total |
| --- | ---: | ---: | ---: |
| DIRAM | 225,827 B (66.08%) | 115,933 B | 341,760 B |
| DIRAM `.bss` | 111,224 B | - | - |
| DIRAM `.text` | 90,955 B | - | - |
| DIRAM `.data` | 23,648 B | - | - |
| IRAM | 16,384 B (100%) | 0 B | 16,384 B |

### Final linker result

| Static region | Baseline | Final | Delta |
| --- | ---: | ---: | ---: |
| DIRAM total used | 225,827 B | 138,479 B | -87,348 B |
| DIRAM `.bss` | 111,224 B | 23,424 B | -87,800 B |
| DIRAM `.text` | 90,955 B | 91,343 B | +388 B |
| DIRAM `.data` | 23,648 B | 23,712 B | +64 B |
| DIRAM remaining | 115,933 B | 203,281 B | +87,348 B |

The final flashed image is 2,550,035 bytes before binary padding; its 2,550,144
byte binary has SHA-256
`6ce8a16bde6162147f94a5bc707e7ea4efdc8fb25a38f9d2888d4a8debfdf250`.
The controlled OTA test installed the immediately preceding RAM build with
SHA-256 `1af84d6a67a269d18db14caabfd388aea61cf6d1bb874866e557ffe8db2d2206`;
the only subsequent runtime change was the measured beep-stack increase.

The final linker map contains 21,612 bytes of external BSS: 7,180 bytes are the
three selected UI models and 14,432 bytes are lwIP BSS sections that ESP-IDF
maps externally when `CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y`. This
SDK-supported lwIP placement accounts for the gain above the original estimate
and was exercised by the 120-second voice upload, reconnect, and OTA tests.

`idf.py size` is a link-time report, not runtime free heap. In the baseline,
the 115,933-byte DIRAM remainder still had to supply draw buffers, task stacks, WiFi/driver state,
queues, TLS/WebSocket state, cJSON trees, and allocator metadata.

The fully used 16 KiB IRAM row is not the same as exhausted byte-addressable
heap. Do not optimize that row as if it were normal internal DRAM.

### Largest baseline static owners

| Owner | Internal bytes | Evidence |
| --- | ---: | --- |
| LVGL archive | 66,124 | 66,044 B `.bss`, including the 65,536 B built-in pool |
| Device `main` archive | 27,144 | 27,111 B `.bss` |
| WiFi `libpp` | 19,150 | Mostly IRAM-placed code, not application arrays |
| FreeRTOS | 18,440 | Mostly IRAM-placed code |
| HAL | 16,248 | Mostly internal executable/data sections |
| SPI flash | 12,976 | Mostly internal executable/data sections |
| WiFi `net80211` | 12,423 | 7,619 B `.bss` plus internal code/data |

The baseline application code itself contributed no DIRAM `.text`; its
controllable static cost was predominantly BSS. Its largest BSS symbols were:

| Symbol | Bytes | Baseline purpose |
| --- | ---: | --- |
| `work_mem_int` | 65,536 | LVGL built-in TLSF pool |
| `s_tone` | 5,760 | Pre-rendered three-beep PCM |
| `refresh_projects.cur` | 4,800 | Agent ID reconcile snapshot |
| `s_q` | 4,460 | AskUserQuestion state |
| Three config arrays | 4,086 | `buf`, `cur`, and `next`, 1,362 B each |
| `s_notif` | 1,920 | Eight notification records |
| `s_harnesses` | 800 | Eight harness records |
| `s_peers` | 768 | Eight pinned E2EE peers |

These symbols total 88,130 bytes, or about 79% of all DIRAM BSS.

### Known runtime internal allocations

| Allocation | Baseline | Final | Lifetime | Required placement |
| --- | ---: | ---: | --- | --- |
| Two display draw buffers | 54,056 B | 54,056 B | Permanent | Internal + DMA |
| Main task stack | 8,192 B | 10,240 B | Boot and OTA orchestration | Internal |
| LVGL task stack | 16,384 B | 16,384 B | Permanent | Internal |
| WebSocket task stack | 12,288 B | 12,288 B | While client exists | Internal |
| Refresh task stack | 6,144 B | 7,168 B | Permanent | Internal |
| PTT task stack | 4,096 B | 4,096 B | Permanent | Internal |
| Beep task stack | 3,072 B | 4,096 B | Permanent | Internal |

The baseline application task-stack peak before `app_main` deletes itself was
50,176 bytes. Draw buffers plus those stacks totalled 104,232 bytes. Comparing
that with the 115,933-byte static remainder left only 11,701 bytes before
counting TCBs, system tasks, WiFi, drivers, queues, WebSocket state, or JSON.
This is not a literal runtime-free calculation, because allocation capability
and timing differ, but it explains the current contiguous-allocation failures
and the baseline reconnect sensitivity.

The final build intentionally spends 4,096 bytes of the 87,348-byte static gain
on measured stack safety. Its maximum application stack reservation is 54,272
bytes during main-task overlap, and the permanent internal application stacks
total 44,032 bytes after `app_main` exits. The voice task remains excluded
because its 6,144-byte stack is explicitly allocated in PSRAM.

### Existing PSRAM placement that should remain

- 2 MiB voice recording buffer, reserved before WiFi/TLS fragmentation.
- 6,144-byte voice task stack.
- `s_proj`: 100 project models at 280 bytes each, about 28 KiB.
- Project RPC scratch: 100 records at 88 bytes each, about 8.6 KiB.
- Lazy recent-state table: 100 records at 60 bytes each, about 5.9 KiB.
- 5.3 KiB UI event formatting scratch.
- WebSocket frame accumulator, capped at 64 KiB.
- E2EE ciphertext/plaintext buffers, capped at 16 KiB each.
- mbedTLS record allocations through `CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC=y`.
- WiFi/lwIP preference for PSRAM through
  `CONFIG_SPIRAM_TRY_ALLOCATE_WIFI_LWIP=y`.

## Behavioral Invariants

An internal-RAM change is acceptable only if all of these remain true:

1. The normal display's two QSPI DMA buffers stay internal. Do not move them to
   PSRAM.
2. Voice can capture for 120 seconds, upload over the existing commander
   socket, survive UI activity, and recover from a mid-upload disconnect.
3. A terminal `done` event clears busy state and beeps once; the following
   `summary` renders the recap without a second beep.
4. Remote harnesses still require the existing device-to-adapter E2EE pairing,
   hello/welcome, rekey, reconnect, and 16 KiB decrypt envelope.
5. Harness switching still defers `agents_list` until harness attachment and E2EE
   readiness, and reload requests are not consumed during voice upload.
6. Agent create, rename, delete, recent-summary restore, question answering,
   notification drawer, lock screen, and sleep/wake keep their current flow.
7. OTA remains a dedicated boot mode with smaller display buffers and larger
   WiFi RX settings. Do not merge OTA download back into normal operation.
8. The original 64 KiB effective LVGL capacity is not reduced. The implemented
   split provides about 72 KiB.
9. The 64 KiB TCP send/window configuration and normal WiFi buffers are not
   reduced until voice and reconnect tests provide evidence that it is safe.

## Findings

The findings below retain the baseline reasoning so future changes can be
reviewed against it. Each heading records the final implementation disposition.

### F0: Clear-all can corrupt the heap - fixed

`ui_project_clear_all()` frees each project's PSRAM strings and then calls:

```c
memset(s_proj, 0, sizeof(s_proj));
```

`s_proj` is a pointer, so only four bytes are cleared on ESP32-S3. The other
slots retain dangling `m_preview` and `m_full` pointers. Reusing one of those
slots can free an already-freed pointer and present as random fragmentation,
allocation failure, or a later crash.

The implementation now clears the full model allocation:

```c
memset(s_proj, 0, MAX_PROJECTS * sizeof(*s_proj));
```

The required PSRAM project-model allocation also fails explicitly instead of
falling back to a roughly 28 KiB general `calloc` that could consume internal
heap.

### F1: The LVGL pool is the largest controllable internal allocation - implemented

In the baseline, `CONFIG_LV_USE_BUILTIN_MALLOC=y` and
`CONFIG_LV_MEM_SIZE_KILOBYTES=64` produced a 65,536-byte static array in
`lv_mem_core_builtin.c`. Deleting LVGL objects returns blocks to that TLSF
pool; it does not return the pool itself to the ESP-IDF internal heap.

Consequently, `voice_overlay_set(true)` does not recover 64 KiB for the
WebSocket. It mostly reduces LVGL pool pressure and frees a small amount of
ordinary `strdup` data attached to event cards.

Implemented layout:

1. Set `CONFIG_LV_MEM_SIZE_KILOBYTES=8` in `sdkconfig.defaults`.
2. Immediately after `lv_init()`, allocate a 64 KiB block with
   `MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT`.
3. Add it with `lv_mem_add_pool()` before creating a display or any UI object.
4. Keep the PSRAM block for the lifetime of LVGL and fail boot clearly if it
   cannot be allocated or added.

This preserves the built-in LVGL TLSF allocator and gives it about 72 KiB
total capacity while recovering 57,344 static internal bytes. The remaining
8 KiB internal pool is a bootstrap/fast pool. If UI profiling shows excessive
PSRAM traffic, test a 16 KiB internal plus 64 KiB PSRAM split; it still saves
48 KiB.

Do not switch only to `LV_USE_CLIB_MALLOC`. With
`CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL=16384`, almost every small LVGL object
would still prefer internal RAM and would fragment the general heap.

### F2: The draw buffers are large but correctly placed - preserved

Normal mode uses 29 rows per buffer:

```text
466 pixels * 29 rows * 2 bytes * 2 buffers = 54,056 bytes
```

OTA mode uses seven rows per buffer, about 13,048 bytes total. The normal
buffers are explicitly internal and DMA-capable because PSRAM draw buffers
previously contended with voice access and stalled LVGL flushing.

Keep the current placement. If more headroom is still needed after moving the
LVGL pool, benchmark a smaller internal buffer height:

| Rows per buffer | Total bytes | Saving vs. current |
| ---: | ---: | ---: |
| 29 | 54,056 | 0 |
| 20 | 37,280 | 16,776 |
| 16 | 29,824 | 24,232 |

This is a performance tradeoff, not a first-line fix. Smaller buffers generate
more QSPI transactions and can reduce scroll/render throughput. Do not use a
PSRAM buffer as the experiment.

### F3: cJSON creates a large transient internal peak - implemented

The WebSocket accumulator and E2EE plaintext/ciphertext are in PSRAM, but
`cJSON_ParseWithLength()` reconstructs every node and copied string through
ordinary `malloc`. A cJSON node is 40 bytes on this target. Because the global
malloc threshold prefers internal memory below 16 KiB, the many small nodes,
keys, IDs, and names in an `agents_list` tree all land in internal RAM.

A 100-agent response can therefore hold a PSRAM input buffer and tens of KiB
of internal cJSON allocations at the same time. The same pattern occurs when
an encrypted frame is parsed as an envelope and then parsed again as decrypted
JSON.

`cJSON_Hooks` are now initialized before any task can call cJSON, with a
PSRAM-first allocator and standard `free`. Telemetry counts PSRAM allocation
failures and internal fallbacks; both remained zero in the completed hardware
tests.

The custom hooks disable cJSON's direct `realloc` optimization, so large print
operations may allocate/copy more than once. Those copies will be in PSRAM,
which is the correct tradeoff here. Measure CPU time for 100-agent responses.

Do not lower `CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL` globally as the first fix.
That changes allocation behavior for ESP-IDF and driver code, not just JSON.

### F4: Several static application buffers can be removed or moved - partially implemented

#### Agent reconcile snapshot

The baseline `refresh_projects()` kept `char cur[100][48]`, or 4,800 bytes, in
BSS. The final code iterates the current UI list backward and removes IDs absent
from the authoritative snapshot. Backward iteration is safe while removal
shifts the model and avoids both a large stack frame and static storage.

#### Saved-network work arrays

The baseline `config_store.c` held three six-entry arrays, 4,086 bytes total.
The implementation reads the NVS blob directly into caller output and uses one
transient PSRAM workspace only when reordering is required. No static network
workspace remains.

#### UI-only models

The following records are CPU-only and do not participate in DMA:

- `s_q`: 4,460 bytes.
- `s_notif`: 1,920 bytes.
- `s_harnesses`: 800 bytes.

`CONFIG_SPIRAM_ALLOW_BSS_SEG_EXTERNAL_MEMORY=y` is enabled and these selected
arrays use `EXT_RAM_BSS_ATTR`, recovering 7,180 static internal bytes. E2EE
identity/session keys remain internal.

#### Notification tone

`s_tone` permanently stores 5,760 bytes for 360 ms of audio. A low-risk first
step stores one 80 ms tone buffer and one 60 ms zero buffer, then writes them in
the existing three-tone sequence. That uses 2,240 bytes and saves 3,520 bytes.

Do not put the current whole tone buffer in PSRAM without validating the
I2S/codec write path. ESP32-S3 external-RAM DMA bandwidth has restrictions, and
the display path already demonstrated contention.

The notification tone was left unchanged because the implemented package
already exceeded the static-RAM target.

### F5: Ordinary string copies undermine PSRAM placement - implemented

The baseline `render_event_card()` used ordinary `strdup` for the card's full
text even though the project model already used a PSRAM-aware `dup_str()`.
With one card on each materialized tile and an active window of three tiles,
this could retain about 6.5 KiB of internal text, plus allocator overhead.

The final code uses the shared PSRAM helper for card user data and notification
row IDs and removes silent internal fallback for large PSRAM-designated
allocations:

- A failed WebSocket accumulator allocation must not fall back to as much as
  64 KiB of internal RAM. Drop the frame and reconnect instead.
- A failed 28 KiB project-model allocation should fail visibly, not consume
  internal RAM.
- Repeated event strings should remain PSRAM-only or be dropped/truncated on an
  impossible PSRAM-OOM condition.

The board and voice feature already require working 8 MiB PSRAM. Protecting
internal RAM is more reliable than trying to degrade into it silently.

### F6: E2EE output scratch has a fixed-size correctness limit - deferred

Inbound E2EE data already uses bounded PSRAM buffers. Outbound wrapping uses a
1,024-byte stack ciphertext buffer, while `add_b64()` uses a 512-byte stack
buffer. Current protected RPC payloads are small, but a future larger `message`
payload can overflow the ciphertext buffer or fail base64 encoding.

Before expanding protected outbound payloads, size both buffers from the
plaintext length (`plaintext + E2E_TAG` and exact base64 length), allocate them
in PSRAM, and preserve the current wire bytes. This removes roughly 1 KiB from
the sender's peak stack and fixes the hidden capacity limit. The crypto core
and golden wire vectors must remain unchanged.

### F7: Task stacks should be measured, then reduced - measured, no reductions

Current application stacks are deliberately internal except the voice task.
Broadly moving them to PSRAM is not recommended: PSRAM is inaccessible while
flash cache is disabled, and LVGL, drivers, NVS, and networking make those
tasks poor external-stack candidates.

Capture task handles and high-water marks under worst-case flows before trying
these candidates:

| Task | Baseline | Candidate before evidence | Potential saving |
| --- | ---: | ---: | ---: |
| PTT | 4,096 | 2,048 | 2,048 |
| Beep | 3,072 | 2,048 | 1,024 |
| Refresh | 6,144 | 5,120 | 1,024 |
| LVGL | 16,384 | 12,288 | 4,096 |
| WebSocket | 12,288 | Keep; test 10,240 last | 0 to 2,048 |

The WebSocket task runs cJSON and the complete CPace/Ed25519/X25519/E2EE path.
The source records a measured peak around 5.75 KiB and explicitly warns not to
drop below about 10 KiB. Leave it unchanged until maximum-size encrypted
frames, pairing, rekey, reconnect, and large harness responses have all run.

Require at least 25% unused stack and an absolute 1 KiB margin at the observed
worst point. Use the larger requirement for each task.

Hardware measurements required refresh to increase to 7,168 bytes and main to
increase to 10,240 bytes. Their observed minima are 2,640 bytes and 3,428 bytes
respectively. A later 66-event stress run drove the original 3,072-byte beep
task down to 688 bytes, so it increased to 4,096 bytes; the exact final image
retained 1,720 bytes after repeated full codec-open/beep paths. WebSocket
retained 6,784 bytes in the largest processed-frame path and voice retained
1,916 bytes. All final margins satisfy both gates; no stack was reduced.

| Task | Allocated | Worst observed free | Free margin |
| --- | ---: | ---: | ---: |
| Main (OTA) | 10,240 B | 3,428 B | 33.5% |
| LVGL | 16,384 B | 10,788 B | 65.8% |
| Refresh | 7,168 B | 2,640 B | 36.8% |
| PTT | 4,096 B | 2,720 B | 66.4% |
| Beep | 4,096 B | 1,720 B | 42.0% |
| WebSocket/E2EE | 12,288 B | 6,784 B | 55.2% |
| Voice (PSRAM stack) | 6,144 B | 1,916 B | 31.2% |

### F8: WiFi and lwIP are not the first tuning target - preserved

The large TCP send/window settings exist because the default buffers broke
continuous 32 KiB/s voice upload under WiFi jitter. mbedTLS and WiFi/lwIP are
already configured to prefer PSRAM.

Keep these initially:

- `CONFIG_LWIP_TCP_SND_BUF_DEFAULT=65534`.
- `CONFIG_LWIP_TCP_WND_DEFAULT=65534`.
- Normal static RX/TX buffer counts.
- Dedicated OTA `static_rx_buf_num=24`, `dynamic_rx_buf_num=64`, and BA window
  32.

Reducing `CONFIG_LWIP_MAX_SOCKETS=16` saves little relative to the risk across
provisioning, DNS, REST, SNTP, OTA, and reconnect overlap.

As a later A/B build, disabling only the WiFi IRAM optimizations may recover
part of the roughly 19 KiB of WiFi internal executable code. Accept it only if
voice upload, reconnect time, and OTA throughput remain within their current
behavior. Do not move core FreeRTOS, flash, timer, or ISR-safe code out of IRAM.

### F9: Comments disagreed with the implementation - fixed

Before this work, several comments described old memory behavior:

- `sdkconfig.defaults` and `display.h` say draw buffers live in PSRAM, while
  `display.c` correctly allocates them from internal DMA RAM.
- `display.c` calls each buffer one-eighth of a screen; each buffer is actually
  29/466, approximately one-sixteenth. Both buffers together are one-eighth.
- `commander_client.h` says the project array is internal and capped at 10/16;
  it is now a 100-entry PSRAM allocation.
- `ui_init()` calls the project array roughly 2 KiB; it is about 28 KiB.
- Some stack comments still say refresh is 8 KiB or WebSocket is 16 KiB; the
  current values are 6,144 and 12,288 bytes.

The touched comments now describe the implemented allocation and stack sizes.
Keeping them aligned prevents a later cleanup from reversing an intentional
safety decision.

## Implementation Record

### Completed: correctness and measurement

1. Fixed the pointer-sized project clear.
2. Added one reusable RAM checkpoint that logs:
   - Free, minimum-free, and largest block for
     `MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT`.
   - Free and largest PSRAM block.
   - LVGL total/free/largest/fragmentation from `lv_mem_monitor()`.
3. Logged task high-water marks for LVGL, refresh, PTT, beep, voice-before-delete,
   and the WebSocket after pairing and maximum-frame processing.
4. Recorded checkpoints after display init, UI init, voice buffer reservation,
   WiFi, WebSocket/E2EE ready, harness refresh, voice start/send/end, reconnect,
   and OTA WiFi init.

Use `MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT`, not only
`MALLOC_CAP_INTERNAL`, for application heap decisions. Stacks, JSON nodes, and
ordinary strings require byte-addressable memory; a broader metric can include
internal memory they cannot use.

### Completed: high-value structural changes

1. Added the hybrid LVGL pool: 8 KiB internal plus 64 KiB PSRAM.
2. Removed `refresh_projects.cur` by backward reconciliation.
3. Replaced static network-list storage with direct reads and one transient
   PSRAM workspace.
4. Moved event-card and notification user-data strings through the PSRAM helper.
5. Removed dangerous large internal fallbacks.

Together with targeted external-BSS placement, the completed structural changes
recovered 87,348 static DIRAM bytes and moved event-card text out of internal
heap.

### Mixed: targeted dynamic and model placement

1. PSRAM-first cJSON hooks are installed and instrumented.
2. `s_q`, `s_notif`, and `s_harnesses` are in external BSS.
3. The beep tone/gap split is deferred.
4. Size-aware outbound E2EE ciphertext/base64 scratch is deferred.

The completed cJSON change is payload-dependent at runtime. Hardware telemetry
showed zero internal fallback while processing harness, E2EE, completion, and
voice flows.

### Deferred: evidence-only tuning

1. Reduce task stacks one at a time from measured high-water marks.
2. If needed, test 20-row and then 16-row internal draw buffers.
3. Only then A/B test WiFi IRAM optimization or the global malloc threshold.

No Phase 3 reduction was needed. Hardware evidence instead required refresh
to increase from 6,144 to 7,168 bytes, main from 8,192 to 10,240 bytes, and beep
from 3,072 to 4,096 bytes. Keep any future experiment in a separate build so
its size and runtime delta can be reverted independently.

## Rejected Shortcuts

- Move display draw buffers to PSRAM: rejected due DMA bandwidth contention and
  an existing LVGL watchdog failure.
- Reduce the 64 KiB LVGL pool without adding external capacity: rejected due
  current UI complexity and prior pool-fragmentation failures.
- Use libc malloc for LVGL without targeted hooks: rejected because small
  allocations still prefer internal RAM.
- Move all FreeRTOS stacks to PSRAM: rejected because cache-disabled paths and
  driver/NVS calls make this unsafe.
- Reduce TCP/WiFi buffers first: rejected because those settings protect voice
  upload and OTA throughput.
- Lower the 16 KiB malloc threshold globally first: rejected because it changes
  unrelated ESP-IDF and driver allocations.
- Move E2EE session/identity state to PSRAM: rejected because the saving is
  small and the state is hot and security-sensitive.
- Treat generated fonts as internal-RAM waste: rejected; their large footprint
  is flash/rodata, not the current internal BSS bottleneck.

## Verification Matrix

The original matrix is broader than the selected RAM package. The table records
what was exercised in this run instead of treating unexecuted neighboring flows
as implicitly passed.

| Area | Status | Evidence / remaining scope |
| --- | --- | --- |
| Build | Pass | Clean ESP-IDF 5.5.4 build, final size/linker report, binary SHA, and `git diff --check` |
| Normal boot | Pass | Saved WiFi/token/harness, WS connect, E2EE ready, two-agent refresh, zero allocator failures |
| Provisioning | Not rerun | Empty-NVS SoftAP and captive-form behavior were outside the selected test path |
| Account pairing | Not rerun | Token expiry/rotation and revoked-token recovery were outside the selected test path |
| Local harness | Partial pass | Selected real local harness and loaded five agents; 0/1/100-agent and CRUD permutations were not rerun |
| Remote harness | Partial pass | Existing pair, hello/welcome, rekey, adapter restart, no-PONG reconnect, and E2EE restore passed; fresh-pair/cancel/revoke permutations were not rerun |
| Harness switching | Pass for idle path | Remote -> local -> remote preserved generation gating and re-established E2EE; switching during voice was not rerun |
| UI stress | Targeted pass | Harness navigation and a long real recap rendered; full carousel/settings/lock/sleep stress was not rerun |
| Questions | Not rerun | Question-answer permutations were outside the selected RAM path |
| Voice | Pass for selected path | 5-second and 120-second capture/upload passed; forced disconnect mid-upload was not rerun |
| Completion | Pass | `done` cleared busy and beeped once; following `summary` rendered without a second beep |
| Reconnect | Pass | Adapter stop/join and WebSocket no-PONG destroy/recreate both recovered without OOM |
| OTA | Pass | Dedicated boot, 24/64 RX buffers, progress, exact SHA, slot switch, reboot, and rollback confirmation |
| Soak | Accepted with limitation | A 30-minute stress run plus a 10-refresh exact-final retest passed; the original eight-hour target was stopped by user decision after the stack issue found during stress was fixed and revalidated |

### RAM acceptance gates

1. No allocation-failure, stack-overflow, watchdog, illegal-cache, or heap
   corruption diagnostics.
2. The final linker map recovers at least 63 KiB static DIRAM relative to this
   baseline.
3. LVGL reports at least the original 64 KiB total pool; the implemented split
   should report about 72 KiB.
4. The largest byte-addressable internal block remains at least 16 KiB at every
   checkpoint, with 24 KiB or more as the preferred steady/voice target. A
   reconnect must be able to recreate the 12 KiB WebSocket task stack.
5. Minimum free byte-addressable internal RAM remains at least 32 KiB in the
   final stress run. If the current hardware baseline is lower, use the measured
   Phase 1 delta first and ratify a threshold before stack tuning.
6. No cJSON or large-buffer allocation falls back from PSRAM to internal during
   normal tests.
7. Every task retains at least 25% and 1 KiB unused stack at its worst observed
   point; the larger margin wins.
8. Voice throughput, UI frame behavior, E2EE latency, reconnect time, and OTA
   throughput do not regress outside their current observed range.

## Expected Outcome

The implemented package recovered 87,348 bytes (85.3 KiB) of static internal
RAM without reducing UI capacity, networking buffers, E2EE limits, or DMA draw
buffers. It also moved the main large-frame transient allocator and selected UI
models to PSRAM.

The measured result is larger than the original estimate and avoided shrinking
WiFi, TCP, crypto, or DMA resources. Stack and draw-buffer reductions remain
optional follow-up work driven by future hardware measurements, not
assumptions.
