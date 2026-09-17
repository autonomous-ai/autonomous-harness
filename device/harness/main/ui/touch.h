// CST9217 capacitive touch → LVGL pointer indev (enables tileview swipe).
#pragma once

#include <stdbool.h>
#include <stdint.h>

// Initialize I2C + CST9217 + register an LVGL pointer indev. Call after lv_init().
// Tolerant: logs and returns on failure (display still works, just no touch).
void touch_init(void);


// Monotonic generation bumped once for every physical touch press. Background rendering, voice, and
// programmatic display activity do not affect it, so callers can cheaply detect real user interaction.
uint32_t touch_activity_generation(void);

// What the heartbeat prints about touch (display.c, once a minute): whether the controller answers,
// how many presses the glass has seen, and how long ago the last one was. Cheap; no lock.
typedef struct {
    uint32_t presses;
    uint32_t last_press_ms_ago;
    uint32_t read_failures;
    uint32_t inferred_releases; // releases the chip never reported, declared from its silence
    bool     controller_ok;
    bool     held_now;         // a press has been down past the stuck threshold
} touch_stats_t;
void touch_stats(touch_stats_t *out);
