#include "display.h"
#include <stdlib.h>
#include "touch.h"
#include "ui_screens.h"
#include "board_pins.h"
#include "board.h"
#include "ram_telemetry.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_co5300.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "lvgl.h"

// CO5300 power-on / init register sequence, taken verbatim from Waveshare's
// official BSP (bsp/esp32_s3_touch_amoled_1_75). The leading 0xFE/0x19/0x1C
// block is what was missing before — without it the panel never lights up.
static const co5300_lcd_init_cmd_t s_co5300_init_cmds[] = {
    {0xFE, (uint8_t[]){0x20}, 1, 0},
    {0x19, (uint8_t[]){0x10}, 1, 0},
    {0x1C, (uint8_t[]){0xA0}, 1, 0},
    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},   // 16bpp RGB565
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},   // panel at native max — perceived brightness is dimmed in software (ui_set_brightness overlay)
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x06, 0x01, 0xD7}, 4, 0},   // col 6..471
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xD1}, 4, 600}, // row 0..465
    {0x11, NULL, 0, 600},              // sleep out
    {0x29, NULL, 0, 0},                // display on
};

static const char *TAG = "display";

static esp_lcd_panel_handle_t s_panel;
static esp_lcd_panel_io_handle_t s_io;   // kept so brightness (DCS 0x51) can be re-sent at runtime
static lv_display_t *s_disp;
static SemaphoreHandle_t s_lvgl_mutex;
static bool s_asleep;                   // panel turned off after idle to save battery
static void *s_lvgl_psram_pool;          // lifetime-owned 64KiB secondary LVGL TLSF pool

// Turn the panel off after this long without a touch. Wake with a double-tap (see touch.c).
#define IDLE_MS 300000                  // 5 minutes

// LVGL draw buffers in internal DMA RAM: each is about 1/16 screen,
// double-buffered for about 1/8 screen total.
// NOTE: in LVGL v9, sizeof(lv_color_t) is NOT the pixel byte size — for RGB565
// each pixel is 2 bytes regardless. Size buffers explicitly by bytes-per-pixel.
#define DRAW_LINES   (BSP_LCD_V_RES / 16)   // smaller so both draw buffers fit in internal DMA RAM
#define BYTES_PER_PX (BSP_LCD_BIT_PER_PIXEL / 8)   // RGB565 -> 2
static uint8_t *s_buf1;
static uint8_t *s_buf2;

// esp_lcd "color trans done" → tell LVGL the flush finished. Uses the global
// display handle (the callback fires only after s_disp is created and rendering
// has started, so it is always valid by then).
static bool on_color_done(esp_lcd_panel_io_handle_t io, esp_lcd_panel_io_event_data_t *e, void *ctx)
{
    if (s_disp) lv_display_flush_ready(s_disp);
    return false;
}

// LVGL flush callback → push the rendered area to the CO5300. The SW renderer already emits big-endian
// RGB565 (display color format = RGB565_SWAPPED), so no per-pixel swap here — just DMA the area out.
static void lvgl_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px)
{
    // Asleep: the panel is off — don't push pixels (events still update the offscreen tree and are
    // shown on wake). Ack immediately so LVGL doesn't block waiting for the (skipped) DMA done.
    if (s_asleep) { lv_display_flush_ready(disp); return; }
    esp_lcd_panel_draw_bitmap(s_panel, area->x1, area->y1, area->x2 + 1, area->y2 + 1, px);
}

// LVGL needs a millisecond tick.
static void tick_cb(void *arg) { lv_tick_inc(2); }

// ── liveness ────────────────────────────────────────────────────────────────────────────────────────
// One line a minute from THIS task. Its presence says the UI task is turning; its absence, while the
// cable's own lines carry on, is the one signature of a wedged LVGL task there is — the daemon marks the
// gap in the dial's log on its side. The figures beside it are the ones a stuck report asks for first:
// heap, LVGL's pool, and whether touch is alive.
#define HEARTBEAT_MS 60000

static void heartbeat(void)
{
    static uint32_t last;
    if (last && lv_tick_elaps(last) < HEARTBEAT_MS) return;
    last = lv_tick_get();
    touch_stats_t t;
    touch_stats(&t);
    lv_mem_monitor_t m;
    lv_mem_monitor(&m);
    ESP_LOGI(TAG, "alive up=%lus heap=%u/%u psram=%u lv=%u%%used frag=%u%% touches=%lu last_press=%lus%s%s%s%s",
             (unsigned long)(lv_tick_get() / 1000),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned)m.used_pct, (unsigned)m.frag_pct,
             (unsigned long)t.presses, (unsigned long)(t.last_press_ms_ago / 1000),
             t.controller_ok ? "" : " TOUCH-DEAD",
             t.read_failures ? " read-fails" : "",
             t.inferred_releases ? " inferred-releases" : "",
             t.held_now ? " PRESS-HELD" : "");
}

