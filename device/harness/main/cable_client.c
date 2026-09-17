#include "cable_client.h"

#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "cable_link.h"
#include "cable_machines.h"
#include "device_mac.h"
#include "esp_app_desc.h"
#include "esp_log.h"
#include "audio_capture.h"   // audio_notify_done() — the completion beep
#include "esp_timer.h"
#include "fw_update.h"
#include "last_words.h"
#include "board/board.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ui/ui_screens.h"

static const char *TAG = "cable_client";

// ── session timing ──────────────────────────────────────────────────────────────────────────────────
// Over a cable there is no connection to lose: the daemon quitting looks exactly like the daemon having
// nothing to say. Both are silence. So the daemon pings on a fixed cadence for as long as it is alive,
// and the dial reads a gap as absence.
//
// The dial greets on a cadence of its own because it has no port-open event to wait on. The SLOW one is
// load-bearing rather than noise: if the daemon restarts inside the silence window, the dial never
// notices it left — the new instance's ping refreshes the same timer — so without a periodic greeting the
// dial would hold stale tiles forever, connected to a daemon that has never sent it a `welcome`.
#define HELLO_ALONE_MS   2000    // no session: introduce myself often, the daemon cannot see me until I speak
#define HELLO_SESSION_MS 15000   // session up: a keepalive, and a re-introduction if the daemon restarted
#define SILENCE_MS       15000   // nothing of any kind for this long → the daemon is gone

// One JSON message. Comfortably over anything the vocabulary sends; a `question` with several options is
// the largest, and the daemon is expected to have trimmed it for a 466 px screen long before here.
#define JSON_MAX 2048

typedef struct {
    char id[ID_MAX];
    char name[NAME_MAX];
    char engine[12];
    char model[24];
    char effort[16];
    char machine_id[ID_MAX];    // which machine this agent lives on ("" from a daemon that predates it)
    char machine[NAME_MAX];     // that machine's name, drawn on the switcher's second line
} cable_agent_t;


static cable_agent_t     *s_agents;
static int                s_agent_count;
static bool               s_agents_building;
static SemaphoreHandle_t  s_agents_lock;

// The machine wheel, staged and gated here rather than in the UI. `cable_machines_end()` answers the one
// question that matters — did anything actually change — BEFORE any display lock is taken, so an
// unchanged list costs a memcmp on the reader task instead of a full rebuild. See cable_machines.h for
// the measurement that made that necessary.
static cable_machines_t  s_machines;
static char              s_machine_id[MACHINE_ID_MAX];

static volatile bool     s_session;
static volatile int64_t  s_last_rx_us;
static char              s_machine_name[NAME_MAX];
static uint32_t          s_bad, s_unknown;

// ── outbound ────────────────────────────────────────────────────────────────────────────────────────

// Serialise and send. Takes ownership of `root` — every caller builds a tree for exactly one message, and
// making the send own it is what keeps an early return from leaking one.
static bool send_json(cJSON *root)
{
    if (!root) return false;
    char *text = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!text) return false;
    const bool ok = cable_link_send(CABLE_TYPE_JSON, (const uint8_t *)text, strlen(text));
    cJSON_free(text);
    return ok;
}

// A message with a `t` and nothing else, or with one string field. cJSON does the escaping, which is not
// optional: an agent name or a spoken sentence carries quotes, backslashes and newlines, and hand-built
// JSON turns those into a payload the far end drops as unreadable.
static cJSON *msg(const char *t)
{
    cJSON *root = cJSON_CreateObject();
    if (root) cJSON_AddStringToObject(root, "t", t);
    return root;
}

const char *cable_fw_version(void)
{
    // Never NULL: esp_app_get_description() reads a structure linked into this very image. Read from the
    // running image rather than a constant so the daemon's version comparison cannot be lied to.
    return esp_app_get_description()->version;
}

static void send_hello(void)
{
    cJSON *root = msg("hello");
    if (!root) return;
    cJSON_AddStringToObject(root, "fw", cable_fw_version());
    // Named before anything else about this dial is believed. See CABLE_PRODUCT.
    cJSON_AddStringToObject(root, "product", CABLE_PRODUCT);
    cJSON_AddNumberToObject(root, "proto", CABLE_PROTO_VERSION);
    // Which of the two dials this is (board.h) — informational, so a log or a bug report can say. A
    // daemon that predates the field ignores it.
    cJSON_AddStringToObject(root, "hw", board()->name);
    // Also the device's USB serial number, so the daemon can tell one dial from another before a byte is
    // exchanged — and can tell a keepalive greeting from a new board.
    char mac[24] = "";
    device_mac_str(mac, sizeof(mac));
    cJSON_AddStringToObject(root, "mac", mac);
    send_json(root);
}

