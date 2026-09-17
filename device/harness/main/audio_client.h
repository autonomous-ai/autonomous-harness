// Records mic PCM into a PSRAM buffer during a PWR-button voice capture, then sends the whole
// utterance over the existing commander WS (voice_start → PCM chunks → voice_end).
#pragma once

#include <stdbool.h>

// Reserve the PSRAM record buffer once at boot (call early, before WiFi, to avoid heap fragmentation).
void audio_client_init(void);

// Which slash command (if any) the backend should put in front of this utterance's transcript. The
// device picks it from the Overview mode select; the backend prepends "/goal " or "/loop " and the
// machine-adapter strips whatever the target engine cannot take.
typedef enum { VOICE_CMD_NONE = 0, VOICE_CMD_GOAL, VOICE_CMD_LOOP } voice_cmd_t;

/**
 * Start a voice turn: capture on the dial, stream over the cable, let the daemon transcribe.
 *
 * ONE entry point, where there used to be five. The old ones differed by what the BACKEND needed told — a
 * project id, a session id, an autonomy mode, whether the router should pick — and none of that is this
 * device's business any more.
 *
 * `agent_id` NULL or "" = spoken from the Overview: the daemon decides from the words which agent they
 * belong to. `cmd` is the one modifier a person can express by how they hold the button.
 */
void audio_client_start_cable(const char *agent_id, voice_cmd_t cmd);

void audio_client_stop(void);

// Quota rejection: stop recording/uploading and discard the utterance without drain/retry/finalize.
void audio_client_abort(void);

bool audio_client_active(void);

// True when `upload_id` belongs to the current or just-finished utterance. Used to accept a final
// quota verdict after voice_end while ignoring delayed frames once a newer utterance has started.
bool audio_client_upload_matches(const char *upload_id);

// True only while capturing mic PCM (false once the clip is uploading). Used by the UI to switch its
// indicator to "Sending…" when capture ends.
bool audio_client_recording(void);

// True once this recording has crossed the speech-energy gate (the user actually spoke). The UI's 15s
// silence watchdog discards a recording that never crosses it (accidental / forgotten Voice press).
bool audio_client_heard_voice(void);