static void lvgl_task(void *arg)
{
    // Under the task watchdog: a UI task that stops turning used to be a frozen glass with nothing to
    // read; now it is a reboot whose reason and last log lines come back over the cable (last_words.c).
    esp_task_wdt_add(NULL);
    while (1) {
        esp_task_wdt_reset();
        display_lock();
        uint32_t next = lv_timer_handler();
        heartbeat();
        ui_log_state_if_changed();
        // Idle → turn the panel off to save battery. LVGL resets the inactivity timer on every real
        // touch (indev read), so this fires only after IDLE_MS with no touch. Fires REGARDLESS of charging
        // (user wants it to off even while plugged in); plugging in still wakes once (ui_screens tick) and
        // a whole voice turn is kept awake via display_bump_activity. Double-tap/PWR key wake it back.
        if (!s_asleep && lv_display_get_inactive_time(s_disp) > IDLE_MS) display_sleep();
        display_unlock();
        // Keep a responsive loop even while asleep: touch_read (the double-tap-to-wake detector) is the
        // indev read that runs inside lv_timer_handler, so slowing this loop down slows touch sampling —
        // a 120ms loop made quick taps land between samples and wake took several tries. The wasted
        // spinner rendering while the panel is off is instead killed by PAUSING the display refresh timer
        // in display_sleep() (touch keeps sampling; nothing re-renders).
        if (next > 20) next = 20;
        vTaskDelay(pdMS_TO_TICKS(next < 2 ? 2 : next));
    }
}

// CO5300 addresses pixels in 2px units, so partial-update areas must start on an
// even coordinate and end on an odd one (matches Waveshare's BSP rounder).
static void rounder_cb(lv_event_t *e)
{
    lv_area_t *area = lv_event_get_param(e);
    area->x1 = (area->x1 >> 1) << 1;
    area->y1 = (area->y1 >> 1) << 1;
    area->x2 = ((area->x2 >> 1) << 1) + 1;
    area->y2 = ((area->y2 >> 1) << 1) + 1;
}

static void panel_bringup(void)
{
    // QSPI bus + IO using the CO5300 driver's config macros (4 data lines).
    const spi_bus_config_t bus = CO5300_PANEL_BUS_QSPI_CONFIG(
        BSP_LCD_QSPI_SCLK, BSP_LCD_QSPI_D0, BSP_LCD_QSPI_D1, BSP_LCD_QSPI_D2, BSP_LCD_QSPI_D3,
        BSP_LCD_H_RES * BSP_LCD_V_RES * BYTES_PER_PX);
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t io;
    esp_lcd_panel_io_spi_config_t io_cfg = CO5300_PANEL_IO_QSPI_CONFIG(BSP_LCD_QSPI_CS, on_color_done, NULL);
    io_cfg.trans_queue_depth = 10;
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(SPI2_HOST, &io_cfg, &io));
    s_io = io;   // stash for display_set_brightness()

    co5300_vendor_config_t vendor = {
        .init_cmds = s_co5300_init_cmds,
        .init_cmds_size = sizeof(s_co5300_init_cmds) / sizeof(s_co5300_init_cmds[0]),
        .flags = { .use_qspi_interface = 1 },
    };
    esp_lcd_panel_dev_config_t pcfg = {
        .reset_gpio_num = board()->lcd_rst,   // differs between the two dials — see board.h
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = BSP_LCD_BIT_PER_PIXEL,
        .vendor_config = &vendor,
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_co5300(io, &pcfg, &s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(s_panel, 0x06, 0));  // 6px column offset
    ESP_ERROR_CHECK(esp_lcd_panel_reset(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(s_panel));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(s_panel, true));
}

// Re-send the CO5300 "Write Display Brightness" (DCS 0x51). 0x00 = dimmest, 0xFF = max. Safe to call
// any time after display_init(); no-op before the panel IO exists.
void display_set_brightness(uint8_t level)
{
    if (!s_io) return;
    esp_lcd_panel_io_tx_param(s_io, 0x51, (uint8_t[]){ level }, 1);
}