void cable_client_list_machines(void)
{
    send_json(msg("machines.list"));
}

void cable_client_select_machine(const char *machine_id)
{
    if (!machine_id || !machine_id[0]) return;
    cJSON *root = msg("machine.select");
    if (!root) return;
    cJSON_AddStringToObject(root, "machineId", machine_id);
    send_json(root);
}

const char *cable_client_machine_id(void) { return s_machine_id; }

void cable_client_select_swarm(const char *swarm_id)
{
    if (!swarm_id || !swarm_id[0]) return;
    cJSON *root = msg("swarm.select");
    if (!root) return;
    cJSON_AddStringToObject(root, "swarmId", swarm_id);
    send_json(root);
}

void cable_client_list_swarms(void)
{
    send_json(msg("swarms.list"));
}


void cable_client_send_turn(const char *agent_id, const char *text)
{
    if (!agent_id || !agent_id[0] || !text) return;
    cJSON *root = msg("turn.send");
    if (!root) return;
    cJSON_AddStringToObject(root, "agentId", agent_id);
    cJSON_AddStringToObject(root, "text", text);
    send_json(root);
}

void cable_client_stop_turn(const char *agent_id)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("turn.stop");
    if (!root) return;
    cJSON_AddStringToObject(root, "agentId", agent_id);
    send_json(root);
}

void cable_client_send_focus(const char *agent_id)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("focus");
    if (!root) return;
    cJSON_AddStringToObject(root, "agentId", agent_id);
    send_json(root);
}

void cable_client_send_open(const char *agent_id)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("agent.open");
    if (!root) return;
    cJSON_AddStringToObject(root, "agentId", agent_id);
    send_json(root);
}

void cable_client_send_scroll(cable_scroll_phase_t phase, int dy, int velocity)
{
    static const char *const NAMES[] = { "down", "move", "up" };
    // NO EARLY-OUT ON A ZERO dy. The two ends of a stroke are the whole point of this message: a `down`
    // with nothing in it is what stops a fling still running, and an `up` with nothing in it is a finger
    // that came to rest before it lifted — which must land as a stop, not as a throw.
    cJSON *root = msg("scroll");
    if (!root) return;
    cJSON_AddStringToObject(root, "phase", NAMES[phase]);
    cJSON_AddNumberToObject(root, "dy", dy);
    if (phase == CABLE_SCROLL_UP) cJSON_AddNumberToObject(root, "v", velocity);
    send_json(root);
}

void cable_client_answer(const char *agent_id, const char *request_id, const cJSON *answers)
{
    if (!agent_id || !request_id || !answers) return;
    cJSON *root = msg("answer");
    if (!root) return;
    cJSON_AddStringToObject(root, "agentId", agent_id);
    cJSON_AddStringToObject(root, "requestId", request_id);
    // Duplicated, not adopted: the caller keeps its own tree and this one is deleted with the message.
    cJSON *copy = cJSON_Duplicate(answers, true);
    if (!copy) { cJSON_Delete(root); return; }
    cJSON_AddItemToObject(root, "answers", copy);
    send_json(root);
}

// ── models: the one round trip ──────────────────────────────────────────────────────────────────────
// Everything else here is fire-and-forget, which is what keeps a spoken turn off the critical path. The
// picker is the exception because there is nothing to draw until the catalog arrives, so this waits — on
// refresh_task, never on the LVGL task.
#define MODELS_WAIT_MS 4000

static SemaphoreHandle_t s_models_sem;
static model_item_t     *s_models_out;
static int               s_models_max;
static int               s_models_n;


static void handle_models(const cJSON *p)
{
    if (!s_models_sem || !s_models_out) return;   // nobody is waiting; a late answer is not an error
    const cJSON *items = cJSON_GetObjectItemCaseSensitive(p, "items");
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, items) {
        if (n >= s_models_max) break;
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(it, "id");
        if (!cJSON_IsString(id) || !id->valuestring[0]) continue;
        snprintf(s_models_out[n].id, sizeof(s_models_out[n].id), "%s", id->valuestring);
        n++;
    }
    s_models_n = n;
    xSemaphoreGive(s_models_sem);
}

