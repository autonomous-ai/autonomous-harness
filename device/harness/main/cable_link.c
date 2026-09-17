#include "cable_link.h"

#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_log.h"
#include "last_words.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "cable";

// Driver FIFOs.
//
// ⚠️ RX IS NOT A CONVENIENCE — IT IS THE ONLY THING BETWEEN A SLOW READER AND SILENT DATA LOSS. There is
// no back-pressure on this peripheral. The IDF driver's ISR (esp_driver_usb_serial_jtag/src/
// usb_serial_jtag.c) does:
//
//     rx_fifo_len = usb_serial_jtag_ll_read_rxfifo(buf, USB_SER_JTAG_RX_MAX_SIZE);
//     xRingbufferSendFromISR(rx_ring_buf, buf, rx_fifo_len, &xTaskWoken);
//
// It drains the hardware FIFO unconditionally and ignores the ringbuffer's return value, so a full ring
// means those bytes are simply gone — and because emptying the HW FIFO is what lets the peripheral ACK
// the next OUT packet, the host is never NAK'd and never learns anything went missing. Not reading fast
// enough does not slow the sender down; it shreds the stream.
//
// Measured on this hardware by the sibling firmware, not theorised: with a smaller ring a firmware
// transfer died at 0 of 1,342,160 bytes written. Each 8 KB slice takes ~16 ms to reach flash, and at USB
// full speed ~16 KB arrives while the reader task is inside that write.
//
// So the rule this file keeps: RX_BUF ≥ the largest number of bytes the peer may have in flight while
// this task is blocked. The firmware transfer is the only sender that can saturate the link, and its
// credit window is 16 KB (docs/specs/cable-protocol.md, "Firmware update"). 32 KB is that window twice
// over, for scheduling jitter. Changing either number without the other reintroduces exactly this bug.
#define USJ_RX_BUF (32 * 1024)

// TX is sized so the largest thing this link really sends — a PCM chunk plus framing — fits in one go and
// the write does not block halfway through a frame waiting for the host to drain. (CABLE_MAX_PAYLOAD is
// 8192, but that is a bound on damage from a corrupt length field, not a size anything actually sends.)
#define USJ_TX_BUF 2048

// One read's worth of bytes off the port. Small on purpose: the decoder is where reassembly happens, so
// this only has to keep the syscall rate sane, and every byte of it is internal RAM.
#define READ_CHUNK 256

// How long a read parks waiting for bytes. Not a poll interval — the driver wakes the task as soon as
// anything arrives. It only bounds how long the task sleeps with nothing to do.
#define READ_WAIT_MS 100

// How long a write waits for the host to make room. Finite, and that is the point: an unplugged cable or
// an unopened port fills the TX FIFO and never drains it, and portMAX_DELAY there parks whatever task
// called send() forever. This device is unplugged or in front of a machine with no daemon most of the
// time, so "nobody is reading" has to be an ordinary, survivable answer.
#define WRITE_WAIT_MS 100

// A log line waits far less than a real message. Logging must never become back-pressure on the firmware:
// ESP_LOG is called from every task in the system, and at WRITE_WAIT_MS an unread port would stall each
// of them for a tenth of a second per line. A dropped log line costs a line; a stalled LVGL task costs
// the screen.
#define LOG_WRITE_WAIT_MS 5

// Reader task stack. The frame callback runs on this task, so it carries whatever the message layer
// eventually does — JSON parsing, LVGL updates, and during a firmware install esp_ota_write() plus a
// SHA-256 over the image read back out of flash.
//
// 6 KiB. NOT a measured number yet: ram_telemetry_periodic() reports this task's high-water mark by name
// ("cable_link"), and that is the figure to tune from. The failure this margin is against is real — the
// OTA path on this board's own earlier firmware overflowed an 8 KiB stack and shipped devices that could
// not update themselves.
#define READER_STACK 6144

