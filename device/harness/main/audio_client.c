#include "audio_client.h"
#include "audio_capture.h"
#include "cable_client.h"
#include "config_store.h"
#include "ram_telemetry.h"
#include <string.h>
#include <stdio.h>
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/idf_additions.h"   // xTaskCreateWithCaps / vTaskDeleteWithCaps (PSRAM task stack)
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_random.h"   // esp_random() for the per-utterance uploadId

static const char *TAG = "audio_cli";

static volatile bool s_active;     // worker task alive (recording or sending)
static volatile bool s_recording;  // true ONLY during mic capture (false once sending) — lets the UI flip
                                   // its indicator to "Sending…" on a VAD/internal auto-stop, not just a
                                   // manual (ui_voice_stop) stop.
static volatile bool s_stop_req;   // stop requested by the UI/button (voice is manual start/stop)
static volatile bool s_abort_req;  // quota rejection: stop capture and discard immediately (never drain/finalize)
static volatile voice_cmd_t s_cmd; // slash command for this utterance → voice_start header carries "goal"/"loop"
// The agent this utterance is for, or "" for a turn spoken from the Overview — where naming nothing is
// the point, and the daemon decides from the words which agent they belong to.
static char s_agent[ID_MAX];

// Record into PSRAM during the press, then send AFTER release over the EXISTING commander WS the
// device already holds (no separate connection). The backend sniffs the voice frames on that socket
// (voice_start / binary PCM / voice_end), runs STT, and dispatches the transcript upstream. Mic
// capture is decoupled from the network so a slow link can't truncate speech.
static uint8_t *s_buf;
static size_t s_buf_len;
// Ring buffer, sized as STALL HEADROOM and not as a place to hold a whole utterance. The recording cap is
// ten minutes (s_voice_max_ms), so a long turn wraps by design and the drain loop below is what keeps the
// stream correct — the old comment here claimed this "covers the 120s / 2-min max", which was untrue even
// at 8 kHz, where the cap was already ten minutes and this held 131s. At 16 kHz it holds ~66s, which is
// still far more slack than a cable needs: the mic produces 32 KB/s against a link measured at ~238 KB/s.
#define BUF_MAX (2 * 1024 * 1024)
#define CHUNK   1280

// Stable per-utterance id (all voice modes) + a RING view of s_buf holding the last ~131s of produced
// PCM, so on a WS drop the device keeps recording (ring) and resends only the missing tail after reconnect.
static char     s_upload_id[24];   // 16-hex, generated synchronously before each recording starts
static uint64_t s_prod_off;        // total PCM bytes produced this utterance (monotonic; ring write cursor = %BUF_MAX)
// One PCM chunk is 80ms of audio; a healthy TLS write of 1280 bytes finishes in single-digit ms. Waiting
// seconds for one therefore buys nothing and costs everything: esp_websocket_client holds its lock while the
// write blocks, so the old 2000ms wait x 6 chunks per iteration could hold it for 12s — exactly the client's
// "no PONG received for more than 12 seconds" window. The keepalive starved, the client killed the socket,
// the reconnect hit the same wall, and after 60s the whole recording was thrown away. Bound BOTH the single
// write and the time spent flushing per iteration, so the client's task always gets the lock back.
#define SEND_CHUNK_TIMEOUT_MS 400
#define FLUSH_BUDGET_US       300000LL   // per capture iteration; a healthy link drains 6 chunks in ~5ms
#define STALL_BACKOFF_US      300000LL   // after a timed-out write, leave the socket alone this long

#define RESUME_OUTAGE_MAX_US  60000000LL   // give up if the WS stays down >60s (matches the backend park grace)
#define RESUME_ACK_WAIT_US     8000000LL   // wait up to 8s for voice_resume_ack before retrying the resume
static void build_voice_start(char *out, size_t cap);   // fwd decl: stream_recover_step re-emits it on a fresh reconnect

// Speech gate: a cheap energy check so an accidental / forgotten Voice press doesn't record silence for up to
// the 10-min cap. Each chunk's mean |sample| is compared to a threshold; once enough loud chunks are seen the
// utterance has "heard voice" (latched). The UI's 15s silence watchdog reads audio_client_heard_voice() and
// discards a recording that never crossed it. Tunable: raise MEANABS if soft speech is cut off; a single
// click can't fool it (needs MIN_CHUNKS ~= 320ms of sound).
#define VOICE_GATE_MEANABS     600   // mean |int16 sample| that counts as "sound present" (mic silence floor peaks ~350)
// COUNTED IN CHUNKS, SO IT MOVES WITH THE SAMPLE RATE. Each chunk is a fixed CHUNK bytes, which is 40ms at
// 16 kHz (it was 80ms at 8 kHz) — leaving this at 4 would have quietly halved the gate to 160ms and let a
// cough or a knock latch "heard voice". 8 keeps the ~320ms of sustained sound the threshold was tuned for.
#define VOICE_GATE_MIN_CHUNKS  8     // CONSECUTIVE loud chunks (~320ms sustained) required before "heard voice"
static volatile bool s_voice_heard;  // latched true once VOICE_GATE_MIN_CHUNKS loud chunks are seen
static int           s_loud_chunks;  // running count of loud chunks this utterance

