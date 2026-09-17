// LVGL screens for the commander device (round 466x466). Thread-safe: each function
// takes the LVGL lock internally (display_lock/unlock), so the HTTP / WS tasks may call
// them directly.
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>   // size_t (ui_project_id_at)
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"   // TaskHandle_t — ui_set_reload_waiter
#include "config_store.h"
#include "../cable_machines.h"   // cable_machine_t — the wheel's row, already parsed and diffed
#include "../cable_client.h"     // cable_swarm_t — one of the window's tabs, as the wire carries it

struct cJSON;

// Per-agent Mode/Model control chips: TEMPORARILY hidden (0) until the prod backend supports voice_start
// "mode" + the agent_update model RPC. Flip to 1 to re-enable — this also re-narrows touch.c's notif
// pull-zone (so taps on the chips above the name land) and shows the chips in ui_screens.c.
#define AGENT_CTL_CHIPS 1

// The Effort chip on the agent tile. OFF (0) since the recap screen became the "Done" screen
// (mockup/recap-done.html): effort is set before a turn runs, and that tile is what you read after one
// finished. The wheel behind it is still built and still sends the same agent_update — only the way in
// is gone, so this is a one-character restore.
#define AGENT_EFFORT_CHIP 0

void ui_init(void);

// Set screen brightness (0x00 dimmest .. 0xFF max) — software dim overlay + best-effort panel DCS.
// Call after ui_init(). The Settings brightness slider and the boot restore both use this.
void ui_set_brightness(uint8_t level);

// --- Full-screen states ---
// The one full-screen state left from what used to be a setup flow: a spinner and a line of text, shown
// while the dial has not heard from a daemon yet. Provisioning, the setup chooser, the WiFi portal and
// the pairing screens all belonged to a device that had to get itself onto a network and prove who it
// was. A cable answers both by existing.
void ui_show_pairing(const char *user_code, int seconds_left); // big code + countdown
// E2EE pairing (remote machine): show the 6-char code the user types into `machine pair <code>`; and the
// post-pair fingerprint confirmation (auto-advances to the projects screen). Driven by the e2ee manager.
void ui_show_e2ee_pair(const char *code, int seconds_left);
void ui_show_e2ee_paired(const char *fingerprint);
void ui_show_connecting(const char *step);

// Settings → Wifi: open the picker (switch between saved networks; "New wifi" opens the setup portal).
// app_main drains a pending wifi switch (user tapped a saved network in the picker). Returns true once
// and copies the chosen network into *out; app_main then remembers it (front of the list) and reboots.
void ui_show_error(const char *title, const char *detail);
// Brief pre-reboot splash (spinner + "New update" / "Restarting…") shown just before rebooting into the
// dedicated OTA updater. No progress — nothing is downloading yet.
void ui_show_ota_restarting(void);
void ui_show_unpaired(void);   // brief splash before rebooting to the pair screen after account revoke
// Minimal OTA boot-mode progress screen (self-contained, no ui_init needed) — used by ota_boot_check.
void ui_ota_boot_show(const char *version);
void ui_ota_boot_pct(int pct);
// If the error screen is currently shown, return to the projects view (used on commander reconnect
// so a transient WS close doesn't leave the device stuck on a stale error).
void ui_leave_error_screen(void);

// --- Projects tileview (swipe left/right between an agent's projects) ---
// Switch to the tileview state (shows whatever project tiles exist).
void ui_show_projects(void);

// Boot landing: park on the Overview tile (no "No agents" flash) and arm a landing so that once the saved
// machine's agents load, ui_land_after_reload slides to agent 0 — or stays on the Overview tile if it's empty.
void ui_enter_boot_loading(void);
void ui_land_after_reload(void);
// Remote adapter node is unavailable: clear stale agents and show the Overview join guide. When it
// reconnects, switch the guide to the agent-list spinner; ui_land_after_reload restores the normal UI.
void ui_enter_remote_offline(void);
// The selected machine is reachable but this daemon holds no pinned key for it, so nothing on it can be
// read. An INSTRUCTION state, not an error: the Overview shows the two commands that fix it.
void ui_enter_link_guide(void);
void ui_leave_remote_offline_loading(void);
// Global commander connection indicator (shown on every tile's header).
void ui_set_connected(bool connected);
// Node (paired machine) online↔offline from the `node_status` frame — distinct from ui_set_connected
// Ensure a tile exists for project_id (creates one if new). Safe to call repeatedly.
// Set/refresh the human name shown on a project's tile.
void ui_project_set_name(const char *project_id, const char *name);
// Set the engine shown below an agent name. Invalid/empty values leave the label blank.
void ui_project_set_engine(const char *project_id, const char *engine);

