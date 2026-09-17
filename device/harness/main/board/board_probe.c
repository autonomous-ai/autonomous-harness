// Bring-up probe for a board the firmware has not met yet. Built only with `idf.py -DBOARD_PROBE=1`,
// never in a release image: it walks the shared I2C bus, pulses every candidate reset pin, walks the
// bus again, and reads the touch controllers raw — the facts board_detect() is built on, measured
// rather than assumed. Output goes to the console; read it with a serial monitor, not the daemon.
#include "board_probe.h"

#include "board_i2c.h"
#include "board_pins.h"
#include "driver/gpio.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_touch_cst816s.h"
#include "esp_lcd_touch_cst9217.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "probe";

static void scan(const char *when)
{
    i2c_master_bus_handle_t bus = board_i2c_get();
    if (!bus) { ESP_LOGE(TAG, "%s: no bus", when); return; }
    char line[128]; int n = 0;
    for (int a = 0x08; a <= 0x77; a++) {
        if (i2c_master_probe(bus, (uint16_t)a, 20) == ESP_OK) n += snprintf(line + n, sizeof line - n, " %02X", a);
    }
    ESP_LOGI(TAG, "%s: ack%s", when, n ? line : " (none)");
}

static void pulse(int pin)
{
    gpio_config_t io = { .pin_bit_mask = 1ULL << pin, .mode = GPIO_MODE_OUTPUT };
    gpio_config(&io);
    gpio_set_level(pin, 0); vTaskDelay(pdMS_TO_TICKS(10));
    gpio_set_level(pin, 1); vTaskDelay(pdMS_TO_TICKS(50));
    ESP_LOGI(TAG, "pulsed reset on GPIO%d", pin);
}

// Open one touch driver on one reset pin and sample it a few times, idle. Says whether the chip answers,
// what its id is, and — the part touch.c cares about — what read_data returns with no finger down.
static void try_touch(const char *name, int rst, bool cst816s)
{
    i2c_master_bus_handle_t bus = board_i2c_get();
    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_i2c_config_t io_cfg = cst816s ? (esp_lcd_panel_io_i2c_config_t)ESP_LCD_TOUCH_IO_I2C_CST816S_CONFIG()
                                                   : (esp_lcd_panel_io_i2c_config_t)ESP_LCD_TOUCH_IO_I2C_CST9217_CONFIG();
    io_cfg.scl_speed_hz = BSP_I2C_FREQ_HZ;
    if (esp_lcd_new_panel_io_i2c(bus, &io_cfg, &io) != ESP_OK) { ESP_LOGW(TAG, "%s: panel io failed", name); return; }
    esp_lcd_touch_config_t cfg = {
        .x_max = 466, .y_max = 466, .rst_gpio_num = rst, .int_gpio_num = BSP_TOUCH_INT,
        .flags = { .swap_xy = 0, .mirror_x = 0, .mirror_y = 0 },
    };
    esp_lcd_touch_handle_t tp = NULL;
    esp_err_t err = cst816s ? esp_lcd_touch_new_i2c_cst816s(io, &cfg, &tp) : esp_lcd_touch_new_i2c_cst9217(io, &cfg, &tp);
    if (err != ESP_OK || !tp) { ESP_LOGW(TAG, "%s (rst GPIO%d): init %s", name, rst, esp_err_to_name(err)); esp_lcd_panel_io_del(io); return; }
    ESP_LOGI(TAG, "%s (rst GPIO%d): init OK", name, rst);
    int ok = 0, inv = 0, fail = 0;
    for (int i = 0; i < 30; i++) {
        esp_err_t rc = esp_lcd_touch_read_data(tp);
        if (rc == ESP_OK) ok++; else if (rc == ESP_ERR_INVALID_RESPONSE) inv++; else fail++;
        uint16_t x, y, s; uint8_t cnt = 0;
        bool pressed = esp_lcd_touch_get_coordinates(tp, &x, &y, &s, &cnt, 1) && cnt > 0;
        if (i < 3 || pressed) ESP_LOGI(TAG, "  read %d: rc=%s pressed=%d (%u,%u)", i, esp_err_to_name(rc), pressed, x, y);
        vTaskDelay(pdMS_TO_TICKS(33));
    }
    ESP_LOGI(TAG, "%s idle reads: ok=%d invalid_response=%d fail=%d", name, ok, inv, fail);
    esp_lcd_touch_del(tp);
    esp_lcd_panel_io_del(io);
}

void board_probe_run(void)
{
    ESP_LOGW(TAG, "=== BOARD PROBE (not a release image) ===");
    scan("before any reset");
    pulse(39); pulse(40);   // board A's LCD / touch reset
    scan("after 39/40");
    pulse(1);  pulse(2);    // board B's LCD / touch reset
    scan("after 1/2");
    try_touch("CST9217", 40, false);
    try_touch("CST9217", 2,  false);
    try_touch("CST816S", 2,  true);
    try_touch("CST816S", 40, true);
    scan("after touch probes");
    ESP_LOGW(TAG, "=== PROBE DONE — touch these 10s: ===");
    // One more pass with a finger, on whichever driver answered, to see a press.
    try_touch("CST816S", 2, true);
    try_touch("CST9217", 40, false);
    ESP_LOGW(TAG, "=== END ===");
}
