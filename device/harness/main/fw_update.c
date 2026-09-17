#include "fw_update.h"

#include <string.h>

#include "audio_client.h"
#include "cable_client.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "ui/ui_screens.h"

static const char *TAG = "fw";

// Acknowledge every slice. `fw.progress` is not only a progress bar — it is the ACK that opens the
// daemon's credit window, and the daemon keeps at most 16 KB unacknowledged against this dial's 32 KB
// receive ring. Acking less often stalls the transfer; acking on a larger slice overruns the ring, and the
// peripheral drops the overflow silently. See docs/specs/cable-protocol.md §7.
#define PROGRESS_EVERY 1

// Read-back buffer for the hash. Small on purpose: this runs on the link's reader task, whose stack also
// carries esp_ota_write().
#define VERIFY_CHUNK 1024

static const esp_partition_t *s_target;
static esp_ota_handle_t       s_handle;
static bool                   s_active;
static uint32_t               s_written;
static uint32_t               s_expected;
static char                   s_sha_hex[65];
static char                   s_version[32];

static void reset_state(void)
{
    s_active = false;
    s_target = NULL;
    s_handle = 0;
    s_written = 0;
    s_expected = 0;
}

static void fail(const char *why)
{
    ESP_LOGE(TAG, "update failed: %s", why);
    if (s_handle) esp_ota_abort(s_handle);
    reset_state();
    cable_client_fw_error(why);
    ui_show_projects();   // back to where the user was; the running image is untouched
}

bool fw_update_active(void) { return s_active; }

void fw_mark_valid(void)
{
    const esp_partition_t *run = esp_ota_get_running_partition();
    esp_ota_img_states_t st;
    if (!run || esp_ota_get_state_partition(run, &st) != ESP_OK) return;
    if (st != ESP_OTA_IMG_PENDING_VERIFY) return;   // not a fresh install — nothing to confirm

    esp_ota_mark_app_valid_cancel_rollback();
    const esp_app_desc_t *me = esp_app_get_description();
    ESP_LOGW(TAG, "image confirmed (%s) — rollback cancelled", me ? me->version : "?");
}

void fw_update_abort(const char *why)
{
    if (!s_active) return;
    ESP_LOGW(TAG, "update abandoned: %s", why);
    if (s_handle) esp_ota_abort(s_handle);
    reset_state();
    ui_show_projects();
}

bool fw_update_offer(const char *version, int size, const char *sha256_hex)
{
    if (s_active) return false;                    // one at a time; the daemon will offer again
    if (!version || !sha256_hex || strlen(sha256_hex) != 64 || size <= 0) {
        ESP_LOGW(TAG, "ignoring a malformed offer");
        return false;
    }
    // Never mid-turn. The user is watching a turn run; a reboot in the middle of it loses the thread and
    // looks like a crash. The daemon offers again on the next hello, which is 15 seconds away.
    if (audio_client_active()) {
        ESP_LOGI(TAG, "offer %s declined: voice in flight", version);
        return false;
    }

    const esp_partition_t *target = esp_ota_get_next_update_partition(NULL);
    if (!target) { ESP_LOGE(TAG, "no OTA slot"); return false; }
    if ((int)target->size < size) {
        ESP_LOGE(TAG, "image %d B does not fit the %u B slot", size, (unsigned)target->size);
        return false;
    }

    // esp_ota_begin ERASES the slot, which takes seconds — and is why a failed offer must not be retried
    // on a cadence: every attempt spends erase cycles on the user's hardware.
    ESP_LOGI(TAG, "accepting %s (%d B) into %s", version, size, target->label);
    // The screen goes up BEFORE the erase, which takes seconds: without it the dial looks frozen at
    // exactly the moment a user must not power it off.
    ui_ota_boot_show(version);
    esp_err_t err = esp_ota_begin(target, size, &s_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin: %s", esp_err_to_name(err));
        ui_show_projects();
        return false;
    }

    s_target = target;
    s_expected = (uint32_t)size;
    s_written = 0;
    s_active = true;
    snprintf(s_sha_hex, sizeof(s_sha_hex), "%s", sha256_hex);
    snprintf(s_version, sizeof(s_version), "%s", version);
    cable_client_fw_accept();
    return true;
}

// SHA-256 of what is ACTUALLY IN FLASH, read back out of the partition.
//
// Not of the bytes as they went past: the point of the check is to catch a write that did not land, and a
// hash taken on the way in cannot see that. It is the difference between "the cable delivered it" and "the
// device has it".
static bool written_hash_matches(void)
{
    mbedtls_sha256_context ctx;
    mbedtls_sha256_init(&ctx);
    if (mbedtls_sha256_starts(&ctx, 0) != 0) { mbedtls_sha256_free(&ctx); return false; }

    static uint8_t buf[VERIFY_CHUNK];
    for (uint32_t off = 0; off < s_written; ) {
        const uint32_t n = (s_written - off) < VERIFY_CHUNK ? (s_written - off) : VERIFY_CHUNK;
        if (esp_partition_read(s_target, off, buf, n) != ESP_OK) { mbedtls_sha256_free(&ctx); return false; }
        if (mbedtls_sha256_update(&ctx, buf, n) != 0) { mbedtls_sha256_free(&ctx); return false; }
        off += n;
    }
    uint8_t digest[32];
    const bool ok = mbedtls_sha256_finish(&ctx, digest) == 0;
    mbedtls_sha256_free(&ctx);
    if (!ok) return false;

    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", digest[i]);
    return strcmp(hex, s_sha_hex) == 0;
}

void fw_update_slice(const uint8_t *data, size_t len)
{
    if (!s_active || !data || len == 0) return;

    if (s_written + len > s_expected) {
        fail("more bytes than the offer promised");
        return;
    }
    if (esp_ota_write(s_handle, data, len) != ESP_OK) {
        fail("flash write failed");
        return;
    }
    s_written += (uint32_t)len;
    cable_client_fw_progress(s_written);
    ui_ota_boot_pct((int)((uint64_t)s_written * 100 / s_expected));

    if (s_written < s_expected) return;

    // ── the image is complete ───────────────────────────────────────────────────────────────────────
    if (esp_ota_end(s_handle) != ESP_OK) { s_handle = 0; fail("image rejected by esp_ota_end"); return; }
    s_handle = 0;

    // Over what was WRITTEN, not what was received — see written_hash_matches().
    if (!written_hash_matches()) { reset_state(); cable_client_fw_error("sha256 mismatch"); ui_show_projects(); return; }

    if (esp_ota_set_boot_partition(s_target) != ESP_OK) {
        reset_state();
        cable_client_fw_error("could not set the boot partition");
        ui_show_projects();
        return;
    }

    ESP_LOGW(TAG, "update %s written and verified — rebooting", s_version);
    ui_show_ota_restarting();
    cable_client_fw_done();
    reset_state();
    // Let the frame render and the last frame reach the daemon before the reboot takes the USB link with
    // it: a device that vanishes mid-sentence looks to the far end like a crash rather than a success.
    vTaskDelay(pdMS_TO_TICKS(400));
    esp_restart();
}
