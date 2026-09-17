#pragma once

#include <stddef.h>

// Install the global PSRAM-first cJSON allocator and initialize RAM counters.
// Call once at the very start of app_main(), before any cJSON use.
void ram_telemetry_init(void);

// Mark LVGL ready for safe lv_mem_monitor() snapshots. The display mutex must
// already exist and lv_init() plus all custom pools must have completed.
void ram_telemetry_set_lvgl_ready(void);

// Log internal 8-bit heap, PSRAM, LVGL, cJSON fallback, and current-task stack
// high-water data. Safe before LVGL is initialized.
void ram_telemetry_checkpoint(const char *tag);

// Periodic checkpoint. Every tenth call also records the known long-lived task
// stack high-water marks.
void ram_telemetry_periodic(const char *tag);

// PSRAM-only application allocations. They never silently consume internal RAM
// and record failures in the telemetry counters.
void *ram_psram_alloc(size_t bytes, const char *owner);
void *ram_psram_calloc(size_t count, size_t size, const char *owner);
void *ram_psram_realloc(void *ptr, size_t bytes, const char *owner);
char *ram_psram_strdup(const char *src, const char *owner);
