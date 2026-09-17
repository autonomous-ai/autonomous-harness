#pragma once

// The carousel's column ↔ ring map, alone and testable.
//
// The dial's carousel is one strip of columns scrolled natively by LVGL, and a RING of pages laid over it
// by modulo: overview, then the agents, then Settings and Machines, repeating forever in both directions.
// Everything the carousel does — which tile is centred, where each tile is positioned, where a jump lands
// — is one of these two questions asked in one of two directions.
//
// It lives in its own file because it is arithmetic, and arithmetic is the part of this feature that can
// be WRONG WITHOUT LOOKING WRONG: every jump still lands on a real tile, just a mirrored one. On the board
// that costs a flash cycle and a squint; here it costs a `cc` invocation (see test/run.sh).
//
// `dir` is +1 when walking columns rightwards walks the ring forwards, and -1 when the user has reversed
// the swipe direction in Settings. `m` is the ring length. Neither is remembered here: this file holds no
// state, so nothing can drift between what the map thinks and what the screen is doing.

/** Which ring position column `c` holds. Always 0..m-1, for any sign of `c`. */
int carousel_ring_of_col(int c, int m, int dir);

/** The column NEAREST `cc` that holds ring position `r` — for every jump, focus and landing. */
int carousel_col_for_ring_near(int cc, int r, int m, int dir);
