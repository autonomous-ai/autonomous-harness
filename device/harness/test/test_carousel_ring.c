// The carousel's column ↔ ring map, both directions.
//
// This is the file that exists because the mirror bug is invisible: reversing the swipe and getting the
// arithmetic wrong still lands every jump on a real tile, so the board shows a working carousel that goes
// the wrong way — and only sometimes, because half the jumps are their own mirror.
#include "../main/ui/carousel_ring.h"
#include <stdio.h>
#include <stdlib.h>

static int fails;
static void check(int got, int want, const char *what)
{
    if (got == want) return;
    printf("FAIL %s: got %d want %d\n", what, got, want);
    fails++;
}

int main(void)
{
    // A ring of 5: overview(0), agents 1..2, Settings(3), Machines(4).
    const int m = 5;

    // ── forwards: one column right is one ring position on ─────────────────────────────────────────
    check(carousel_ring_of_col(0, m, 1), 0, "fwd col 0");
    check(carousel_ring_of_col(3, m, 1), 3, "fwd col 3");
    check(carousel_ring_of_col(7, m, 1), 2, "fwd wraps");
    check(carousel_ring_of_col(-1, m, 1), 4, "fwd negative column");   // C's % would say -1

    // ── reversed: one column right is one ring position BACK ───────────────────────────────────────
    check(carousel_ring_of_col(0, m, -1), 0, "rev col 0");
    check(carousel_ring_of_col(1, m, -1), 4, "rev col 1");
    check(carousel_ring_of_col(3, m, -1), 2, "rev col 3");
    check(carousel_ring_of_col(-2, m, -1), 2, "rev negative column");

    // ── every column, both directions: the map and its inverse agree ───────────────────────────────
    // The property that matters: the column a jump picks really does hold the ring position asked for.
    // A mirrored implementation passes every spot check that happens to be symmetric; it cannot pass this.
    for (int dir = -1; dir <= 1; dir += 2) {
        for (int cc = -12; cc <= 12; cc++) {
            for (int r = 0; r < m; r++) {
                const int col = carousel_col_for_ring_near(cc, r, m, dir);
                if (carousel_ring_of_col(col, m, dir) != r) {
                    printf("FAIL dir=%d cc=%d r=%d: col %d holds ring %d\n",
                           dir, cc, r, col, carousel_ring_of_col(col, m, dir));
                    fails++;
                }
                if (col - cc > m / 2 || cc - col > m / 2) {
                    printf("FAIL dir=%d cc=%d r=%d: col %d is not the NEAREST\n", dir, cc, r, col);
                    fails++;
                }
            }
        }
    }

    // ── the walk itself, which is what the user is asking about ────────────────────────────────────
    //
    // A COLUMN IS NOT A RING POSITION. Column 2 holds ring 2 only in the forward direction; reversed, it
    // holds ring 3. Writing this check as `ring_of_col(2 ± 1)` is the exact mistake that made the last
    // attempt at this feature look broken when the code was right — so the column is DERIVED here, the
    // way every caller in the firmware derives it.
    for (int dir = -1; dir <= 1; dir += 2) {
        const int col = carousel_col_for_ring_near(0, 2, m, dir);   // wherever agent 2's tile lives
        check(carousel_ring_of_col(col, m, dir), 2, "standing on ring 2");
        // A swipe LEFT drags the strip one column on, whichever way the ring runs underneath it.
        check(carousel_ring_of_col(col + 1, m, dir), dir > 0 ? 3 : 1,
              dir > 0 ? "natural: swipe left goes on" : "reversed: swipe left goes back");
        check(carousel_ring_of_col(col - 1, m, dir), dir > 0 ? 1 : 3,
              dir > 0 ? "natural: swipe right goes back" : "reversed: swipe right goes on");
    }

    // ── a one-agent ring (m == 2) still behaves; it is the shape the cover-leading path guards ─────
    for (int dir = -1; dir <= 1; dir += 2)
        for (int cc = -4; cc <= 4; cc++)
            for (int r = 0; r < 2; r++)
                check(carousel_ring_of_col(carousel_col_for_ring_near(cc, r, 2, dir), 2, dir), r, "m=2 round trip");

    if (fails) { printf("%d failure(s)\n", fails); return 1; }
    printf("carousel_ring: ok\n");
    return 0;
}