// Feed one just-captured PCM chunk to the speech gate (no-op once speech is confirmed).
static void voice_gate_feed(const uint8_t *buf, int n)
{
    if (s_voice_heard || n < 2) return;
    const int16_t *s = (const int16_t *)buf;
    int ns = n / 2;
    uint32_t sumabs = 0;
    for (int i = 0; i < ns; i++) { int v = s[i]; sumabs += (uint32_t)(v < 0 ? -v : v); }
    // Require CONSECUTIVE loud chunks (sustained sound); a quiet chunk resets the run, so the mic's spiky
    // ~350 silence floor — and the one-off tap-noise spike at press — can't accumulate a false "heard".
    if ((sumabs / (uint32_t)ns) > VOICE_GATE_MEANABS) {
        if (++s_loud_chunks >= VOICE_GATE_MIN_CHUNKS) s_voice_heard = true;
    } else {
        s_loud_chunks = 0;
    }
}

// True once this utterance has crossed the speech gate. Reset at the start of every recording (voice_task).
bool audio_client_heard_voice(void) { return s_voice_heard; }

static void new_upload_id(void)
{
    snprintf(s_upload_id, sizeof(s_upload_id), "%08x%08x", (unsigned)esp_random(), (unsigned)esp_random());
}

// Ring-write n PCM bytes into s_buf (circular), advancing s_prod_off.
static void ring_write(const uint8_t *p, size_t n)
{
    if (!s_buf || n == 0) return;
    size_t pos = (size_t)(s_prod_off % BUF_MAX);
    size_t first = BUF_MAX - pos; if (first > n) first = n;
    memcpy(s_buf + pos, p, first);
    if (n > first) memcpy(s_buf, p + first, n - first);
    s_prod_off += n;
}

static bool stream_capture_cable(uint8_t *tmp)
{
    s_prod_off = 0;
    uint64_t sent = 0;
    char lang[CFG_VLANG_MAX];
    config_load_voicelang(lang, sizeof(lang));
    const char *cmd = s_cmd == VOICE_CMD_GOAL ? "goal" : (s_cmd == VOICE_CMD_LOOP ? "loop" : "");
    cable_client_voice_begin(s_agent[0] ? s_agent : NULL, cmd, lang, AUDIO_SAMPLE_RATE);

    // Drain up to this many chunks per iteration. Bounded so mic capture is never starved: the I2S DMA is
    // shallow, and a consumer that hogs the loop drops live speech — the same damage the drop policy above
    // exists to prevent, arriving from the other side.
    const int MAX_DRAIN = 8;

    while (!s_stop_req) {
        int n = audio_capture_read(tmp, CHUNK);
        if (n > 0) { voice_gate_feed(tmp, n); ring_write(tmp, (size_t)n); }
        else vTaskDelay(pdMS_TO_TICKS(5));
        for (int i = 0; i < MAX_DRAIN && sent < s_prod_off; i++) {
            size_t pos = (size_t)(sent % BUF_MAX);
            uint64_t remain = s_prod_off - sent;
            size_t len = BUF_MAX - pos;
            if (len > remain) len = (size_t)remain;
            if (len > CABLE_VOICE_CHUNK) len = CABLE_VOICE_CHUNK;
            if (!cable_client_voice_pcm(s_buf + pos, len)) {
                ESP_LOGW(TAG, "voice(cable): chunk stalled at %lluKB — aborting the utterance",
                         (unsigned long long)(sent / 1024));
                cable_client_voice_abort("cable stalled");
                return false;
            }
            sent += len;
        }
    }
    if (s_abort_req) { cable_client_voice_abort("aborted"); return false; }

    // Tail: everything the mic produced after the last drain.
    while (sent < s_prod_off) {
        size_t pos = (size_t)(sent % BUF_MAX);
        uint64_t remain = s_prod_off - sent;
        size_t len = BUF_MAX - pos;
        if (len > remain) len = (size_t)remain;
        if (len > CABLE_VOICE_CHUNK) len = CABLE_VOICE_CHUNK;
        if (!cable_client_voice_pcm(s_buf + pos, len)) {
            ESP_LOGW(TAG, "voice(cable): tail stalled at %lluKB", (unsigned long long)(sent / 1024));
            cable_client_voice_abort("cable stalled");
            return false;
        }
        sent += len;
    }
    return (cable_client_voice_end(), true);
}

