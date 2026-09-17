// The USB transport under cable_frame: bytes in from the native USB port, frames out to it.
//
// This is the whole of the device's connection to the outside world. There is no WiFi on this firmware
// and there is not going to be — plugging the cable in is the authorization, and dropping the network
// takes provisioning, pairing, a backend socket, E2EE and a reconnect ladder out of the design with it.
// So everything the dial ever says goes through the two functions below.
//
// ── ONE PORT, AND WHAT THAT COSTS ───────────────────────────────────────────────────────────────────
// Measured on the board on 2026-08-24: it enumerates as exactly one device —
//
//     303a:1001   "USB JTAG/serial debug unit", Espressif   ← the SoC's own USB peripheral
//
// and nothing else. There is no second UART bridge to move the console to, so the console and this
// protocol share a wire. That is why cable_frame carries a LOG type: while a session is up, every
// ESP_LOG line goes out as a CABLE_TYPE_LOG frame and the daemon files it, so the wire carries frames
// and not a mixture of frames and text.
//
// What CANNOT be framed is the residue, and it is by design: the ROM, the second-stage bootloader and
// the panic handler all write to this port directly, before or instead of anything this file controls.
// The far end's decoder is built to walk through it — that is what the magic scan and the CRC are for.
//
// ── WHEN NOBODY IS LISTENING, THE CONSOLE IS A CONSOLE ──────────────────────────────────────────────
// Log framing is installed when a session starts and removed when it ends (cable_link_set_log_framing).
// Unplugged, or plugged into a machine with no daemon running, the port carries ordinary console text
// and `idf.py monitor` behaves exactly as it always has. Framing logs unconditionally would cost the
// only debugging instrument this board has, in exactly the situation where it is needed most.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cable_frame.h"

// Install the USB-Serial-JTAG driver and start the reader task.
//
// `cb` is invoked once per decoded frame, ON THE READER TASK, with the payload pointing into the
// decoder's own buffer — it is only valid for the duration of the call. Anything that must outlive it
// gets copied by the callback. Anything that touches LVGL takes display_lock() first.
//
// Returns false if the driver would not install, which leaves the dial running with no link rather than
// failing to boot: a device that shows "Not connected" is diagnosable from across the room, and a device
// stuck in a boot loop is not.
bool cable_link_start(cable_frame_cb cb, void *ctx);

// Frame `payload` and write it to the port. Returns true when the whole frame went out.
//
// A false return means the host is not draining the port (an unopened or unplugged CDC endpoint fills
// the FIFO and the write times out). That is a normal state for this device, not an error condition —
// the dial sits unplugged or in front of a machine with no daemon for most of its life. Callers should
// treat it as "not connected", never retry in a tight loop.
//
// If a write is cut short mid-frame the peer sees a truncated frame, which its decoder resyncs past on
// the next magic — that recovery is exactly what the CRC-plus-magic-scan exists for, so a bad moment
// costs one message rather than the link.
bool cable_link_send(uint8_t type, const uint8_t *payload, size_t payload_len);

// Route ESP_LOG through the link as CABLE_TYPE_LOG frames (true), or back to the plain console (false).
//
// Called by the session layer, not by this one: whether a peer is listening is a message-layer fact
// (a `welcome` arrived), and this layer cannot see it. usb_serial_jtag_is_connected() answers a
// different question — see cable_link_host_present().
void cable_link_set_log_framing(bool on);

// Whether a USB HOST is currently driving this port.
//
// NOT the same question as "is the daemon talking to me", and the difference is the whole reason this is
// documented rather than inlined at the call site. The driver answers from USB frame activity, so it is
// true whenever the cable is in a running computer — including one with no daemon, which is where this
// device spends much of its life.
//
// It is therefore useful for exactly one thing: noticing that the cable left, or that the machine went
// to sleep. The layer above uses it as the end of a session. A session that ends because the DAEMON quit
// with the cable still in is invisible here — see the hello cadence in cable_client.c for what stands in.
bool cable_link_host_present(void);

// Framing health. The RATE is the diagnosis, not the totals: a handful of discarded bytes right after
// boot is the bootloader's parting words and is expected, while a steady trickle during a session means
// the two sides disagree about the format or the cable is bad. Without a count those look identical.
void cable_link_counters(uint32_t *corrupt_frames, uint32_t *discarded_bytes);

// Drop any half-received frame. For the layer above to call when it decides a session has ended and a
// new one begun — leftover bytes belong to the old one, and carrying them across puts a stale half-frame
// in front of the first real frame of the new session.
//
// Call it FROM THE FRAME CALLBACK. The decoder has one reader — the link task — and no lock; resetting
// it from another task while that task is mid-feed corrupts the very buffer meant to be cleared.
void cable_link_reset_decoder(void);