int cable_client_models_list(const char *agent_id, const char *picker_mode, const char *selected_model,
                             model_item_t *arr, int max)
{
    if (!agent_id || !arr || max <= 0 || !s_models_sem) return -1;

    s_models_out = arr;
    s_models_max = max;
    s_models_n = 0;
    // Drain a stale give from a previous request that timed out and then answered.
    xSemaphoreTake(s_models_sem, 0);

    cJSON *root = msg("models.list");
    if (!root) return -1;
    cJSON_AddStringToObject(root, "agentId", agent_id);
    if (picker_mode) cJSON_AddStringToObject(root, "mode", picker_mode);
    if (selected_model && selected_model[0]) cJSON_AddStringToObject(root, "selected", selected_model);
    if (!send_json(root)) { s_models_out = NULL; return -1; }

    const bool answered = xSemaphoreTake(s_models_sem, pdMS_TO_TICKS(MODELS_WAIT_MS)) == pdTRUE;
    const int n = answered ? s_models_n : -1;
    s_models_out = NULL;
    if (!answered) ESP_LOGW(TAG, "models: no answer in %d ms", MODELS_WAIT_MS);
    return n;
}

void cable_client_agent_update(const char *agent_id, const char *model, const char *effort)
{
    if (!agent_id || !agent_id[0]) return;
    cJSON *root = msg("agent.update");
    if (!root) return;
    cJSON_AddStringToObject(root, "agentId", agent_id);
    if (model && model[0]) cJSON_AddStringToObject(root, "model", model);
    if (effort && effort[0]) cJSON_AddStringToObject(root, "effort", effort);
    send_json(root);
}

void cable_client_voice_begin(const char *agent_id, const char *cmd, const char *lang, int sample_rate)
{
    cJSON *root = msg("voice.begin");
    if (!root) return;
    // OMITTED, not empty, when there is no agent: absence is what tells the daemon it has to route the
    // transcript itself. An empty string would read as "this agent", and there is no agent called "".
    if (agent_id && agent_id[0]) cJSON_AddStringToObject(root, "agentId", agent_id);
    if (cmd && cmd[0]) cJSON_AddStringToObject(root, "cmd", cmd);
    cJSON_AddStringToObject(root, "lang", lang && lang[0] ? lang : "en");
    cJSON_AddNumberToObject(root, "sr", sample_rate);
    send_json(root);
}

bool cable_client_voice_pcm(const uint8_t *pcm, size_t len)
{
    return cable_link_send(CABLE_TYPE_PCM, pcm, len);
}

void cable_client_voice_end(void)
{
    send_json(msg("voice.end"));
}

void cable_client_voice_abort(const char *why)
{
    cJSON *root = msg("voice.abort");
    if (!root) return;
    if (why && why[0]) cJSON_AddStringToObject(root, "why", why);
    send_json(root);
}

void cable_client_voice_confirm(const char *route_id, const char *agent_id)
{
    if (!route_id || !agent_id) return;
    cJSON *root = msg("voice.confirm");
    if (!root) return;
    cJSON_AddStringToObject(root, "routeId", route_id);
    cJSON_AddStringToObject(root, "agentId", agent_id);
    send_json(root);
}

void cable_client_fw_accept(void) { send_json(msg("fw.accept")); }
void cable_client_fw_done(void)   { send_json(msg("fw.done")); }

void cable_client_fw_progress(uint32_t written)
{
    cJSON *root = msg("fw.progress");
    if (!root) return;
    cJSON_AddNumberToObject(root, "written", (double)written);
    send_json(root);
}

void cable_client_fw_error(const char *message)
{
    cJSON *root = msg("fw.error");
    if (!root) return;
    cJSON_AddStringToObject(root, "message", message ? message : "");
    send_json(root);
}

// ── the agent list ──────────────────────────────────────────────────────────────────────────────────

const char *cable_client_machine_name(void) { return s_machine_name; }

// Set by `agents.end`, read by the refresh that applies the list. See ui_project_set_ring_count.
static int s_ring_agents;

int cable_client_ring_count(void)
{
    if (!s_agents_lock) return 0;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    const int n = s_ring_agents;
    xSemaphoreGive(s_agents_lock);
    return n;
}

