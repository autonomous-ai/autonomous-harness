#include "device_mac.h"

#include <stdio.h>
#include <string.h>

#include "esp_mac.h"
#include "esp_log.h"

static const char *TAG = "mac";

bool device_mac_str(char *out, size_t cap)
{
    if (!out || cap < DEVICE_MAC_STR_LEN) return false;
    out[0] = '\0';

    uint8_t mac[6] = { 0 };
    // ESP_MAC_WIFI_STA, not the AP or the base MAC: it is the address the device uses on the network the
    // user actually sees, so it matches what any other tooling would report for this unit.
    esp_err_t err = esp_read_mac(mac, ESP_MAC_WIFI_STA);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_read_mac failed: %d", (int)err);
        return false;
    }
    snprintf(out, cap, "%02X:%02X:%02X:%02X:%02X:%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return true;
}
