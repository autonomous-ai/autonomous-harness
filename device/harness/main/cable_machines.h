// The machine wheel's ingest logic, with no LVGL, no cJSON and no ESP-IDF in it.
//
// Split out for one reason: it is the only part of this feature that can be wrong in a way the eye does
// not catch. A wheel that renders is obviously right; a wheel that re-renders on every arriving greeting
// looks identical and is the failure this whole file exists to prevent.
//
// ── WHY THERE IS A HASH HERE AT ALL ─────────────────────────────────────────────────────────────────
// The daemon already refuses to send an unchanged list. That is not enough on its own, and the reason is
// specific: the daemon's own diff key resets to empty on every port reopen — which any 20 s of silence
// causes — while the dial's model survives, so the daemon legitimately re-pushes a list the dial already
// has. Without this second gate, a nudged cable costs a full rebuild.
//
// Measured on hardware 2026-08-24, before this existed: an unguarded rebuild on the USB reader task ran
// 31 session restarts per HOUR, wiping the agent list each time, with the screen parked on "0 agents"
// while the daemon's log truthfully said it had sent two.
//
// ORDER IS PART OF THE STATE. It is render order, so two lists differing only by a swap are a real
// change and must NOT compare equal.
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Most machines the wheel holds. A person does not own more than this, and a fixed array means no
// allocation can fail halfway through an ingest.
#define CABLE_MAX_MACHINES 10

// Wire caps. `id` is 47 + nul to match ID_MAX; a longer id is REJECTED rather than truncated — two
// machines whose ids differ past the cut would alias onto one row and the ✓ would land on the wrong one.
#define MACHINE_ID_MAX   48
#define MACHINE_NAME_MAX 40
#define MACHINE_STATE_MAX 12

typedef struct {
    char id[MACHINE_ID_MAX];
    char name[MACHINE_NAME_MAX];
    char state[MACHINE_STATE_MAX];   // "ready" | "offline" | "unknown" | "needs-link"
    bool local;
} cable_machine_t;

// One list being assembled between `machines.begin` and `machines.end`.
typedef struct {
    cable_machine_t rows[CABLE_MAX_MACHINES];
    int      count;
    bool     building;
    uint32_t hash;        // running FNV-1a over the rows, folded in arrival order
    uint32_t applied_hash;
    int      applied_count;
    char     applied_selected[MACHINE_ID_MAX];
} cable_machines_t;

void cable_machines_init(cable_machines_t *m);

// Start a list. Clears the staging rows; the APPLIED state is untouched, because it is what the next
// `end` compares against.
void cable_machines_begin(cable_machines_t *m);

// Append one row. Returns false when it was dropped — an over-length id, an over-full list, or a row
// arriving outside a begin/end pair. A drop is worth logging: it means the two halves disagree.
bool cable_machines_add(cable_machines_t *m, const char *id, const char *name,
                        const char *state, bool local);

// Close the list. Returns true when it DIFFERS from what was last applied — i.e. when the caller should
// actually touch the UI. Returns false for an identical list, having spent one comparison and no lock.
//
// `selected` is part of the comparison: the ✓ moving is a change even when every row is identical.
bool cable_machines_end(cable_machines_t *m, const char *selected);

// Patch one already-applied row in place (a `machine.updated` delta). Returns true when something
// actually changed, so the caller can skip a rebuild that would yank the wheel out from under a thumb.
bool cable_machines_update(cable_machines_t *m, const char *id, const char *name,
                           const char *state, bool local);

// Forget everything. For a session that ended: a row is a claim that something is reachable RIGHT NOW,
// and with the cable gone none of them are.
void cable_machines_clear(cable_machines_t *m);

// Look up an applied row by id, or NULL. Used to answer "is the selected machine local / reachable".
const cable_machine_t *cable_machines_find(const cable_machines_t *m, const char *id);