static void voice_task(void *arg)
{
    (void)arg;
    uint8_t tmp[CHUNK];

    s_voice_heard = false; s_loud_chunks = 0;   // reset the speech gate for this utterance
    if (!audio_capture_start()) ESP_LOGE(TAG, "mic start failed");
    const int64_t t_rec0 = esp_timer_get_time();
    ram_telemetry_checkpoint("voice_record_start");
    s_recording = true;

    const bool ok = stream_capture_cable(tmp);

    audio_capture_stop();
    const double secs = (double)(esp_timer_get_time() - t_rec0) / 1e6;
    ESP_LOGI(TAG, "voice %s: %.1fs, %lluKB", ok ? "sent" : "ABORTED", secs,
             (unsigned long long)(s_prod_off / 1024));

    s_recording = false;
    s_active = false;
    ram_telemetry_checkpoint("voice_end");
    vTaskDeleteWithCaps(NULL);   // frees the PSRAM stack allocated by xTaskCreateWithCaps
}


// Pre-allocate the 2 MB PSRAM record buffer ONCE at boot, BEFORE WiFi/TLS fragment the PSRAM heap —
// a 2 MB contiguous block is hard to obtain later even with MBs free. Call early from app_main.
void audio_client_init(void)
{
    if (s_buf) return;
    s_buf = ram_psram_alloc(BUF_MAX, "voice_record_buffer");
    ESP_LOGI(TAG, "record buffer %s (%d KB) — PSRAM free=%u KB, largest block=%u KB",
             s_buf ? "reserved" : "ALLOC FAILED", BUF_MAX / 1024,
             (unsigned)(heap_caps_get_free_size(MALLOC_CAP_SPIRAM) / 1024),
             (unsigned)(heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM) / 1024));
}

/**
 * Start a voice turn: capture here, stream over the cable, let the daemon transcribe.
 *
 * ONE entry point, where there used to be five. The old ones differed by what the BACKEND needed told —
 * a project id, a session id, an autonomy mode, whether the router should pick — and none of that is this
 * device's business any more: `agent_id` empty means the daemon routes, and `cmd` is the one modifier a
 * person can express by holding the button.
 *
 * No project/session: a session is the daemon's mapping underneath an agent, and the dial never sees one.
 */
void audio_client_start_cable(const char *agent_id, voice_cmd_t cmd)
{
    if (s_active) return;
    new_upload_id();
    s_cmd = cmd;
    snprintf(s_agent, sizeof(s_agent), "%s", agent_id ? agent_id : "");
    if (!s_buf) {
        s_buf = ram_psram_alloc(BUF_MAX, "voice_buffer_retry");
        if (!s_buf) ESP_LOGE(TAG, "PSRAM record buffer alloc failed");
    }
    s_stop_req = false;
    s_abort_req = false;
    // Set WITH s_active (before the task spawns) so the UI never reads active-but-not-recording.
    s_recording = true;
    s_active = true;
    if (xTaskCreateWithCaps(voice_task, "voice", 6144, NULL, 6, NULL, MALLOC_CAP_SPIRAM) != pdPASS) {
        s_active = false;
        s_recording = false;
        ESP_LOGE(TAG, "voice task create failed");
    }
    ESP_LOGI(TAG, "voice start (%s)", s_agent[0] ? s_agent : "overview → daemon routes");
}



void audio_client_stop(void)
{
    if (!s_active) return;
    if (!s_stop_req) ESP_LOGI(TAG, "voice stop requested");
    s_stop_req = true;
}

void audio_client_abort(void)
{
    if (!s_active) return;
    if (!s_abort_req) ESP_LOGI(TAG, "voice abort requested");
    s_abort_req = true;
    s_stop_req = true;
}

// While a turn is active, touch.c forwards NOTHING to LVGL — a swipe does not switch tiles and the Voice
// button does nothing, while the tile keeps following the app. That is the stuck-dial report to the
// letter, so a turn that never ends is worth a loud line: once past ten minutes, and again every ten.
#define VOICE_LONG_MS (10 * 60 * 1000)

bool audio_client_active(void)
{
    static int64_t since_us, warned_us;
    if (!s_active) { since_us = 0; return false; }
    int64_t now = esp_timer_get_time();
    if (!since_us) { since_us = now; warned_us = now; }
    if (now - warned_us >= (int64_t)VOICE_LONG_MS * 1000) {
        warned_us = now;
        ESP_LOGW(TAG, "voice turn active for %llu min (recording=%d stop_req=%d abort_req=%d) — touch is held off LVGL",
                 (unsigned long long)((now - since_us) / 60000000), s_recording, s_stop_req, s_abort_req);
    }
    return true;
}

bool audio_client_upload_matches(const char *upload_id)
{
    // Keep matching the just-finished utterance until the next start replaces s_upload_id: the
    // authoritative reserve verdict can arrive just after voice_end has left the device task.
    return upload_id && upload_id[0] && strcmp(s_upload_id, upload_id) == 0;
}

// True only during the mic-capture phase (false once the utterance is being sent). Lets the UI flip
// its indicator from recording → "Sending…" when capture ends (audio_client_active() stays true across
// both phases).
bool audio_client_recording(void)
{
    return s_recording;
}
