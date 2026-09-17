#include "carousel_ring.h"

// A modulo that answers in 0..m-1 for negative input too. C's % keeps the sign of the dividend, and a
// carousel scrolled leftwards from its start has genuinely negative columns.
static int mod_floor(int a, int m)
{
    if (m <= 0) return 0;
    int r = a % m;
    return r < 0 ? r + m : r;
}

int carousel_ring_of_col(int c, int m, int dir)
{
    return mod_floor(dir * c, m);
}

int carousel_col_for_ring_near(int cc, int r, int m, int dir)
{
    if (m <= 0) return cc;
    // Steps counted in RING space, spent in COLUMN space. The two are the same thing only when dir is +1;
    // when the ring runs the other way, gaining `fwd` ring positions costs `-fwd` columns. Conflating them
    // is the mirror bug this file exists to make visible.
    const int fwd = mod_floor(r - carousel_ring_of_col(cc, m, dir), m);
    const int back = m - fwd;
    return (fwd <= back) ? (cc + dir * fwd) : (cc - dir * back);
}
