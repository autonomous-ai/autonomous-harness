// The message layer: what the dial and the harness daemon SAY to each other, on top of the bytes
// cable_link moves. Normative description in docs/specs/cable-protocol.md — that document is written
// twice, here and in cli/src/cable/cableSession.ts of the autonomous-harness repository, with no shared
// code, so it is the only place the two halves agree by construction rather than by coincidence.
//
// Two things this layer owns and nothing else does:
//
//   THE HANDSHAKE. The dial says `hello`, the daemon answers `welcome`, the dial asks for `agents.list`.
//   Until `welcome` lands there is no session and the screen says "Not connected".
//
//   BEING LENIENT. Everything arriving here came off a cable that carries bootloader chatter at every
//   boot and may be talking to a daemon newer than this firmware. A message that cannot be read is
//   discarded and COUNTED — never a reason to drop the link, and never a reason to reboot.
//
// THE VOCABULARY IS OURS: machine → agent → session. One machine (the computer on the other end of the
// cable), N agents inside it (each with its own workspace and engine), and a session is one conversation
// underneath an agent. The sibling firmware this protocol's framing came from calls a tile a "chat" and
// a workspace a "project"; those are its product's words, not ours, and copying them here is how a rename
// that already cost this repository twice starts again.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"

// ── the shapes the UI's tile list is built from ─────────────────────────────────────────────────────
// These lived in http_api.h, which existed for the REST calls this firmware no longer makes. They are
// the protocol's own vocabulary now, so they live with it.
#define ID_MAX   48   // agentId (uuid or 32-hex) + nul
#define NAME_MAX 40

typedef struct {
    char id[ID_MAX];
    char name[NAME_MAX];
    char engine[12];            // claude|codex|cursor|opencode|… ; empty when the daemon did not say
    char selected_model[192];   // opaque runtime-v1:<sid>:<engine>:<model>@<effort>; "" if none
    // WHERE THIS AGENT LIVES. The carousel holds every machine's agents at once, so an agent that does
    // not say which machine it belongs to cannot be placed: `machine_id` is what a machine row uses to
    // find its first agent, and `machine` is the name the switcher draws on its second line.
    // Both are empty against a daemon that predates the fields, and every reader falls back rather than
    // showing an empty line.
    char machine_id[ID_MAX];
    char machine[NAME_MAX];
} project_t;


// The firmware version reported in `hello` and printed at boot, so a device on someone's desk can be
// identified from its log alone.
//
// READ OUT OF THE RUNNING IMAGE — esp_app_get_description()->version — and never from a constant here.
// That is not tidiness; it is the difference between self-update working and looping forever. The daemon
// decides whether to offer an image by comparing this string against the version it has, and two strings
// from two sources cannot be kept equal by anyone.
const char *cable_fw_version(void);

// The MESSAGE-layer version. Separate from CABLE_FRAME_VERSION on purpose and bumped for different
// reasons: adding a message is a change here and needs no new reader, changing the envelope is a change
// there and breaks every reader. Conflating them makes the cheap change look as expensive as the
// expensive one.
// Which product this dial belongs to, stated out loud in every greeting.
//
// The framing magic (cable_frame.h) already makes the sibling product's daemon unable to read us at all,
// which is what actually protects the dial. This is the SECOND lock, and it earns its place twice over:
// it survives anyone later re-unifying the magic or forking this firmware while keeping it, and it turns
// the daemon's log line from "could not parse anything" into "this dial belongs to another product" —
// which is the difference between a diagnosis and a shrug.
//
// The rule at the far end is a POSITIVE match: a greeting that does not name this product is treated as
// foreign, never as "probably ours". Absence has to mean no.
#define CABLE_PRODUCT "harness"

#define CABLE_PROTO_VERSION 3   // 3: + question.close (a question answered on another client)

// Most agents the dial tracks at once — the size of the list this file hands the UI. The UI keeps only a
// thin shell per agent and materialises the heavy content for the active tile ± a window, so a hundred
// costs little more than a dozen.
#define CABLE_MAX_AGENTS 100

// The UI's own ceiling, kept as one name so the layer that receives the list and the layer that renders it
// cannot disagree about how many there can be.
#define MAX_PROJECTS CABLE_MAX_AGENTS