int cable_client_list_agents(project_t *out, int max)
{
    if (!out || max <= 0 || !s_agents_lock || !s_agents) return 0;
    int n = 0;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    for (int i = 0; i < s_agent_count && n < max; i++) {
        memset(&out[n], 0, sizeof(out[n]));
        snprintf(out[n].id, sizeof(out[n].id), "%s", s_agents[i].id);
        snprintf(out[n].name, sizeof(out[n].name), "%s", s_agents[i].name);
        snprintf(out[n].engine, sizeof(out[n].engine), "%s", s_agents[i].engine);
        snprintf(out[n].machine_id, sizeof(out[n].machine_id), "%s", s_agents[i].machine_id);
        snprintf(out[n].machine, sizeof(out[n].machine), "%s", s_agents[i].machine);

        // The [mark][Model][Effort] chip row reads ONE shape — the opaque runtime-v1 profile — so the
        // daemon's plain model/effort are assembled into it here rather than teaching the UI a second
        // format. A model with no effort axis gets "auto", which the chip hides.
        if (s_agents[i].model[0]) {
            snprintf(out[n].selected_model, sizeof(out[n].selected_model), "runtime-v1:%s:%s:%s@%s",
                     s_agents[i].id, s_agents[i].engine[0] ? s_agents[i].engine : "claude",
                     s_agents[i].model, s_agents[i].effort[0] ? s_agents[i].effort : "auto");
        }
        n++;
    }
    xSemaphoreGive(s_agents_lock);
    return n;
}

// ── inbound ─────────────────────────────────────────────────────────────────────────────────────────

static const char *str_of(const cJSON *o, const char *key)
{
    const cJSON *v = o ? cJSON_GetObjectItemCaseSensitive(o, key) : NULL;
    return cJSON_IsString(v) && v->valuestring ? v->valuestring : NULL;
}

// `swarms`: the whole list, replaced on arrival. Rows missing an id are dropped; a name is optional
// (the window's default is "New swarm", but a blank one still has to be a row that can be picked).
static void handle_swarms(const cJSON *p)
{
    static cable_swarm_t rows[SWARMS_MAX];   // static: 24 × ~76 B is too much for the reader task's stack
    int n = 0;
    const cJSON *it = NULL;
    cJSON_ArrayForEach(it, cJSON_GetObjectItemCaseSensitive(p, "items")) {
        if (n >= SWARMS_MAX) break;
        const cJSON *id = cJSON_GetObjectItemCaseSensitive(it, "id");
        if (!cJSON_IsString(id) || !id->valuestring[0]) continue;
        snprintf(rows[n].id, sizeof(rows[n].id), "%s", id->valuestring);
        const cJSON *name = cJSON_GetObjectItemCaseSensitive(it, "name");
        snprintf(rows[n].name, sizeof(rows[n].name), "%s", cJSON_IsString(name) ? name->valuestring : "");
        const cJSON *agents = cJSON_GetObjectItemCaseSensitive(it, "agents");
        rows[n].agents = cJSON_IsNumber(agents) ? (int)agents->valuedouble : 0;
        n++;
    }
    ui_swarms_replace(rows, n, str_of(p, "selected"));
}

static void session_up(const cJSON *p)
{
    const char *app = str_of(p, "app");
    const cJSON *machine = p ? cJSON_GetObjectItemCaseSensitive(p, "machine") : NULL;
    const char *name = str_of(machine, "name");
    snprintf(s_machine_name, sizeof(s_machine_name), "%s", name ? name : "Machine");
    // The CABLED computer's identity, and what `local` is judged against. Proto 1 put the dial's own MAC
    // here, which named nothing anyone could select.
    const char *mid = str_of(machine, "id");
    if (mid) snprintf(s_machine_id, sizeof(s_machine_id), "%s", mid);
    // Stated in `welcome` so the ✓ is right from the first frame — before any list arrives, which matters
    // after a dial reboot that lands mid-session on a machine that is not this one.
    const char *selected = str_of(p, "selected");
    ui_set_selected_machine(selected && selected[0] ? selected : s_machine_id);

    const bool was = s_session;
    s_session = true;
    ui_set_connected(true);
    if (!was) {
        // Route the log through the link only once a peer is listening. Unplugged — or plugged into a
        // machine with no daemon — the port stays an ordinary console and `idf.py monitor` behaves as it
        // always has. That is the only debugging instrument this single-port board has.
        cable_link_set_log_framing(true);
        ESP_LOGI(TAG, "session up: %s (%s, proto %d)", s_machine_name, app ? app : "daemon",
                 (int)(cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(p, "proto"))
                           ? cJSON_GetObjectItemCaseSensitive(p, "proto")->valuedouble
                           : 0));
        // ASK FOR BOTH, EXPLICITLY. A rebooted dial greets with the same mac and the same firmware, so
        // the daemon's re-attach test reads that greeting as a keepalive and pushes nothing at all — the
        // dial would sit on an empty carousel opposite a daemon convinced it had already spoken.
        send_json(msg("machines.list"));
        send_json(msg("agents.list"));
        // Now that someone is listening: why this boot happened, and what was said before it if the
        // answer is a crash. Framed like every other line, so it lands in the same file.
        last_words_report();
    }
}