// Which machine an agent lives on. The carousel spans machines, so this is what the switcher's second
// line shows and what a machine row uses to find the first agent to land on.
void ui_project_set_machine(const char *project_id, const char *machine_id, const char *machine);

// Fill only agents whose engine is still unknown (used when machine connected.engine arrives after list).
void ui_project_fill_missing_engine(const char *engine);
// Runtime model/effort (remote machines): store the opaque runtime-v1 profile and repaint the Model/Effort
// chips. set_ is authoritative (agent_synced, clears the optimistic hold); reconcile_ is the guarded poll
// path (keeps a just-made local change on-screen until the adapter catches up).
void ui_project_set_selected_model(const char *project_id, const char *runtime_id);
void ui_project_reconcile_selected_model(const char *project_id, const char *runtime_id);
// Drained once per tick by app_main's refresh_task: if a Model/Effort chip was tapped, run the blocking
// models_list RPC (off the LVGL task) and build the picker screen.
void ui_service_model_picker(void);

// Remove a project's tile (session ended / tmux pane gone). No-op if the id isn't shown.
void ui_project_remove(const char *project_id);
// Copy the id of the project tile at index i into buf; false if out of range (poll reconcile).
bool ui_project_id_at(int i, char *buf, size_t n);
// Number of project tiles currently shown (for naming "Project N").
int ui_project_count(void);
// Current focused project index, or -1 when the carousel is on Settings/Machines/empty.
int ui_get_active_project_index(void);
// True once this project already has a card/model event, so refresh_task can skip a lazy recent fetch.
bool ui_project_has_event(const char *project_id);
// True when a tile for this agent already exists. An UNKNOWN id must not be turned into a tile from an
// event frame — see the commander_client handlers, which ask for the authoritative list instead.
bool ui_project_known(const char *project_id);
// True while the project's live turn is processing. Historical recap restore must not replace this state.
bool ui_project_is_busy(const char *project_id);
// Clear any "Working…" tile orphaned when its turn-done was lost or never produced. Acts on heartbeat
// absence: a live turn re-emits 'processing' every ~5s (adapter + node), so a tile silent for >25s is gone.
// A genuinely-live turn keeps stamping and is never cut short. Call from the ~1s refresh loop. Returns #cleared.
int ui_prune_stale_busy(void);
// True when the projects tileview is the active screen (gate the long-press create trigger).
bool ui_is_projects_active(void);
// True while the full-text detail reader screen is active (touch.c gives it a tight, reader-only gesture set).
bool ui_reader_is_open(void);
// Height (px) of the top notification pull-down zone for the CURRENT tile: narrow (44) on an agent tile so
// the Mode/Model chips still get taps, full band (90) on Overview/Settings/Machines. touch.c reads it per press.
int ui_notif_pull_zone_px(void);
/** True while a chooser wheel covers the face — its own controls own the top band, not the pull-down. */
bool ui_picker_is_open(void);
// Circular swipe (driven by touch.c): begin records the tile at press-down; end(+1 right / -1 left)
// wraps first-project↔Settings when the swipe was an edge swipe (position unchanged since press-down).
void ui_swipe_begin(void);
void ui_swipe_end(int dir);
// Vertical edge-swipe (touch.c): +1 = up (project → open detail reader), -1 = down (reader top → close).
// True while a vertical drag should be reported to the computer as a scroll — an agent tile (where the
// dial itself has nothing to scroll) or the detail reader (where both surfaces move). See the definition
// for why every other screen says no.
bool ui_scroll_reportable(void);
// "Home" gesture (touch.c): a swipe-up that STARTED at the bottom edge → jump to the Overview tile from
// any screen (closes the notif drawer / leaves the reader/wifi/picker, then centers ring 0).
void ui_home_overview(void);
// Voice-state queries for the gesture layer: is_recording = actively capturing (a tap stops it);
// is_active = recording OR the clip still uploading (blocks a new start).
bool ui_voice_is_recording(void);
/** Tick at which the current voice turn began — lets a gesture tell "already running" from "I just started it". */
uint32_t ui_voice_start_tick(void);
bool ui_voice_is_active(void);
// True when a screen-space touch begins inside one of the round actions — the Overview's row or an agent
// tile's three arc marks. touch.c uses this to keep the screen-wide double-tap / hold gestures from firing
// on top of a normal LVGL button press.
bool ui_action_hit(uint16_t x, uint16_t y);
// A plain tap (touch.c, when not recording): on the detail reader → back to projects; else no-op.
// A resolved single tap, at its PRESS coordinates in screen space. The point decides what it opens:
// only a tap landing on the "Done" block opens the detail reader.
void ui_tap(int32_t x, int32_t y);
// Notification centre (touch.c drives open/close): open = pull-down from the top edge; close = swipe-up /
// tap. is_open lets the gesture layer route input to the drawer instead of voice/detail.
void ui_notif_open(void);

