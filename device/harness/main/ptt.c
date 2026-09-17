#include "ptt.h"
#include "ui/ui_screens.h"
#include "ui/display.h"
#include "board/power.h"
#include "board/board_pins.h"
#include "board/board.h"
#include "audio_client.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_timer.h"
#include "esp_log.h"

static const char *TAG = "ptt";
#define POLL_MS      100               // key poll cadence (latency only — the PMIC key event latches; BOOT is level-read)

// Two keys, two dials (board.h):
//   • BOOT (GPIO0, both dials): a tap interrupts the running turn — fires on the press edge, so it is as
//     quick as it ever was. Held ≥ BOOT_LONG_PRESS_MS it also toggles the screen on/off — the same
//     gesture on both dials, so there is one thing to teach and one path to maintain.
//   • Button A (the PWR key, wired to the AXP2101 PWRON pin — read over I2C, not a GPIO): a tap toggles
//     the screen. Only where there is an AXP2101; a long press restarts the device in PMIC hardware and
//     never reaches us.
// Voice is gesture-driven (touch.c); neither key touches it.
#define BOOT_LONG_PRESS_MS 800

static void screen_toggle(const char *why)
{
    // Hold the LVGL lock: display_sleep/wake touch LVGL timers + the panel, and normally run on the LVGL
    // task; the recursive mutex serialises this ptt-task call with it.
    display_lock();
    if (display_is_asleep()) { ESP_LOGI(TAG, "%s → screen ON",  why); display_wake(); }
    else                     { ESP_LOGI(TAG, "%s → screen OFF", why); display_sleep(); }
    display_unlock();
}

static void ptt_task(void *arg)
{
    gpio_config_t bcfg = {
        .pin_bit_mask = 1ULL << BSP_BOOT_BUTTON,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&bcfg);
    int boot_prev = 1;       // released (active-low: 1 = up, 0 = pressed)
    int64_t press_start_us = 0;
    bool long_fired = false;
    const bool pwr_key = board()->has_pmic;

    while (1) {
        if (pwr_key && power_take_pwrkey_tap()) screen_toggle("PWR tap");

        int boot_now = gpio_get_level(BSP_BOOT_BUTTON);
        if (boot_prev == 1 && boot_now == 0) {                 // fresh press
            if (display_is_asleep()) { display_lock(); display_wake(); display_unlock(); }
            ESP_LOGI(TAG, "BOOT press → back / stop turn");
            ui_boot_pressed();
            press_start_us = esp_timer_get_time();
            long_fired = false;
        } else if (boot_now == 0 && !long_fired
                   && esp_timer_get_time() - press_start_us >= (int64_t)BOOT_LONG_PRESS_MS * 1000) {
            long_fired = true;                                 // once per press
            screen_toggle("BOOT hold");
        }
        boot_prev = boot_now;

        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

void ptt_start(void)
{
    // Priority 3 — below the LVGL task (4) so button polling never preempts UI rendering.
    xTaskCreate(ptt_task, "ptt", 4096, NULL, 3, NULL);
}