// One log line's worth of formatted text. Anything longer is truncated rather than split: a log line is
// diagnostic, and half of one that arrives is worth more than a mechanism that could deadlock producing
// the other half.
#define LOG_LINE_MAX 512

static cable_decoder_t s_decoder;
static cable_frame_cb  s_cb;
static void           *s_ctx;
static bool            s_running;

// Serialises the shared encode buffer AND the write, so two tasks sending at once cannot interleave
// halves of two frames onto the wire. A frame split down the middle by a second sender is not something
// the far end can resync out of — both halves have valid magic and neither has a valid CRC.
static SemaphoreHandle_t s_tx_lock;

// 8.2 KB of BSS rather than a stack array (it would not fit) or a malloc (a failed allocation mid-session
// on a microcontroller is a worse outcome than a known, always-paid 8 KB).
//
// Full-size on purpose, even though nothing sends anything close: at CABLE_MAX_FRAME the encoder can
// never fail for lack of room here, so a -1 from cable_frame_encode means exactly one thing — the payload
// is over the protocol's own limit — instead of two things that need telling apart.
static uint8_t s_tx_frame[CABLE_MAX_FRAME];

// ── log framing ─────────────────────────────────────────────────────────────────────────────────────

static vprintf_like_t s_prev_vprintf;
// Reentrancy guard. Every path below can log, and a log emitted from inside the log sink would recurse
// until the stack ran out. One flag is enough because the sink holds the TX lock for its whole body, so
// only one task is ever inside it.
static volatile bool s_in_log_sink;

static bool send_locked(uint8_t type, const uint8_t *payload, size_t payload_len, TickType_t wait)
{
    int len = cable_frame_encode(type, payload, payload_len, s_tx_frame, sizeof(s_tx_frame));
    if (len < 0) return false;
    return usb_serial_jtag_write_bytes(s_tx_frame, (size_t)len, wait) == len;
}

static int log_vprintf(const char *fmt, va_list args)
{
    // From an ISR there is nothing safe to do here — the mutex below would abort — and ESP_EARLY_LOG /
    // panic output does not come through this hook anyway. Hand it back to the plain console.
    if (xPortInIsrContext() || s_in_log_sink) {
        return s_prev_vprintf ? s_prev_vprintf(fmt, args) : 0;
    }

    static char line[LOG_LINE_MAX];   // guarded by s_tx_lock, like s_tx_frame
    if (!s_running || xSemaphoreTake(s_tx_lock, pdMS_TO_TICKS(LOG_WRITE_WAIT_MS)) != pdTRUE) {
        return s_prev_vprintf ? s_prev_vprintf(fmt, args) : 0;
    }
    s_in_log_sink = true;
    int n = vsnprintf(line, sizeof(line), fmt, args);
    if (n > 0) {
        size_t len = (size_t)n < sizeof(line) - 1 ? (size_t)n : sizeof(line) - 1;
        // Trailing newline is the console's business, not the protocol's: the frame IS the line.
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) len--;
        // Into the RTC ring first — that copy survives the reboot the next line may be the last before.
        if (len > 0) last_words_add(line, len);
        if (len > 0) send_locked(CABLE_TYPE_LOG, (const uint8_t *)line, len, pdMS_TO_TICKS(LOG_WRITE_WAIT_MS));
    }
    s_in_log_sink = false;
    xSemaphoreGive(s_tx_lock);
    return n;
}

void cable_link_set_log_framing(bool on)
{
    if (!s_running) return;
    if (on) {
        if (!s_prev_vprintf) s_prev_vprintf = esp_log_set_vprintf(log_vprintf);
        return;
    }
    // Restore the plain console FIRST, then say so — so the line explaining what happened is written the
    // way whoever is now watching the port with a serial monitor can read it.
    if (s_prev_vprintf) {
        esp_log_set_vprintf(s_prev_vprintf);
        s_prev_vprintf = NULL;
    }
}

// ── link ────────────────────────────────────────────────────────────────────────────────────────────

