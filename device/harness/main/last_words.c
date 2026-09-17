#include "last_words.h"

#include <string.h>

#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"

static const char *TAG = "boot";

#define RING_BYTES 4096
#define RING_MAGIC 0x4C575244u   // "LWRD"

// RTC_NOINIT: not touched by the bootloader or the startup code, so it holds across a panic, a watchdog
// reset or esp_restart(). A power cut clears it, and that is fine — a power cut is not a bug this can
// name. The magic and a checksum of the header guard against reading garbage on a cold boot.
typedef struct {
    uint32_t magic;
    uint32_t head;      // next write position
    uint32_t len;       // bytes in use (≤ RING_BYTES)
    uint32_t check;     // ~(head ^ len)
    char     buf[RING_BYTES];
} ring_t;

static RTC_NOINIT_ATTR ring_t s_ring;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;

static esp_reset_reason_t s_reason;
static bool s_abnormal;
// The previous boot's lines, copied out before this boot starts overwriting the ring. Static rather than
// heap: 4 KB of BSS is cheaper than a failed allocation at the one moment it would matter.
static char s_previous[RING_BYTES + 1];
static size_t s_previous_len;
static bool s_reported;

static bool ring_valid(void)
{
    return s_ring.magic == RING_MAGIC && s_ring.len <= RING_BYTES && s_ring.head < RING_BYTES
        && s_ring.check == ~(s_ring.head ^ s_ring.len);
}

static void ring_seal(void) { s_ring.check = ~(s_ring.head ^ s_ring.len); }

static const char *reason_name(esp_reset_reason_t r)
{
    switch (r) {
    case ESP_RST_POWERON:   return "power-on";
    case ESP_RST_EXT:       return "external pin";
    case ESP_RST_SW:        return "software (esp_restart)";
    case ESP_RST_PANIC:     return "PANIC";
    case ESP_RST_INT_WDT:   return "INTERRUPT WATCHDOG";
    case ESP_RST_TASK_WDT:  return "TASK WATCHDOG";
    case ESP_RST_WDT:       return "WATCHDOG";
    case ESP_RST_DEEPSLEEP: return "deep sleep";
    case ESP_RST_BROWNOUT:  return "BROWNOUT";
    case ESP_RST_SDIO:      return "sdio";
    case ESP_RST_USB:       return "usb";
    case ESP_RST_JTAG:      return "jtag";
    default:                return "unknown";
    }
}

void last_words_boot(void)
{
    s_reason = esp_reset_reason();
    s_abnormal = s_reason == ESP_RST_PANIC || s_reason == ESP_RST_INT_WDT || s_reason == ESP_RST_TASK_WDT
              || s_reason == ESP_RST_WDT || s_reason == ESP_RST_BROWNOUT || s_reason == ESP_RST_UNKNOWN;
    if (s_abnormal && ring_valid() && s_ring.len) {
        // Unroll the ring into reading order: oldest byte first.
        uint32_t start = (s_ring.head + RING_BYTES - s_ring.len) % RING_BYTES;
        for (uint32_t i = 0; i < s_ring.len; i++) s_previous[i] = s_ring.buf[(start + i) % RING_BYTES];
        s_previous_len = s_ring.len;
        s_previous[s_previous_len] = '\0';
    }
    s_ring.magic = RING_MAGIC;
    s_ring.head = 0;
    s_ring.len = 0;
    ring_seal();
}

void last_words_add(const char *line, size_t len)
{
    if (!len) return;
    portENTER_CRITICAL(&s_mux);
    if (!ring_valid()) { s_ring.magic = RING_MAGIC; s_ring.head = 0; s_ring.len = 0; }
    for (size_t i = 0; i < len; i++) {
        s_ring.buf[s_ring.head] = line[i];
        s_ring.head = (s_ring.head + 1) % RING_BYTES;
    }
    s_ring.buf[s_ring.head] = '\n';
    s_ring.head = (s_ring.head + 1) % RING_BYTES;
    s_ring.len += len + 1;
    if (s_ring.len > RING_BYTES) s_ring.len = RING_BYTES;
    ring_seal();
    portEXIT_CRITICAL(&s_mux);
}

void last_words_report(void)
{
    if (s_reported) return;
    s_reported = true;
    if (s_abnormal) ESP_LOGW(TAG, "reset reason: %s", reason_name(s_reason));
    else            ESP_LOGI(TAG, "reset reason: %s", reason_name(s_reason));
    if (!s_previous_len) return;
    ESP_LOGW(TAG, "last %u bytes of log before that reset follow", (unsigned)s_previous_len);
    // The first line is very likely a fragment (the ring wrapped through it); everything after is whole.
    char *p = s_previous;
    while (p && *p) {
        char *nl = strchr(p, '\n');
        if (nl) *nl = '\0';
        if (*p) ESP_LOGW(TAG, "last: %s", p);
        p = nl ? nl + 1 : NULL;
    }
    ESP_LOGW(TAG, "end of last words");
    s_previous_len = 0;
}