// The agent switcher: a picker over the most recent agents, opened by pulling down from the top. It took
// that gesture from the notification drawer, which now opens on a tap of the bell — see ui_screens.c.
bool ui_switch_is_open(void);
void ui_switch_open(void);
void ui_notif_close(void);
bool ui_notif_is_open(void);
// True when a press lands on the bell pill. touch.c asks before capturing the top band, so the one
// button that lives inside that band can be pressed — the drawer opens from the bell and nowhere else.
bool ui_notif_pill_hit(uint16_t x, uint16_t y);
// A swipe-up inside the open drawer → close it, but only if the list is already scrolled to the top
// (otherwise the gesture is just scrolling the list).
void ui_notif_swipe_up(void);
// Settings-tile action requests, drained by app_main's refresh_task (blocking work off the LVGL task):
// "Change WiFi" (→ enter_portal). Return true once per tap.
bool ui_take_portal_req(void);
// No-WiFi "Retry" tap → app_main should retry the saved networks immediately. Returns true once per tap.
bool ui_take_wifi_retry_req(void);
// Show/hide the "Creating…" loading indicator while a new project is being created.
void ui_set_creating(bool on);

// --- The machine wheel (the carousel's last ring) ---
//
// The dial holds a LIST of the owner's machines and exactly one is selected; its agents are what the
// carousel shows. The agent id space stays flat and unscoped, so switching machine is simply "the agent
// list changed" as far as every other part of this file is concerned.
//
// The rows arrive already parsed and already DIFFED — cable_machines.c answers "did anything change?"
// on the reader task, before any of this is called. Nothing here re-checks that, and nothing here should
// be called for an unchanged list: an unguarded rebuild on every arriving greeting measured out at 31
// session restarts an hour, with the agent list wiped each time.

// Open the wheel (the last carousel ring). Used by the error path to show the user where they are.
void ui_show_machines(void);

// Replace the whole wheel from one streamed list. `selected` is the machine whose agents are on screen;
// `previous` is what it was, so a switch can be told from a refresh without a second call.
void ui_machines_replace(const cable_machine_t *rows, int count, const char *selected, const char *previous);

// Patch one row (a `machine.updated` delta). Already known to be a real change.
void ui_machines_replace_one(const cable_machine_t *row, const char *selected);

// Why the list is as short as it is: "backend" | "local" | "signed-out". Drives the empty-state copy, so
// one row reads as "this daemon is signed out" rather than as "you own one machine".
void ui_machines_source(const char *source);

// The session ended: drop every row. A row is a claim that a computer is reachable RIGHT NOW.
void ui_machines_clear(void);

// Record the selection `welcome` states, without clearing anything — the list is already on its way.
void ui_set_selected_machine(const char *machine_id);

// The daemon acknowledged a select. THE ONLY WRITER of the selection — a tap marks a row pending and
// waits for this, because an optimistic write leaves a lie on screen when the select is refused.
void ui_machine_selected_ack(const char *machine_id);

// The daemon refused a select. `message` is shown verbatim; `code` only picks the SHAPE of the answer —
// `NEEDS_LINK` opens the link guide (an instruction, not an error), everything else is a toast.
void ui_machine_select_error(const char *machine_id, const char *code, const char *message);

// Re-render the wheel if it is the visible page.
void ui_machines_refresh(void);

