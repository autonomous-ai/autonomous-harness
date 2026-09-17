// The machine-wheel ingest gate, on a laptop.
//
//   device/harness/test/run.sh
//
// What is under test is one question — "did anything actually change?" — and every case here is a way of
// getting that wrong that would look completely normal on the screen. An over-eager `true` costs a wheel
// rebuild on the USB reader task (measured at 31 session restarts an hour before the gate existed); an
// over-eager `false` leaves the dial showing a machine list that is quietly out of date.
#include "../main/cable_machines.h"

#include <stdio.h>
#include <string.h>

static int failures;
static int checks;

static void check(int cond, const char *what)
{
    checks++;
    if (!cond) { printf("  FAIL %s\n", what); failures++; }
}

/** Stage the canonical two-row list. */
static void feed_two(cable_machines_t *m)
{
    cable_machines_begin(m);
    cable_machines_add(m, "mac-local", "MacBook Pro", "ready", true);
    cable_machines_add(m, "m2", "office-imac", "ready", false);
}

int main(void)
{
    printf("cable_machines\n");

    // ── an identical list, in identical order, is a no-op ────────────────────────────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        feed_two(&m);
        check(cable_machines_end(&m, "mac-local") == 1, "first list is a change");
        feed_two(&m);
        check(cable_machines_end(&m, "mac-local") == 0, "identical list is a no-op");
        feed_two(&m);
        check(cable_machines_end(&m, "mac-local") == 0, "still a no-op on the third push");
    }

    // ── every single field is part of the state ──────────────────────────────────────────────────────
    {
        const char *names[]  = { "MacBook Pro", "renamed" };
        const char *states[] = { "ready", "offline" };

        for (int f = 0; f < 2; f++) {
            cable_machines_t m;
            cable_machines_init(&m);
            feed_two(&m);
            cable_machines_end(&m, "mac-local");

            cable_machines_begin(&m);
            cable_machines_add(&m, "mac-local", names[f == 0], states[f == 1], true);
            cable_machines_add(&m, "m2", "office-imac", "ready", false);
            check(cable_machines_end(&m, "mac-local") == 1, "a changed field is a change");
        }
    }

    // ── ORDER IS RENDER ORDER: a swap must not compare equal ─────────────────────────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        feed_two(&m);
        cable_machines_end(&m, "mac-local");

        cable_machines_begin(&m);
        cable_machines_add(&m, "m2", "office-imac", "ready", false);
        cable_machines_add(&m, "mac-local", "MacBook Pro", "ready", true);
        check(cable_machines_end(&m, "mac-local") == 1, "a reordered list is a change");
    }

    // ── the ✓ moving is a change even when every row is identical ────────────────────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        feed_two(&m);
        cable_machines_end(&m, "mac-local");
        feed_two(&m);
        check(cable_machines_end(&m, "m2") == 1, "a moved selection is a change");
    }

    // ── an over-length id is REJECTED, never truncated into an alias ─────────────────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        char long_id[MACHINE_ID_MAX + 8];
        memset(long_id, 'x', sizeof(long_id) - 1);
        long_id[sizeof(long_id) - 1] = '\0';

        cable_machines_begin(&m);
        check(cable_machines_add(&m, long_id, "too long", "ready", false) == 0, "over-length id rejected");
        check(m.count == 0, "a rejected row is not stored");
        // One byte under the cap still fits.
        char ok_id[MACHINE_ID_MAX];
        memset(ok_id, 'y', sizeof(ok_id) - 1);
        ok_id[sizeof(ok_id) - 1] = '\0';
        check(cable_machines_add(&m, ok_id, "at the cap", "ready", false) == 1, "an id at the cap fits");
    }

    // ── the list is bounded; the overflow row is dropped, not written past the end ───────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        cable_machines_begin(&m);
        char id[16];
        for (int i = 0; i < CABLE_MAX_MACHINES; i++) {
            snprintf(id, sizeof(id), "m%d", i);
            check(cable_machines_add(&m, id, id, "ready", false) == 1, "row within the cap is kept");
        }
        check(cable_machines_add(&m, "one-too-many", "x", "ready", false) == 0, "the 11th row is dropped");
        check(m.count == CABLE_MAX_MACHINES, "the count stops at the cap");
    }

    // ── a row outside a begin/end pair is refused ────────────────────────────────────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        check(cable_machines_add(&m, "m1", "stray", "ready", false) == 0, "a row with no begin is dropped");
    }

    // ── update(): patches in place, and only reports a REAL change ───────────────────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        feed_two(&m);
        cable_machines_end(&m, "mac-local");

        check(cable_machines_update(&m, "m2", NULL, "offline", false) == 1, "a state flip is a change");
        check(strcmp(cable_machines_find(&m, "m2")->state, "offline") == 0, "the row was patched");
        check(cable_machines_update(&m, "m2", NULL, "offline", false) == 0, "the same patch twice is a no-op");
        check(cable_machines_update(&m, "nope", NULL, "offline", false) == 0, "an unknown id patches nothing");
        // The name survives a delta that does not carry one.
        check(strcmp(cable_machines_find(&m, "m2")->name, "office-imac") == 0, "an absent name leaves the old one");
    }

    // ── after an update, a re-push of the SAME list must still be a no-op ────────────────────────────
    // Without re-folding the hash inside update(), the next identical list would look different and
    // rebuild the wheel — the exact flap this module exists to prevent, one delta later.
    {
        cable_machines_t m;
        cable_machines_init(&m);
        feed_two(&m);
        cable_machines_end(&m, "mac-local");
        cable_machines_update(&m, "m2", NULL, "offline", false);

        cable_machines_begin(&m);
        cable_machines_add(&m, "mac-local", "MacBook Pro", "ready", true);
        cable_machines_add(&m, "m2", "office-imac", "offline", false);
        check(cable_machines_end(&m, "mac-local") == 0, "a list matching the patched state is a no-op");
    }

    // ── clear() forgets everything, and the next list is a change again ──────────────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        feed_two(&m);
        cable_machines_end(&m, "mac-local");
        cable_machines_clear(&m);
        check(m.count == 0, "clear empties the rows");
        check(cable_machines_find(&m, "mac-local") == NULL, "a cleared row is not findable");
        feed_two(&m);
        check(cable_machines_end(&m, "mac-local") == 1, "the same list after a clear is a change");
    }

    // ── an empty list is a legitimate state, and repeating it is still a no-op ───────────────────────
    {
        cable_machines_t m;
        cable_machines_init(&m);
        feed_two(&m);
        cable_machines_end(&m, "mac-local");
        cable_machines_begin(&m);
        check(cable_machines_end(&m, "") == 1, "emptying the list is a change");
        cable_machines_begin(&m);
        check(cable_machines_end(&m, "") == 0, "staying empty is a no-op");
    }

    printf("  %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
