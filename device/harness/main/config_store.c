#include "config_store.h"
#include <stdlib.h>
#include <string.h>
#include "ram_telemetry.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_log.h"
#include "esp_random.h"
#include "mbedtls/sha256.h"

static const char *TAG = "config";
static const char *NS = "pair";

static void read_str(nvs_handle_t h, const char *key, char *dst, size_t cap);   // defined below

// SHA-256(salt_hex || pattern) → 64-char lowercase hex. salt_hex is the stored per-device salt.
static void lock_hash(const char *salt_hex, const char *pattern, char out_hex[65])
{
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    mbedtls_sha256_starts(&ctx, 0);   // 0 = SHA-256
    mbedtls_sha256_update(&ctx, (const unsigned char *)salt_hex, strlen(salt_hex));
    mbedtls_sha256_update(&ctx, (const unsigned char *)pattern, strlen(pattern));
    uint8_t digest[32] = { 0 };
    mbedtls_sha256_finish(&ctx, digest);
    mbedtls_sha256_free(&ctx);
    for (int i = 0; i < 32; i++) snprintf(out_hex + i * 2, 3, "%02x", digest[i]);
}

void config_set_lock(const char *pattern)
{
    if (!pattern || !pattern[0]) return;
    uint8_t salt[8];
    esp_fill_random(salt, sizeof(salt));
    char salt_hex[17];
    for (int i = 0; i < 8; i++) snprintf(salt_hex + i * 2, 3, "%02x", salt[i]);
    char hex[65];
    lock_hash(salt_hex, pattern, hex);
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, "lock_salt", salt_hex);
    nvs_set_str(h, "lock_hash", hex);
    nvs_set_u8(h, "lock_on", 1);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "lock set");
}

bool config_lock_enabled(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;
    uint8_t on = 0;
    if (nvs_get_u8(h, "lock_on", &on) != ESP_OK) on = 0;
    nvs_close(h);
    return on == 1;
}

bool config_check_lock(const char *pattern)
{
    if (!pattern || !pattern[0]) return false;
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READONLY, &h) != ESP_OK) return false;
    char salt_hex[33] = "", want[80] = "";
    read_str(h, "lock_salt", salt_hex, sizeof(salt_hex));
    read_str(h, "lock_hash", want, sizeof(want));
    nvs_close(h);
    if (!salt_hex[0] || !want[0]) return false;
    char hex[65];
    lock_hash(salt_hex, pattern, hex);
    return strcasecmp(hex, want) == 0;
}

void config_clear_lock(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    nvs_erase_key(h, "lock_salt");
    nvs_erase_key(h, "lock_hash");
    nvs_set_u8(h, "lock_on", 0);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "lock cleared");
}

void config_store_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
}

static void read_str(nvs_handle_t h, const char *key, char *dst, size_t cap)
{
    size_t len = cap;
    memset(dst, 0, cap);
    if (nvs_get_str(h, key, dst, &len) != ESP_OK) dst[0] = '\0';
}

void config_load_voicelang(char *out, size_t cap)
{
    nvs_handle_t h;
    memset(out, 0, cap);
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        read_str(h, "vlang", out, cap);
        nvs_close(h);
    }
    if (out[0] == '\0' && cap > 2) { strncpy(out, "en", cap - 1); out[cap - 1] = '\0'; }   // factory default: English (Settings › Voice flips it)
}

void config_save_voicelang(const char *lang)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    bool ok = nvs_set_str(h, "vlang", lang) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_voicelang '%s': %s", lang, ok ? "ok" : "FAILED");
}

uint8_t config_load_brightness(void)
{
    nvs_handle_t h;
    uint8_t v = 0x99;   // default ~60%
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "bright", &v);   // leaves v at default if key is absent
        nvs_close(h);
    }
    return v;
}

void config_save_brightness(uint8_t level)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    bool ok = nvs_set_u8(h, "bright", level) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_brightness 0x%02x: %s", level, ok ? "ok" : "FAILED");
}

// --- scroll direction ---------------------------------------------------------------------------
// Which way a drag moves the window's scrollback. A habit, not a fact about the hardware: some hands
// expect the text to follow the finger, others expect the VIEW to follow it, and neither is wrong.
//
// Stored on the DIAL, not in the window, because it belongs to the hand holding this device. Nothing else
// needs to know: the report is signed before it leaves here, so the daemon, the window and the terminal
// all see the same frame they always did. A preference two sides both hold is a preference they can
// disagree about.
bool config_load_scroll_reversed(void)
{
    nvs_handle_t h;
    uint8_t v = 0;   // default: unchanged from every build before this one
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "scrollrev", &v);
        nvs_close(h);
    }
    return v != 0;
}

void config_save_scroll_reversed(bool reversed)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    bool ok = nvs_set_u8(h, "scrollrev", reversed ? 1 : 0) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_scroll_reversed %d: %s", (int)reversed, ok ? "ok" : "FAILED");
}

// Which way a horizontal swipe walks the carousel. Same shape as the scroll habit above and stored
// separately on purpose: someone can want the scrollback reversed and the carousel left alone, and one
// switch for both would force a preference nobody asked for.
bool config_load_swipe_reversed(void)
{
    nvs_handle_t h;
    uint8_t v = 0;   // default: unchanged from every build before this one
    if (nvs_open(NS, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "swiperev", &v);
        nvs_close(h);
    }
    return v != 0;
}

void config_save_swipe_reversed(bool reversed)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return;
    bool ok = nvs_set_u8(h, "swiperev", reversed ? 1 : 0) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGI(TAG, "save_swipe_reversed %d: %s", (int)reversed, ok ? "ok" : "FAILED");
}

// --- SDS provisioning ---------------------------------------------------------------------------
// One NVS key per value. Do NOT be tempted to fold these into device_net_config_t: that struct is stored
// as a fixed-size blob under "netv", so adding a field silently invalidates every saved network on an
// upgraded unit.
#define K_CID    "cid"
#define K_MQHOST "mqhost"
#define K_MQPORT "mqport"
#define K_MQUSER "mquser"
#define K_MQPASS "mqpass"
#define K_FACH   "fach"
#define K_FDCH   "fdch"

bool config_clear_all(void)
{
    nvs_handle_t h;
    if (nvs_open(NS, NVS_READWRITE, &h) != ESP_OK) return false;
    nvs_erase_all(h);
    bool ok = nvs_commit(h) == ESP_OK;
    nvs_close(h);
    ESP_LOGW(TAG, "clear_all: %s", ok ? "ok" : "FAILED");
    return ok;
}