// There is no constant machine id any more. The daemon names the cabled computer in `welcome.machine.id`
// (its real backend machineId, or a `cable:<computerId>` fallback when signed out) and streams the rest of
// the owner's machines as their own rows. A hardcoded id here could not be selected, could not be told
// apart from anyone else's, and was the reason every remote row was a dead end.

// Start the link and the handshake. Returns false only if the USB link itself would not come up, which
// leaves the dial running and showing "Not connected" rather than failing to boot.
//
// Call AFTER ui_init(): the first thing this does is push a link state into the UI.
bool cable_client_start(void);

// Whether `welcome` has been seen and the session is still believed to be live.
bool cable_client_is_connected(void);

// The machine's display name, as `welcome` gave it ("" until then). The dial shows the computer it is
// plugged into, and there is exactly one — the machine picker this firmware used to carry existed for a
// backend that is no longer part of the design.
const char *cable_client_machine_name(void);

// Copy the current agent list into `out`. Returns how many were written.
//
// The list is whatever the daemon last pushed; there is no request/response to wait on, which is the
// point — a spoken turn must never block on a round trip. app_main's refresh reads this the way it used
// to read the backend's RPC answer.
int cable_client_list_agents(project_t *out, int max);

// How many of the agents above the CAROUSEL walks; the rest are known but never swiped to. 0 = all.
int cable_client_ring_count(void);

// ── WHAT THE DIAL SAYS ──────────────────────────────────────────────────────────────────────────────
// Message CONSTRUCTION stays in cable_client.c even for messages whose logic lives elsewhere: voice.c
// owns the microphone and the firmware updater owns the flash, but the vocabulary — every `t` this dial
// emits — is one file's business. A message built in three files is a vocabulary that drifts in three
// directions.

// Ask for the machine wheel. Mirrors `cable_client_list_agents`'s request half.
void cable_client_list_machines(void);

// The user tapped a row. ALWAYS answered — `machine.selected` or `machine.error`, never silence, because
// the dial holds a spinner until one of them lands.
void cable_client_select_machine(const char *machine_id);

// The cabled computer's own machineId, as `welcome` gave it ("" until then). What `local` is judged
// against, and what a select of the local row sends.
const char *cable_client_machine_id(void);

// ── swarms ──────────────────────────────────────────────────────────────────────────────────────────
// The window's swarms: named groups of agents, one of them on screen. The daemon relays the whole list
// in one `swarms` frame whenever it changes, and relays a pick back to the window — which switches, and
// re-describes its desk. The dial never answers a swarm frame; the next `swarms` + agent list IS the
// answer. No window → an empty list, and the tile draws no swarm line.
#define SWARM_ID_MAX 32
#define SWARMS_MAX   24   // the window's own ceiling (AppNotifier.maxSwarms)
typedef struct {
    char id[SWARM_ID_MAX];
    char name[NAME_MAX];
    int  agents;          // how many agents it holds — drawn as a count, never as members
} cable_swarm_t;

// The user tapped a swarm. Not answered — see above.
void cable_client_select_swarm(const char *swarm_id);
// Re-ask for the list (a screen that just opened wants it fresh).
void cable_client_list_swarms(void);

// Send what the user asked for, into `agent_id`. Fire-and-forget: everything after this arrives back as
// `turn.started` / `turn.done`, or as `turn.error` in words a person can act on.
void cable_client_send_turn(const char *agent_id, const char *text);

// Ask the daemon to interrupt that agent's turn, and only that one.
void cable_client_stop_turn(const char *agent_id);

// The tile the carousel settled on. A statement about where the user is LOOKING, not a request to run
// anything — the daemon uses it to keep its own surface in step. Debounced by the caller.
void cable_client_send_focus(const char *agent_id);

// "Put this one in front of me" — a NOTIFICATION was tapped, which is a different verb from turning the
// dial to a tile. Focus says where the eye is and the window moves a tile to match; this asks for a tile
// of its own, because the turn that just finished is a new thing to look at, not a replacement for what
// the person was already watching. The window opens a new one, or reuses its last when the grid is full.
void cable_client_send_open(const char *agent_id);