// --- Swarms (the window's tabs; see the block in ui_screens.c) ---
// Replace the whole list from one `swarms` frame. `selected` names the one the window has on screen; it
// is what every tile's swarm line draws. count 0 hides the line. Safe from the reader task.
void ui_swarms_replace(const cable_swarm_t *rows, int count, const char *selected);

// Whether the selected machine is the computer at the other end of this cable. Everything that acts on
// "this desk" — the focus report, the scroll report — asks this first.
bool ui_selected_machine_is_local(void);

// Drain the select deadline. Called from refresh_task, off the LVGL task; drops the spinner and shows the
// reason when the daemon never answered.
void ui_tick_machine_select(void);

// A machine was (re)selected → app_main should reload the agent tiles for it. Set by the client on the
// `machine_selected` ack; drained once per request by app_main's refresh_task.
// Which way a drag on an agent tile moves the window's scrollback. Read by touch.c, which signs the report
// before it leaves the device; set from Settings › Scroll and persisted in NVS. False = the text follows
// the finger (the original behaviour and the default), true = the view does.
bool ui_scroll_is_reversed(void);

void ui_request_agent_reload(void);
// The task that applies a pushed list (app_main's refresh_task). Given its own handle so a push can WAKE
// it rather than wait for its next tick — see ui_apply_pending_focus for what that second cost.
void ui_set_reload_waiter(TaskHandle_t task);
// Land a focus that arrived before the list it needed. The daemon pushes the ring and then the focus, but
// the ring is applied by refresh_task a tick later, so a focus naming an agent that was not yet on the
// carousel is HELD (ui_focus_project) rather than dropped — this is what lands it, and refresh_task calls
// it once the rebuilt list is on screen. No-op when nothing is held.
void ui_apply_pending_focus(void);
bool ui_take_agent_reload_req(void);
bool ui_peek_agent_reload_req(void);   // non-consuming check (a slow per-agent restore bails on a new machine select)
// Put the tiles in the order `ids` gives. Without this the carousel keeps the order it FIRST saw agents
// in — ui_project_set_name appends — and once that disagrees with the list there is no path back.
// How many of the agents just pushed the CAROUSEL walks; the rest are known but not swiped to (they
// still count on the overview and list in the switcher). 0 = all of them. See ui_screens.c's ring_agents.
void ui_project_set_ring_count(int n);

// Tell the window where the dial is looking, on purpose. ONLY for a move a person made through something
// other than a swipe (the switcher, a notification): those go through code, and code-driven moves are
// deliberately silent — see carousel_goto in ui_screens.c.
void ui_report_active_agent(void);

void ui_project_apply_order(const char *const *ids, int n);
// Drop every agent tile from the current machine model (used when no machine remains selected).
void ui_project_clear_all(void);
// Switch the tileview to a project's tile (called after creating one so it shows immediately).
void ui_focus_project(const char *project_id);

// Voice router result (from the `voice_routed` frame after an Overview voice turn). `auto_sent` = the backend
// already dispatched (just focus the tile); otherwise the transcript is held and the device confirms via
// commander_route_confirm. `need_new` = no agent fit. Runs on the commander-WS task (takes the display lock).
void ui_voice_routed(bool auto_sent, bool need_new, const char *route_id, const char *agent_id,
                     const char *agent_name, double confidence);
