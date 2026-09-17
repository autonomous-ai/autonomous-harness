#pragma once
#include <stdbool.h>
#include <stddef.h>

// The device's own MAC address, which nothing else in this firmware reads.
//
// The backend cannot obtain it any other way: the campaign device record ships with `mac_address` blank,
// and there is no server-to-server route to fill it in. So the `auth` frame is the only place it enters
// the system, and the MQTT `info` announcement is the only place it leaves.

#define DEVICE_MAC_STR_LEN 18   // "AA:BB:CC:DD:EE:FF" + NUL

/** Formats the station MAC as upper-case colon-separated hex. false (and out[0]='\0') if the read fails. */
bool device_mac_str(char *out, size_t cap);