static void session_down(const char *why)
{
    if (!s_session) return;
    s_session = false;

    // FORGET THE AGENTS. They belonged to a daemon that is no longer there, and a tile is not a memory —
    // it is a claim that something is running on the other end of this cable right now. Keeping the list
    // up leaves the dial showing agents from whichever computer it was last plugged into, which reads as
    // working rather than as disconnected: the "Not connected" badge is one line of text against a full
    // carousel that says otherwise, and the carousel wins.
    if (s_agents_lock) {
        xSemaphoreTake(s_agents_lock, portMAX_DELAY);
        s_agent_count = 0;
        s_agents_building = false;
        xSemaphoreGive(s_agents_lock);
        ui_request_agent_reload();   // refresh_task reconciles the now-empty list → the tiles go
    }
    // FORGET THE MACHINES, for the same reason. A row is a claim that a computer is reachable right now,
    // and with the cable gone nothing on this side can vouch for any of them. `s_selected_machine` is left
    // alone deliberately: a session that comes back on the same computer should land where it was.
    cable_machines_clear(&s_machines);
    ui_machines_clear();
    s_machine_name[0] = '\0';
    s_machine_id[0] = '\0';
    // Restore the plain console FIRST: whatever follows this point should be readable by a developer with
    // a serial monitor, which is exactly the situation a dropped session puts them in.
    cable_link_set_log_framing(false);
    fw_update_abort("session down");   // no more slices are coming; the running image is untouched
    ESP_LOGI(TAG, "session down (%s)", why);
    ui_set_connected(false);
}

static void handle_agent(const cJSON *p)
{
    const char *id = str_of(p, "id");
    if (!id || !id[0] || !s_agents || !s_agents_lock) return;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    if (s_agents_building && s_agent_count < CABLE_MAX_AGENTS) {
        cable_agent_t *a = &s_agents[s_agent_count++];
        memset(a, 0, sizeof(*a));
        snprintf(a->id, sizeof(a->id), "%s", id);
        const char *name = str_of(p, "name");
        snprintf(a->name, sizeof(a->name), "%s", name && name[0] ? name : id);
        const char *engine = str_of(p, "engine");
        if (engine) snprintf(a->engine, sizeof(a->engine), "%s", engine);
        const char *model = str_of(p, "model");
        if (model) snprintf(a->model, sizeof(a->model), "%s", model);
        const char *effort = str_of(p, "effort");
        if (effort) snprintf(a->effort, sizeof(a->effort), "%s", effort);
        const char *machine_id = str_of(p, "machineId");
        if (machine_id) snprintf(a->machine_id, sizeof(a->machine_id), "%s", machine_id);
        const char *machine = str_of(p, "machine");
        if (machine) snprintf(a->machine, sizeof(a->machine), "%s", machine);

    }
    xSemaphoreGive(s_agents_lock);
}

// The list arrives STREAMED — begin, one message per agent, end — not as one array.
//
// A frame is capped at CABLE_MAX_PAYLOAD, and a hundred agents do not fit in it. One agent per message
// needs no chunk arithmetic and no reassembly, and bounds the message length by construction rather than
// by hoping the names stay short.
static void handle_agents_begin(void)
{
    if (!s_agents_lock) return;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    s_agent_count = 0;
    s_agents_building = true;
    xSemaphoreGive(s_agents_lock);
}

static void handle_agents_end(const cJSON *p)
{
    if (!s_agents_lock) return;
    xSemaphoreTake(s_agents_lock, portMAX_DELAY);
    s_agents_building = false;
    const int n = s_agent_count;
    // How many of them the carousel walks. The daemon puts those first, so one number splits the list;
    // absent (or from an older daemon) means all of them, which is what the dial did before this existed.
    const cJSON *ring = p ? cJSON_GetObjectItemCaseSensitive(p, "ring") : NULL;
    s_ring_agents = cJSON_IsNumber(ring) ? (int)ring->valuedouble : 0;
    xSemaphoreGive(s_agents_lock);
    ESP_LOGI(TAG, "agents: %d", n);
    // app_main's refresh reads the list and rebuilds the tiles. Going through the same request the
    // backend path used means the carousel's landing, naming and removal logic has one implementation.
    ui_request_agent_reload();
}