// Backend abandoned an Overview route voice (empty transcript / STT or router error) → drop the loading
// overlay now instead of waiting out the routing watchdog. No-op unless a route voice is waiting.
void ui_voice_route_abort(void);
// One short line from the cabled Mac (a routing refusal, a send that did not land). Releases the routing
// overlay first, then shows the message for ~2s over whatever is on screen.
void ui_cable_toast(const char *msg);
// Backend daily voice quota. Status caps the current recording to the remaining allowance; exceeded
// stops capture, restores the previous screen and shows a short non-fatal toast.
void ui_voice_quota_status(int remaining_seconds);
void ui_voice_quota_exceeded(void);
// A turn finished for this project → wake the screen (if off) and jump to that project's tile. Called
// on the completion beep so the user always lands on the finished project.
void ui_notify_task_done(const char *project_id);
// Append a commander event to a project's tile as a readable text card (keeps the last 2).
// kind: "say" | "act" | "ask" | "done" | "error". session_id is the dbSessionId for voice resume.
// `recap` (optional, may be NULL): a short headline shown on the tile at a glance; `text` is the
// fuller body shown in the tap-to-read reader. When `recap` is NULL the tile previews `text`.
void ui_project_emit(const char *project_id, const char *session_id, const char *kind, const char *text, const char *recap);
// Restore a persisted historical card without changing the live busy lifecycle for this project.
void ui_project_restore_event(const char *project_id, const char *kind, const char *text, const char *recap);
void ui_project_clear_event(const char *project_id);
// Ack of a cancel we sent: clear the matching project's transient "processing" status (the killed
// turn won't emit a 'done'). Matches by session_id; no-op if not found.
void ui_cancel_acked(const char *session_id);
// Update the live output-token count shown in a project's working-status row while it's processing.
void ui_project_set_busy_tokens(const char *project_id, int tokens);
// Render the working Todo checklist (below the project name) from the processing event's `todos`
// array ([{c,s}]). NULL/empty clears it. Windows to 5 rows centred on the in_progress task.
void ui_project_set_todos(const char *project_id, const struct cJSON *todos);

// Set the live "current tool" block shown just above the Working… status while processing. Two lines,
// overwritten each call: line 1 = `tool_name` (colored with `color_hex`, e.g. "#64d2ff") + `title`
// (muted, may be NULL/empty); line 2 = `detail` (muted raw arg — the query/command/url — NULL/empty
// hides it, wraps up to 3 lines then "…"). Backend pre-formats everything. Cleared when the turn ends.
void ui_project_set_tool(const char *project_id, const char *tool_name, const char *title, const char *color_hex, const char *detail);

// Render the sub-agent (Task/Agent delegation) list above Working… from the backend's `agents` array
// ([{text, title, color}]). Running rows are "› type" (orange) + description; done rows "✓ type" (green)
// + "N tools · Xs". Backend sends the full list each change; NULL/empty clears it. While processing only.
void ui_project_set_agents(const char *project_id, const struct cJSON *agents);

// --- AskUserQuestion (agent asks; user answers from the device) ---
// Show the question screen: tap an option row to answer (single/multi-select). Tap-only — there is no
// voice answer. `questions` is the cJSON array from the `commander_question` frame; copied out
// synchronously, so the caller may free the JSON right after this returns.
void ui_question_show(const char *project_id, const char *session_id, const char *request_id, const struct cJSON *questions);
// That question was answered somewhere else (the app, or the pane by hand) — leave the screen instead of
// waiting for an answer that can no longer be delivered. No-op unless THIS request is the one on screen.
void ui_question_close(const char *project_id, const char *request_id);


// --- Voice (hold-to-talk) ---
// (No setup call: voice streams over the commander WS, so it needs no address or credential of its own.)
// projectId of the currently-visible tile (or "" if none).
const char *ui_get_active_project_id(void);
// latest sessionId for the currently-visible tile (or "" if none seen yet).
const char *ui_get_active_session_id(void);
// Start/stop streaming voice for the active project (called by the physical PTT button
// or the on-screen mic button). Safe to call from a non-LVGL task.
void ui_voice_start(void);
void ui_voice_start_goal(void);   // long-press 3s → record a GOAL command (voice_start header goal:true)
void ui_voice_stop(void);

// Cancel the running turn of the visible project. No-op if the active tile isn't processing. Safe to
// call from a non-LVGL task.
void ui_stop_active_turn(void);

// Physical BOOT button pressed. Routes to "back" (cancel voice / dismiss the question) while a
// question is on screen, otherwise to ui_stop_active_turn(). Safe from a non-LVGL task.
void ui_boot_pressed(void);

// --- Screen lock (3×3 pattern passcode) ---
// Wire the sleep/wake power hook and lock now if a passcode is set (called once at the end of ui_init).
void ui_lock_init_gate(void);
// Settings entry: set a new passcode, or — if one already exists — draw the current pattern to disable it.
void ui_lock_setup(void);
// True while the unlock overlay is blocking the UI.
bool ui_lock_active(void);

// One line on the log whenever what covers the face changes (screen, overlay, drawer, lock, sleep).
// Called from the LVGL task every loop; cheap when nothing changed.
void ui_log_state_if_changed(void);
