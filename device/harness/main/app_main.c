// Harness dial — entry point and boot.
//
// Board: Waveshare ESP32-S3-Touch-AMOLED-1.75C.
//
//   BOOT ─▶ display ─▶ UI ─▶ USB cable link ─▶ the daemon's agent list ─▶ tileview
//
// There is ONE way in, and it is the cable. This firmware has no WiFi, no backend socket, no credential
// and nothing to pair: plugging the dial into a computer running the harness daemon IS the authorization,
// and everything the screen shows arrives over that wire.
//
// What that deleted, and why the boot is a dozen lines instead of a state machine: the SoftAP setup
// portal, the saved-networks walk, the cool-standby retry loop, SNTP, the REST pairing calls, the E2EE
// identity, the OTA download mode and the WS reconnect ladder all existed to get a device onto a network
// and prove who it was. A cable answers both questions by existing.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio_capture.h"
#include "audio_client.h"
#include "board_pins.h"
#include "cable_client.h"
#include "config_store.h"
#include "fw_update.h"
#include "last_words.h"
#include "board/board.h"
#include "board/board_probe.h"
#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ptt.h"
#include "ram_telemetry.h"
#include "ui/display.h"
#include "ui/touch.h"
#include "ui/ui_screens.h"

static const char *TAG = "app";

// Most agents one refresh handles. The link's own ceiling is CABLE_MAX_AGENTS; this is the scratch buffer
// that carries them from its cache into the UI.
#define MAX_PROJECTS CABLE_MAX_AGENTS

// ── boot button ─────────────────────────────────────────────────────────────────────────────────────

// BOOT (GPIO0) held at power-on = factory reset. All that is left to clear is the screen brightness and
// the voice language — the credentials this used to wipe do not exist any more.
static bool boot_button_held(void)
{
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << BSP_BOOT_BUTTON,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&io);
    // Two reads a moment apart: a single sample catches the pin mid-transition on a cold boot.
    if (gpio_get_level(BSP_BOOT_BUTTON) != 0) return false;
    vTaskDelay(pdMS_TO_TICKS(50));
    return gpio_get_level(BSP_BOOT_BUTTON) == 0;
}

// ── the agent list ──────────────────────────────────────────────────────────────────────────────────

// A hundred agents is too much for a task stack, and this is only ever touched by refresh_task, so one
// lazily-allocated PSRAM block is both cheaper and safer than a stack array.
static project_t *proj_scratch(void)
{
    static project_t *s_scratch;
    if (!s_scratch) s_scratch = heap_caps_calloc(MAX_PROJECTS, sizeof(project_t), MALLOC_CAP_SPIRAM);
    return s_scratch;
}

// Pull the agent list and (re)label the tiles.
//
// No RPC and no waiting: the list is whatever the daemon last pushed over the cable. That is what makes
// the old generation/staleness machinery unnecessary — there is no in-flight answer that can arrive after
// the question stopped mattering.
static int refresh_projects(void)
{
    project_t *pr = proj_scratch();
    if (!pr) { ESP_LOGW(TAG, "project scratch alloc failed"); return -1; }

    const int n = cable_client_list_agents(pr, MAX_PROJECTS);
    ESP_LOGI(TAG, "agents: %d", n);

    // Apply the WHOLE reconcile atomically. With the huge-range circular carousel each add/remove
    // re-anchors the scroll to keep the viewed agent centred; locking per ui_* call (as they do
    // internally) lets the LVGL task render between them and the viewed tile visibly wobbles.
    display_lock();

    for (int i = 0; i < n; i++) {
        ui_project_set_name(pr[i].id, pr[i].name);
        ui_project_set_engine(pr[i].id, pr[i].engine);
        ui_project_set_machine(pr[i].id, pr[i].machine_id, pr[i].machine);

        ui_project_reconcile_selected_model(pr[i].id, pr[i].selected_model);
    }

    // Reconcile removals from the end so ui_project_remove() can shift the model without requiring a
    // static snapshot of every current id.
    for (int i = ui_project_count() - 1; i >= 0; i--) {
        char current_id[ID_MAX];
        if (!ui_project_id_at(i, current_id, sizeof(current_id))) continue;
        bool present = false;
        for (int j = 0; j < n; j++) if (strcmp(current_id, pr[j].id) == 0) { present = true; break; }
        if (!present) {
            ESP_LOGI(TAG, "reconcile: removing stale tile %s", current_id);
            ui_project_remove(current_id);
        }
    }

    // Order LAST, inside the same lock-free window as the reconcile above: ui_project_set_name appends,
    // so without this the carousel keeps whatever order it first saw these agents in — which is not the
    // order the daemon sent, and not the order every other surface shows.
    static const char *ids[MAX_PROJECTS];
    for (int i = 0; i < n; i++) ids[i] = pr[i].id;

    display_unlock();

    if (n > 1) ui_project_apply_order(ids, n);
    // AFTER the order: the count names a PREFIX of the list, so it means nothing until the list is in
    // the order the daemon sent.
    ui_project_set_ring_count(cable_client_ring_count());

    // The list is built. If a landing is pending, LAND: drop the loading spinner and focus agent 1 (or the
    // No-agents page). No-op otherwise, so a periodic refresh never yanks the view.
    ui_land_after_reload();
    // ...and if the window asked for a specific agent while that agent was still off the carousel, land
    // THAT — it is a direct instruction and outranks the generic landing above. See ui_focus_project:
    // the daemon pushes the ring then the focus, but this task applies the ring a tick later, so the
    // focus arrives first by construction and has to wait here for the list it named.
    ui_apply_pending_focus();
    ram_telemetry_periodic("refresh");
    return n;
}