// ── the machine wheel ───────────────────────────────────────────────────────────────────────────────
// Streamed begin / one row / end, exactly like the agent list and for the same reason: a frame is capped
// at CABLE_MAX_PAYLOAD and the length is bounded by construction rather than by hoping names stay short.
//
// Everything here runs on the USB READER TASK, so the rule is: decide first, touch the UI second. The
// gate in cable_machines_end() is what makes an unchanged list cost a comparison instead of a rebuild.

static bool bool_of(const cJSON *o, const char *key)
{
    return cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(o, key));
}

static void stage_machine(const cJSON *p, const char *id)
{
    if (!cable_machines_add(&s_machines, id, str_of(p, "name"), str_of(p, "state"),
                            bool_of(p, "local"))) {
        // Worth a line: a dropped row means the two halves disagree about the caps, and the symptom on
        // screen is a machine that simply is not there.
        ESP_LOGW(TAG, "machine row dropped: %s", id ? id : "(no id)");
    }
}

static void apply_machines(const char *selected)
{
    // ONE call, one lock, one rebuild — and only when something actually changed.
    ui_machines_replace(s_machines.rows, s_machines.count, selected, s_machines.applied_selected);
}

static void handle_machines_end(const cJSON *p)
{
    const char *selected = str_of(p, "selected");
    const char *source = str_of(p, "source");
    // `source` explains a short list. It is not decoration: one row with no explanation reads as "you own
    // one machine", when the truth may be "this daemon is signed out" or "the backend is unreachable".
    ui_machines_source(source ? source : "backend");
    if (!cable_machines_end(&s_machines, selected)) return;   // identical — no lock, no rebuild
    ESP_LOGI(TAG, "machines: %d (%s)", s_machines.count, source ? source : "?");
    apply_machines(selected);
}

static void handle_machine_updated(const cJSON *p)
{
    const char *id = str_of(p, "id");
    if (!cable_machines_update(&s_machines, id, str_of(p, "name"), str_of(p, "state"),
                               bool_of(p, "local"))) return;
    ESP_LOGI(TAG, "machine.updated %s", id);
    const cable_machine_t *row = cable_machines_find(&s_machines, id);
    if (row) ui_machines_replace_one(row, s_machines.applied_selected);
}

