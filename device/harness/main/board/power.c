#include "power.h"
#include "board_pins.h"
#include "board_i2c.h"
#include "board.h"
#include "driver/i2c_master.h"
#include "freertos/FreeRTOS.h"
#include "esp_log.h"

static const char *TAG = "power";
static i2c_master_dev_handle_t s_dev;

// AXP2101 registers we touch.
#define AXP_REG_STATUS0   0x00   // PMU status: VBUS/battery presence + current direction
#define AXP_REG_IRQ_EN1   0x41   // IRQ enable set 1 (holds the PONKEY power-key bits)
#define AXP_REG_IRQ_ST0   0x48   // IRQ status set 0 (write-1-to-clear)
#define AXP_REG_IRQ_ST1   0x49   // IRQ status set 1 (PONKEY power-key events)
#define AXP_REG_IRQ_ST2   0x4A   // IRQ status set 2 (write-1-to-clear)
#define AXP_REG_BAT_PCT   0xA4   // fuel-gauge battery percentage (0..100), valid when gauge is running
// PONKEY (PWR key) PRESS (negative-edge / key-DOWN) bit, in both IRQ enable-1 (0x41) and status-1 (0x49).
// We react on the key-DOWN edge so the screen toggles INSTANTLY. The SHORT-press event (bit 3) is only
// latched by the AXP2101 on release, AFTER its internal short-press timing → a 1-2s lag. PONKEY bits:
// 0:release  1:press  2:long  3:short. Long-press still restarts in AXP2101 hardware (REG 0x27 untouched).
#define AXP_PKEY_PRESS    (1 << 1)

static int  axp_read(uint8_t reg);
static esp_err_t axp_write(uint8_t reg, uint8_t val);

// Arm the PONKEY short-press event so button A (the PWR key, wired to AXP2101 PWRON — not a GPIO) can be
// read as a tap over I2C. We deliberately do NOT touch REG 0x27 (PWRON/power-off config), so a LONG press
// still triggers the AXP2101's hardware power-cycle (device restart). IRQ status bits are write-1-to-clear.
static void axp_pwrkey_setup(void)
{
    axp_write(AXP_REG_IRQ_ST0, 0xFF);   // drop any stale latches from before boot
    axp_write(AXP_REG_IRQ_ST1, 0xFF);
    axp_write(AXP_REG_IRQ_ST2, 0xFF);
    int en = axp_read(AXP_REG_IRQ_EN1);
    if (en < 0) en = 0;
    axp_write(AXP_REG_IRQ_EN1, (uint8_t)(en | AXP_PKEY_PRESS));
}

bool power_init(void)
{
    if (s_dev) return true;
    // No PMIC on this dial (board.h): nothing to attach, and — the part that matters — nothing to poll.
    // Attaching anyway cost a failed I2C transaction with a 50ms timeout on every read, ten times a
    // second, for the whole life of the device.
    if (!board()->has_pmic) return false;
    i2c_master_bus_handle_t bus = board_i2c_get();
    if (!bus) { ESP_LOGW(TAG, "shared i2c bus unavailable"); return false; }
    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = BSP_AXP2101_I2C_ADDR,
        .scl_speed_hz = BSP_I2C_FREQ_HZ,
    };
    if (i2c_master_bus_add_device(bus, &cfg, &s_dev) != ESP_OK) {
        ESP_LOGW(TAG, "AXP2101 add_device failed — battery unknown");
        s_dev = NULL;
        return false;
    }
    ESP_LOGI(TAG, "AXP2101 ready (battery status + PWR-key tap)");
    axp_pwrkey_setup();
    return true;
}

// Read one AXP2101 register; returns -1 on failure.
static int axp_read(uint8_t reg)
{
    if (!s_dev && !power_init()) return -1;
    uint8_t out = 0;
    esp_err_t e = i2c_master_transmit_receive(s_dev, &reg, 1, &out, 1, pdMS_TO_TICKS(50));
    if (e != ESP_OK) return -1;
    return out;
}

// Write one AXP2101 register; returns ESP_OK on success.
static esp_err_t axp_write(uint8_t reg, uint8_t val)
{
    if (!s_dev && !power_init()) return ESP_FAIL;
    uint8_t buf[2] = { reg, val };
    return i2c_master_transmit(s_dev, buf, sizeof(buf), pdMS_TO_TICKS(50));
}

bool power_take_pwrkey_tap(void)
{
    int st = axp_read(AXP_REG_IRQ_ST1);
    if (st < 0 || !(st & AXP_PKEY_PRESS)) return false;
    axp_write(AXP_REG_IRQ_ST1, AXP_PKEY_PRESS);   // write-1-to-clear only the press-edge bit
    return true;
}

int power_battery_pct(void)
{
    int v = axp_read(AXP_REG_BAT_PCT);
    if (v < 0 || v > 100) return -1;   // gauge not ready / no battery / bad read
    return v;
}

// AXP2101 PMU_STATUS2 (REG 0x01) bits [7:5] = battery activity: 0 = standby (idle/full), 1 = charging,
// 2 = discharging. This is the reliable source — REG 0x00 bit5 is the charge-CURRENT direction, which
// reads 0 when the battery is full but still plugged in.
#define AXP_REG_STATUS2   0x01
static int axp_charge_state(void)   // 0/1/2, or -1 on read error
{
    int s = axp_read(AXP_REG_STATUS2);
    return s < 0 ? -1 : (s >> 5) & 0x07;
}

bool power_is_charging(void)
{
    return axp_charge_state() == 1;   // actively topping up the battery (drives the charge bolt)
}

bool power_is_on_external(void)
{
    // Plugged into external power = anything but "discharging". Covers actively charging AND a full
    // battery on standby, so the screen stays on whenever it's plugged in — even at 100%.
    int cs = axp_charge_state();
    return cs >= 0 && cs != 2;
}