static void display_init_impl(int draw_lines, bool with_touch)
{
    s_lvgl_mutex = xSemaphoreCreateRecursiveMutex();

    panel_bringup();

    lv_init();

    // Keep a small built-in internal pool for bootstrap/latency-sensitive LVGL
    // allocations, then add the main object pool from PSRAM. This must happen
    // before creating the display or any other LVGL object.
    //
    // 64 KiB was too tight and the failure mode was brutal. Swiping agents builds and tears down whole
    // tile subtrees, the picker rebuilds its rows on each open, and a brightness drag repaints a large
    // rounded rect: big uneven blocks interleaved with small ones. Measured on the device, the largest
    // free block fell 16.3 KB -> 6.8 KB and fragmentation went 2% -> 51% within a minute of ordinary use.
    // A draw that then cannot get a contiguous block used to hit LV_ASSERT_MALLOC, whose handler is
    // `while(1);` — the panel froze for good while the rest of the firmware kept running.
    //
    // PSRAM has megabytes free, so the pool is no longer the scarce thing it was sized as.
    //
    // KEEP THIS IN STEP WITH CONFIG_LV_MEM_POOL_EXPAND_SIZE_KILOBYTES. LVGL compiles its TLSF with
    // TLSF_MAX_POOL_SIZE = LV_MEM_SIZE + LV_MEM_POOL_EXPAND_SIZE, and that sizes the allocator's index:
    // a pool larger than the configured maximum is REJECTED at runtime, not merely inefficient. Raising
    // this alone boot-looped the device on the abort() below — the 64 KiB here was matching a 64 KB config.
#define LVGL_PSRAM_POOL_BYTES (512 * 1024)
    s_lvgl_psram_pool = ram_psram_alloc(LVGL_PSRAM_POOL_BYTES, "lvgl_pool");
    if (!s_lvgl_psram_pool) {
        ESP_LOGE(TAG, "required %uKiB LVGL PSRAM pool allocation failed", LVGL_PSRAM_POOL_BYTES / 1024);
        abort();
    }
    if (!lv_mem_add_pool(s_lvgl_psram_pool, LVGL_PSRAM_POOL_BYTES)) {
        ESP_LOGE(TAG, "LVGL rejected the %uKiB PSRAM pool", LVGL_PSRAM_POOL_BYTES / 1024);
        abort();
    }
    ram_telemetry_set_lvgl_ready();
    ram_telemetry_checkpoint("lvgl_pool_ready");

    // Draw buffers in INTERNAL DMA RAM (not PSRAM): the LCD flush reads these over QSPI DMA, and
    // sharing the octal PSRAM with the CPU-written audio record buffer stalled the flush DMA →
    // LVGL hung in wait_for_flushing → watchdog. Internal DMA RAM has no such contention.
    // `draw_lines` is small in the OTA boot mode so the internal RAM freed goes to the big WiFi RX buffers.
    size_t buf_bytes = BSP_LCD_H_RES * draw_lines * BYTES_PER_PX;
    s_buf1 = heap_caps_malloc(buf_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    s_buf2 = heap_caps_malloc(buf_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA);
    if (!s_buf1 || !s_buf2) ESP_LOGE(TAG, "draw buffer alloc failed");
    ESP_LOGI(TAG, "draw buffers %u B x2 (internal); free internal: %u",
             (unsigned)buf_bytes, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));

    s_disp = lv_display_create(BSP_LCD_H_RES, BSP_LCD_V_RES);
    lv_display_set_flush_cb(s_disp, lvgl_flush);
    // Render directly in the panel's byte order (big-endian RGB565). The CO5300 wants byte-swapped
    // RGB565; letting the SW renderer emit it saves a per-pixel CPU swap on every flush (a big win for
    // scroll/pan smoothness — that loop ran over the whole moving region each frame).
    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_RGB565_SWAPPED);
    lv_display_set_buffers(s_disp, s_buf1, s_buf2, buf_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_add_event_cb(s_disp, rounder_cb, LV_EVENT_INVALIDATE_AREA, NULL);

    // The LVGL default theme is light (LV_THEME_DEFAULT_DARK 0) → the auto-created default screen is WHITE.
    // The refresh task paints that white screen for a few frames on every boot/reboot before app_main loads
    // a real (dark) screen → the bright white flash. Paint the default screen black up front (all real
    // scr_* use COL_BG dark) so the whole boot reads black → content, never a white flash. Runs on the main
    // task here, BEFORE lvgl_task starts rendering below.
    lv_obj_set_style_bg_color(lv_screen_active(), lv_color_black(), 0);
    lv_obj_set_style_bg_opa(lv_screen_active(), LV_OPA_COVER, 0);

    const esp_timer_create_args_t targ = { .callback = tick_cb, .name = "lv_tick" };
    esp_timer_handle_t th;
    ESP_ERROR_CHECK(esp_timer_create(&targ, &th));
    ESP_ERROR_CHECK(esp_timer_start_periodic(th, 2 * 1000)); // 2ms

    if (with_touch) touch_init();   // CST9217 → LVGL pointer indev (before the handler task runs)

    // Big stack: rendering long wrapped multi-line labels (the event reader) is stack-heavy.
    xTaskCreatePinnedToCore(lvgl_task, "lvgl", 16384, NULL, 4, NULL, 1);
    ESP_LOGI(TAG, "display + LVGL ready (%dx%d)", BSP_LCD_H_RES, BSP_LCD_V_RES);
}