static void handle_message(const cJSON *root)
{
    const char *t = str_of(root, "t");
    if (!t) { s_bad++; return; }
    const cJSON *p = cJSON_GetObjectItemCaseSensitive(root, "p");
    if (!p) p = root;   // flat messages are legal; `p` is a convenience, not a requirement

    if (strcmp(t, "welcome") == 0) { session_up(p); return; }
    if (strcmp(t, "ping") == 0) { send_json(msg("pong")); return; }
    if (strcmp(t, "agents.begin") == 0) { handle_agents_begin(); return; }
    if (strcmp(t, "agent") == 0) { handle_agent(p); return; }
    if (strcmp(t, "agents.end") == 0) { handle_agents_end(p); return; }
    if (strcmp(t, "machines.begin") == 0) { cable_machines_begin(&s_machines); return; }
    if (strcmp(t, "machine") == 0) { stage_machine(p, str_of(p, "id")); return; }
    if (strcmp(t, "machines.end") == 0) { handle_machines_end(p); return; }
    if (strcmp(t, "machine.updated") == 0) { handle_machine_updated(p); return; }
    if (strcmp(t, "machine.selected") == 0) {
        // The ONLY writer of the selection. A tap marks a row pending and waits for this — an optimistic
        // write is how the ✓, the Overview eyebrow and the voice gate end up disagreeing after a refusal.
        ui_machine_selected_ack(str_of(p, "machineId"));
        return;
    }
    if (strcmp(t, "machine.error") == 0) {
        // The daemon owns the code set, so its `message` is shown verbatim rather than mapped through a
        // table here that would go stale the first time a code is added at the other end.
        ui_machine_select_error(str_of(p, "machineId"), str_of(p, "code"), str_of(p, "message"));
        return;
    }
    if (strcmp(t, "models") == 0) { handle_models(p); return; }
    if (strcmp(t, "swarms") == 0) { handle_swarms(p); return; }

    if (strcmp(t, "agent.updated") == 0) {
        // One agent changed. Cheapest correct answer is to re-ask: the daemon is on the other end of a
        // cable, and a full list is a few hundred bytes.
        send_json(msg("agents.list"));
        return;
    }

    const char *agent_id = str_of(p, "agentId");

    if (strcmp(t, "focus") == 0) {
        // The daemon's surface moved. Follow it, so the two screens are one desk.
        if (agent_id) ui_focus_project(agent_id);
        return;
    }
    // One line per turn-state message. This is the seam where "the daemon sent it" and "the tile moved"
    // stop being the same question, and it cost an afternoon of guessing to notice that nothing here said
    // which of the two had failed.
    if (strncmp(t, "turn.", 5) == 0 || strcmp(t, "summary") == 0) {
        ESP_LOGI(TAG, "%s %s", t, agent_id ? agent_id : "(no agentId)");
    }
    if (strcmp(t, "turn.started") == 0) {
        // The TEXT is the status line the tile draws — "Working…", the tool that is running, what the turn
        // is waiting on. Dropping it left the tile holding a live turn with nothing on screen that said so,
        // which reads exactly like the turn never started.
        const char *text = str_of(p, "text");
        if (agent_id) ui_project_emit(agent_id, "", "processing", text ? text : "", NULL);
        return;
    }
    if (strcmp(t, "turn.done") == 0) {
        // `done` stops the spinner and deliberately does NOT ring: a turn's completion is announced by
        // the summary that follows, which is the thing a person can act on. Ringing here as well is how
        // an empty turn produced a beep and a blank notification.
        if (agent_id) ui_project_emit(agent_id, "", "done", "", NULL);
        return;
    }
    if (strcmp(t, "summary") == 0) {
        if (!agent_id) return;
        // TWO DOORS, and which one matters more than it looks. A summary the daemon sends unasked marks a
        // turn that JUST finished: it rings, badges and wakes the screen. One sent while reattaching is
        // history being filled back in — the daemon had it on disk the whole time — and taking that door
        // would make plugging the cable in announce every turn that finished while it was unplugged.
        if (cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "restore"))) {
            ui_project_restore_event(agent_id, "summary", str_of(p, "text"), str_of(p, "recap"));
            return;
        }
        ui_project_emit(agent_id, "", "summary", str_of(p, "text"), str_of(p, "recap"));
        // The beep and the notification both hang off the SUMMARY, never the bare `done`. A real turn
        // emits done THEN summary; an empty or phantom turn emits only done — so a session that briefly
        // registers and vanishes stays silent, and the notification always carries a real recap.
        //
        // These two lines lived in commander_client.c and went out with it. Nothing else calls them, so
        // for a day the dial updated its tile in complete silence: no beep, no wake, nothing in the
        // drawer — the one part of a finished turn a person is not looking at the screen for.
        //
        // THE BEEP ALWAYS SOUNDS. A finished turn is news even when the person is looking straight at
        // it: they are reading the last one, not watching for the next to end, and three tones is how
        // they learn a task is done without moving their eyes.
        audio_notify_done();
        // The NOTIFICATION is what gets withheld. It exists to reach someone who is not looking —
        // waking a dark panel, filing an entry in the drawer — and `quiet` is the daemon saying the
        // desktop window already has this agent on screen. The tile itself is still redrawn above: the
        // recap is what it draws, and a stale tile is a worse lie than a missing badge.
        //
        // The other half of "already looking" is decided inside ui_notify_task_done(), which skips its
        // own work when the dial is awake, on the carousel, and centred on this very agent.
        //
        // Absent field = false, so a daemon that predates this notifies exactly as it always did.
        if (!bool_of(p, "quiet")) {
            ui_notify_task_done(agent_id);   // wake the screen (if off) + record the notification
        }
        return;
    }
    if (strcmp(t, "turn.error") == 0) {
        if (agent_id) ui_project_emit(agent_id, "", "done", "", NULL);
        ui_cable_toast(str_of(p, "message"));
        return;
    }
    if (strcmp(t, "question") == 0) {
        const cJSON *questions = cJSON_GetObjectItemCaseSensitive(p, "questions");
        if (agent_id && questions) ui_question_show(agent_id, "", str_of(p, "id"), questions);
        return;
    }
    // Somebody else answered it. A question is a dialog in a tmux pane, not a shared object, so this is
    // the ONLY way the dial learns that the thing it is waiting on has already been dealt with — without
    // it the screen sits there offering options that no longer key into anything.
    if (strcmp(t, "question.close") == 0) {
        if (agent_id) ui_question_close(agent_id, str_of(p, "id"));
        return;
    }

    if (strcmp(t, "voice.transcript") == 0) {
        const cJSON *conf = cJSON_GetObjectItemCaseSensitive(p, "confidence");
        const bool needs_confirm = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(p, "needsConfirm"));
        ui_voice_routed(!needs_confirm, agent_id == NULL, str_of(p, "routeId"), agent_id,
                        str_of(p, "agentName"), cJSON_IsNumber(conf) ? conf->valuedouble : 1.0);
        return;
    }
    if (strcmp(t, "voice.error") == 0) {
        ui_cable_toast(str_of(p, "message"));   // releases the routing overlay before showing the reason
        return;
    }
    if (strcmp(t, "toast") == 0) { ui_cable_toast(str_of(p, "text")); return; }
    if (strcmp(t, "fw.offer") == 0) {
        const cJSON *size = cJSON_GetObjectItemCaseSensitive(p, "size");
        // Declining is silence: fw_update_offer() answers with `fw.accept` only when it is willing, and
        // the daemon offers again on the next hello.
        fw_update_offer(str_of(p, "version"), cJSON_IsNumber(size) ? (int)size->valuedouble : 0,
                        str_of(p, "sha256"));
        return;
    }

    // A message this build has no case for. Counted, never fatal: it means a daemon running ahead of this
    // firmware, which is a version mismatch someone can act on rather than a fault.
    s_unknown++;
    ESP_LOGD(TAG, "unhandled message '%s'", t);
}