// One report of a finger on the glass, on its way to the window on the computer.
//
// THE DIAL IS A TOUCHPAD HERE, and this reports MOVEMENT rather than a position: it cannot know how tall
// the terminal on the other end is, so the side that owns the scrollback does the arithmetic.
//
// A stroke is sent in PIECES and carries its own shape — `down`, some `move`s, then `up` — because a
// distance is all a distance can say, and the speed a person means by "swipe" exists only on the glass
// where the samples are. Without the phases a flick and a crawl of the same length move the window the
// same way, which is a wrong that looks complete.
typedef enum {
    CABLE_SCROLL_DOWN,   // finger landed — the window stops whatever it was still coasting through
    CABLE_SCROLL_MOVE,   // travelled `dy` device pixels since the last report (positive = down the glass)
    CABLE_SCROLL_UP,     // finger lifted, carrying the last of the travel and the speed it left at
} cable_scroll_phase_t;

// `velocity` is device px/s, signed like `dy`, and is only read on CABLE_SCROLL_UP — it becomes the fling.
void cable_client_send_scroll(cable_scroll_phase_t phase, int dy, int velocity);

// Answer a `question`. `request_id` is the DAEMON'S, opaque here, and is echoed back byte for byte.
// `answers` is the UI's own object, one entry per question asked, and travels verbatim — re-deriving it
// from what is on screen is how a rename at the far end becomes an answer nobody gave. Not owned here.
void cable_client_answer(const char *agent_id, const char *request_id, const cJSON *answers);

// Runtime model/effort chosen on the tile's chips. The daemon owns what those mean for its engine.
void cable_client_agent_update(const char *agent_id, const char *model, const char *effort);

// One entry of the runtime model/effort catalog. `id` is a full opaque runtime-v1:<sid>:<engine>:<model>@
// <effort> profile string; the UI groups these by model + effort.
typedef struct {
    char id[192];
} model_item_t;

// Fetch one agent's model/effort catalog. BLOCKING — the only round trip in this protocol, because the
// picker cannot be drawn until the list is in hand. Must be called OFF the LVGL task (refresh_task does).
// Returns the count written, or -1 when the daemon did not answer within the timeout.
int cable_client_models_list(const char *agent_id, const char *picker_mode, const char *selected_model,
                             model_item_t *arr, int max);

// ── VOICE ───────────────────────────────────────────────────────────────────────────────────────────
// The dial captures, the daemon transcribes. The device holds no cloud credential and never talks to one.
//
// `agent_id` may be NULL or "", in which case `voice.begin` OMITS the field entirely rather than sending
// an empty one — absence is what tells the daemon it has to route the transcript itself.
//
// `sample_rate` travels because the daemon has to state it to the transcriber, and a rate assumed on that
// side is a rate that silently doubles or halves the speech when this side changes.
void cable_client_voice_begin(const char *agent_id, const char *cmd, const char *lang, int sample_rate);

// One PCM frame's worth of bytes. Raw, not base64 — the framing carries a length, so there is no reason to
// spend a third of the wire escaping binary into text the way a line-delimited protocol had to.
#define CABLE_VOICE_CHUNK 1024

// One PCM chunk as a 0x02 frame. Returns false when the host is not reading, which ends the turn.
bool cable_client_voice_pcm(const uint8_t *pcm, size_t len);

void cable_client_voice_end(void);
void cable_client_voice_abort(const char *why);

// Answer a `voice.transcript` that arrived with `needsConfirm`.
void cable_client_voice_confirm(const char *route_id, const char *agent_id);

// ── FIRMWARE UPDATE ─────────────────────────────────────────────────────────────────────────────────
// Declining an offer is NOT one of these: declining is simply not answering, and the daemon offers again
// on the next `hello`.
void cable_client_fw_accept(void);
void cable_client_fw_progress(uint32_t written);
void cable_client_fw_done(void);
void cable_client_fw_error(const char *message);

// Message-layer health, alongside cable_link_counters()'s framing health.
//
// `bad` counts payloads that were not readable JSON or carried no `t`; `unknown` counts well-formed
// messages this build has no case for, plus frames whose payload TYPE this build does not know. They are
// separate because they mean opposite things: `bad` is corruption or a bug, `unknown` is a daemon running
// ahead of this firmware — a version mismatch someone can act on rather than a fault.
void cable_client_counters(uint32_t *bad, uint32_t *unknown);