static void reader_task(void *arg)
{
    (void)arg;
    uint8_t chunk[READ_CHUNK];
    while (1) {
        int n = usb_serial_jtag_read_bytes(chunk, sizeof(chunk), pdMS_TO_TICKS(READ_WAIT_MS));
        if (n <= 0) continue;
        // Never fails and never rejects: everything arriving here is untrusted, starts mid-stream after
        // every boot, and the only useful response to a byte that makes no sense is to step over it.
        cable_decoder_feed(&s_decoder, chunk, (size_t)n, s_cb, s_ctx);
    }
}

bool cable_link_start(cable_frame_cb cb, void *ctx)
{
    if (s_running) return true;

    s_cb = cb;
    s_ctx = ctx;
    cable_decoder_init(&s_decoder);

    s_tx_lock = xSemaphoreCreateMutex();
    if (!s_tx_lock) {
        ESP_LOGE(TAG, "no memory for the tx lock — link disabled");
        return false;
    }

    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = USJ_TX_BUF,
        .rx_buffer_size = USJ_RX_BUF,
    };
    esp_err_t err = usb_serial_jtag_driver_install(&cfg);
    if (err != ESP_OK) {
        // Say what it costs. The symptom lands far from here — the dial comes up, draws its screen, and
        // simply never hears from the machine — so the log line has to name the cause itself.
        ESP_LOGE(TAG, "usb_serial_jtag driver install failed (%s) — no link to the daemon",
                 esp_err_to_name(err));
        vSemaphoreDelete(s_tx_lock);
        s_tx_lock = NULL;
        return false;
    }

    if (xTaskCreate(reader_task, "cable_link", READER_STACK, NULL, 5, NULL) != pdPASS) {
        ESP_LOGE(TAG, "reader task create failed — no link to the daemon");
        usb_serial_jtag_driver_uninstall();
        vSemaphoreDelete(s_tx_lock);
        s_tx_lock = NULL;
        return false;
    }

    s_running = true;
    ESP_LOGI(TAG, "usb link up on the native port (frame v%d, max frame %d B)",
             CABLE_FRAME_VERSION, CABLE_MAX_FRAME);
    return true;
}

bool cable_link_send(uint8_t type, const uint8_t *payload, size_t payload_len)
{
    if (!s_running) return false;

    xSemaphoreTake(s_tx_lock, portMAX_DELAY);
    const bool ok = send_locked(type, payload, payload_len, pdMS_TO_TICKS(WRITE_WAIT_MS));
    const bool too_big = payload_len > CABLE_MAX_PAYLOAD;
    xSemaphoreGive(s_tx_lock);

    if (ok) return true;
    if (too_big) {
        // A bug on this side, and one the far end could only ever report back as noise, so it has to be
        // caught and named here.
        ESP_LOGE(TAG, "refusing to send %u-byte payload (max %d)", (unsigned)payload_len, CABLE_MAX_PAYLOAD);
        return false;
    }
    // DEBUG, not WARN. "Nobody is draining the port" is this device's resting state, not a fault: it is
    // unplugged, or plugged into a machine with no daemon. At WARN the log would be a wall of identical
    // lines whenever nothing is wrong, which is how a log stops being read at all.
    ESP_LOGD(TAG, "short write (host not reading)");
    return false;
}

bool cable_link_host_present(void)
{
    // Guarded on s_running because the driver call is undefined before install, and "no driver" is
    // indistinguishable from "no host" to everything above: both mean nothing can be said on this port.
    return s_running && usb_serial_jtag_is_connected();
}

void cable_link_counters(uint32_t *corrupt_frames, uint32_t *discarded_bytes)
{
    if (corrupt_frames) *corrupt_frames = s_decoder.corrupt_frames;
    if (discarded_bytes) *discarded_bytes = s_decoder.discarded_bytes;
}

void cable_link_reset_decoder(void)
{
    cable_decoder_reset(&s_decoder);
}