static void on_frame(uint8_t version, uint8_t type, const uint8_t *payload, size_t payload_len, void *ctx)
{
    (void)version;
    (void)ctx;
    s_last_rx_us = esp_timer_get_time();

    if (type == CABLE_TYPE_FW) {
        // Straight to flash, on this task. That is deliberate and it is what the credit window is sized
        // against: the write blocks the reader for ~16 ms per slice, and nothing drains the port
        // meanwhile — see docs/specs/cable-protocol.md §7.
        fw_update_slice(payload, payload_len);
        return;
    }
    if (type != CABLE_TYPE_JSON) {
        // PCM travels the other way; anything else is a peer that knows a payload kind this build does not.
        s_unknown++;
        return;
    }

    // cJSON needs a nul-terminated string and the payload is not one. Copied rather than parsed in place:
    // the decoder's buffer is reused the moment this returns.
    if (payload_len == 0 || payload_len >= JSON_MAX) { s_bad++; return; }
    static char text[JSON_MAX];   // only ever touched on the reader task
    memcpy(text, payload, payload_len);
    text[payload_len] = '\0';

    cJSON *root = cJSON_Parse(text);
    if (!root) { s_bad++; return; }
    handle_message(root);
    cJSON_Delete(root);
}

// ── session task ────────────────────────────────────────────────────────────────────────────────────

static void session_task(void *arg)
{
    (void)arg;
    int64_t next_hello_us = 0;
    while (1) {
        const int64_t now = esp_timer_get_time();

        if (s_session && now - s_last_rx_us > (int64_t)SILENCE_MS * 1000) {
            session_down("silence");
        }

        if (now >= next_hello_us) {
            send_hello();
            next_hello_us = now + (int64_t)(s_session ? HELLO_SESSION_MS : HELLO_ALONE_MS) * 1000;
        }

        vTaskDelay(pdMS_TO_TICKS(250));
    }
}

bool cable_client_start(void)
{
    cable_machines_init(&s_machines);
    s_agents = calloc(CABLE_MAX_AGENTS, sizeof(cable_agent_t));
    s_agents_lock = xSemaphoreCreateMutex();
    s_models_sem = xSemaphoreCreateBinary();
    if (!s_agents || !s_agents_lock || !s_models_sem) {
        ESP_LOGE(TAG, "no memory for the agent list — link disabled");
        return false;
    }
    if (!cable_link_start(on_frame, NULL)) return false;

    s_last_rx_us = esp_timer_get_time();
    ui_set_connected(false);
    if (xTaskCreate(session_task, "cable_session", 4096, NULL, 4, NULL) != pdPASS) {
        ESP_LOGE(TAG, "session task create failed — no handshake");
        return false;
    }
    ESP_LOGI(TAG, "cable client started (fw %s, proto %d)", cable_fw_version(), CABLE_PROTO_VERSION);
    return true;
}

bool cable_client_is_connected(void) { return s_session; }

void cable_client_counters(uint32_t *bad, uint32_t *unknown)
{
    if (bad) *bad = s_bad;
    if (unknown) *unknown = s_unknown;
}