// ── the one background task ─────────────────────────────────────────────────────────────────────────

static void refresh_task(void *arg)
{
    (void)arg;
    ui_set_reload_waiter(xTaskGetCurrentTaskHandle());   // …so a pushed list wakes this instead of waiting
    refresh_projects();   // boot-time list: empty until the first push, which is the honest state to show
    while (1) {
        // WOKEN BY THE LIST, not merely polled for it. The second-long sleep is still the floor for the
        // periodic work below, but a list the daemon just pushed applies in milliseconds now. That delay
        // was not neutral: the daemon sends the ring and then the focus that lands on it, so every such
        // focus arrived at a carousel still holding the ring from before — which is the whole of "the
        // window moved to an agent and the dial stayed put". The hold in ui_focus_project makes that
        // correct; this makes it quick.
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(1000));

        // Chip and settings actions, tapped on the LVGL task and executed here off it.
        ui_service_model_picker();

        // A machine.select the daemon never answered. Drained here rather than on the LVGL task so the
        // bounce (spinner down, wheel back, toast) happens off the render path, like every other action.
        ui_tick_machine_select();

        // The daemon pushed a new list (or the session came up). Peek first so a reload requested mid
        // voice-upload is preserved and retried next tick rather than consumed while the mic is busy.
        if (ui_peek_agent_reload_req() && !audio_client_active() && ui_take_agent_reload_req()) {
            refresh_projects();
        }

        // Reap any "Working…" tile orphaned by a session drop that swallowed its turn-done. Only fires
        // after a re-converge grace, so a live turn is never cut short.
        ui_prune_stale_busy();
    }
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────

void app_main(void)
{
    ram_telemetry_checkpoint("boot");
    last_words_boot();   // before the first log line, so the previous boot's ring is read, not overwritten
    board_detect();      // which dial this is — the panel's reset pin comes from here, so before display_init
    config_store_init();

    if (boot_button_held()) {
        ESP_LOGW(TAG, "BOOT held — factory reset");
        config_clear_all();
    }

#ifdef BOARD_PROBE
    board_probe_run();   // bring-up only — see board/board_probe.c
#endif
    display_init();
    ui_init();
    ui_set_brightness(config_load_brightness());
    ram_telemetry_checkpoint("ui_ready");

    // Reserve the PSRAM voice buffer now, while the heap is still unfragmented — a large contiguous block
    // is hard to get later even with megabytes free.
    audio_client_init();
    ram_telemetry_checkpoint("voice_buffer_ready");

    // Voice: double-tap (or hold physical button B / GPIO0) captures and streams PCM over the cable.
    // Nothing to configure — the wire carries the identity, so voice needs neither a URL nor a token.
    ptt_start();

    // Speaker notify: beep on a finished turn. Init before the link so the beep task exists when the first
    // summary arrives.
    audio_notify_init();

    // Agents have not arrived yet — don't flash the "No agents" empty tile. Park on the loading screen and
    // arm a landing so refresh_projects slides to agent 0 once the first list lands.
    ui_enter_boot_loading();

    if (!cable_client_start()) {
        // A dial with no link still runs, still lights up, and still says so on screen. A device stuck in a
        // boot loop is not diagnosable from across the room; one showing "Not connected" is.
        ESP_LOGE(TAG, "cable link did not start — the dial will show no machine");
    }

    // If this boot is a freshly installed image, confirm it HERE and nowhere earlier — see fw_mark_valid.
    // Both things that make the dial fixable have now happened: it can draw, and the port is open so a
    // daemon can reach it to offer another image.
    fw_mark_valid();

    // Create the refresh task BEFORE the first tiles exist: tile creation fragments the remaining internal
    // heap enough that a contiguous stack allocation can fail afterwards, which would leave the carousel on
    // the loading spinner forever because nobody drains ui_request_agent_reload().
    BaseType_t rt_ok = xTaskCreate(refresh_task, "proj_refresh", 7168, NULL, 4, NULL);
    if (rt_ok != pdPASS) {
        ESP_LOGE(TAG, "refresh task create failed (%d), free_int=%u largest_int=%u; rebooting",
                 (int)rt_ok,
                 (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                 (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        vTaskDelay(pdMS_TO_TICKS(1000));
        esp_restart();
    }
    ram_telemetry_checkpoint("app_ready");
    vTaskDelete(NULL);
}