void display_init(void) { display_init_impl(DRAW_LINES, true); }

// Minimal display for the OTA boot mode: quarter-height draw buffers (frees ~40KB internal for the big
// WiFi RX buffers) and no touch — just enough to render the OTA progress screen.
void display_init_ota(void) { display_init_impl(DRAW_LINES / 4 > 0 ? DRAW_LINES / 4 : 1, false); }

// The LVGL lock, with a voice. Every task that draws takes it; the LVGL task takes it every 20ms. A wait
// past LOCK_WARN_MS is not a busy frame — it is a task that took the lock and blocked inside it (a cable
// write that never drains, an I2C reset with its delays), and the line below is the last thing written
// before the screen stops. It names the waiter AND the holder, which is what turns "the dial froze" into
// a pair of function names.
#define LOCK_WARN_MS 2000
#define LOCK_WARN_EVERY_MS 10000
static const char *volatile s_lock_holder = "-";
static const char *volatile s_lock_holder_task = "-";

void display_lock_at(const char *who)
{
    if (xSemaphoreTakeRecursive(s_lvgl_mutex, pdMS_TO_TICKS(LOCK_WARN_MS)) == pdTRUE) goto held;
    uint32_t waited = LOCK_WARN_MS;
    for (;;) {
        ESP_LOGW(TAG, "display_lock: %s (task %s) waiting %lus — held by %s (task %s)", who,
                 pcTaskGetName(NULL), (unsigned long)(waited / 1000), s_lock_holder, s_lock_holder_task);
        if (xSemaphoreTakeRecursive(s_lvgl_mutex, pdMS_TO_TICKS(LOCK_WARN_EVERY_MS)) == pdTRUE) break;
        waited += LOCK_WARN_EVERY_MS;
    }
    ESP_LOGW(TAG, "display_lock: %s got it after %lus", who, (unsigned long)(waited / 1000));
held:
    s_lock_holder = who;
    s_lock_holder_task = pcTaskGetName(NULL);
}
void display_unlock(void) { xSemaphoreGiveRecursive(s_lvgl_mutex); }

bool display_is_asleep(void) { return s_asleep; }

// Optional power hook: cb(false) on sleep, cb(true) on wake. The UI uses it to arm the screen-lock on
// sleep and show the pattern-unlock overlay on wake. Runs under display_lock (recursive), so the cb may
// touch LVGL. NULL until registered.
static void (*s_power_cb)(bool on);
void display_set_power_cb(void (*cb)(bool on)) { s_power_cb = cb; }

// Reset the idle-off timer WITHOUT a touch. Voice uses the PWR key (not the touchscreen), so a whole
// voice turn (record + upload + the agent working) has no touch and the screen would auto-off mid-task.
// ui_screens bumps this while a voice/turn is active. No-op while asleep (the timer is moot then).
void display_bump_activity(void) { if (!s_asleep) lv_display_trigger_activity(s_disp); }

// Both run on the LVGL task (idle check / touch_read), so LVGL calls here need no extra lock.
void display_sleep(void)
{
    if (s_asleep) return;
    s_asleep = true;
    esp_lcd_panel_disp_on_off(s_panel, false);
    // Stop the render/flush pipeline while the panel is off so a live animation (the connecting-screen
    // spinner) doesn't keep re-rendering into the draw buffers for pixels no one sees. The indev read
    // timer is separate and keeps running, so double-tap-to-wake stays responsive.
    lv_timer_pause(lv_display_get_refr_timer(s_disp));
    if (s_power_cb) s_power_cb(false);   // arm the screen-lock re-lock
    ESP_LOGI(TAG, "sleep (panel off)");
}

void display_wake(void)
{
    if (!s_asleep) return;
    s_asleep = false;                       // clear FIRST so the repaint actually flushes
    lv_timer_resume(lv_display_get_refr_timer(s_disp));  // re-enable rendering (paused in display_sleep)
    lv_obj_invalidate(lv_screen_active());  // repaint current screen (flushed by the LVGL task's refr timer)
    lv_display_trigger_activity(s_disp);    // re-arm the idle timer
    esp_lcd_panel_disp_on_off(s_panel, true);
    if (s_power_cb) s_power_cb(true);   // show the pattern-unlock overlay if the lock is armed
    ESP_LOGI(TAG, "wake (panel on)");
    // NB: no synchronous lv_refr_now / fade here — display_wake runs from the ptt (button A) and touch tasks
    // too, and a foreground full-render + flush there made wake slow AND raced panel on/off with the flush
    // DMA on a rapid double-press (→ watchdog reset). Panel-on is instant; the LVGL task flushes the frame.
}
