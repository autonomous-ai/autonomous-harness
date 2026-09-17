// Applying a firmware image that arrives over the cable.
//
// This is the half of the update that runs on the dial: the daemon carries the image (it pulls the
// published one from GCS) and pushes it as 0x03 frames; everything here is about getting those bytes into
// the inactive OTA slot safely and refusing to boot into them if they are wrong.
//
// The transport question this file does NOT own — flow control — is in docs/specs/cable-protocol.md §7,
// and its three numbers have to move together. What this file owns is the promise underneath them: a
// failed update costs a reboot and nothing else.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Confirm THIS image, if this boot is a freshly installed one.
//
// With CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE an app booted from an OTA slot starts in PENDING_VERIFY,
// and the bootloader REVERTS it on the next reboot unless it says this. That call used to live in
// ota.c; deleting the WiFi stack took it with it, and nothing else made it — so the dial quietly rolled
// back to the old WiFi image the next time it restarted, which on a device that reboots on every unplug
// is very soon.
//
// WHAT COUNTS AS "IT RUNS" is a judgement, not a formality. Call it once the display is up and the USB
// link has been started: that is everything needed for the dial to be FIXABLE again — it can draw, and
// the daemon can reach it to offer another image. Waiting for something further out, a `welcome` say,
// would roll a perfectly good image back because nobody had a daemon running yet, and an idle cable is
// this device's resting state rather than a fault.
void fw_mark_valid(void);

// An image the daemon is offering. Answering is optional: declining is simply not answering, and the
// daemon offers again on the next `hello`.
//
// Returns true if the offer was accepted (a slot has been erased and the dial is now expecting slices).
// Refuses while a turn is running — an update must never begin in the middle of something the user is
// watching — and refuses a second offer while one is in flight.
bool fw_update_offer(const char *version, int size, const char *sha256_hex);

// One slice, in order, from offset 0. Writes it to flash and acknowledges it with `fw.progress`, which is
// what opens the daemon's credit window — see the protocol doc before changing anything about the cadence.
//
// A write failure ends the update, reports `fw.error` and leaves the running image untouched.
void fw_update_slice(const uint8_t *data, size_t len);

// True while an update is in flight. The UI shows progress and the link must not be torn down.
bool fw_update_active(void);

// Abandon an update in flight (the session dropped mid-transfer). The old image keeps running; the slot is
// left dirty and is erased again by the next accepted offer.
void fw_update_abort(const char *why);
