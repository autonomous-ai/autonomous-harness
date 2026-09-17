#!/usr/bin/env bash
# Host tests for the parts of the firmware that do not need the board.
#
#   device/harness/test/run.sh
#
# No ESP-IDF, no flash cycle, no cable: cable_frame.c compiles with a plain compiler on purpose, so the
# framing both halves of the link depend on can be checked in milliseconds. Run it before touching either
# half — the daemon's TypeScript decoder asserts against the same vectors, and a change here that is not
# a change there is a link that opens and then delivers nothing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

# The vectors are generated, not written. Regenerating first means a stale file cannot pass as agreement.
python3 "$here/../scripts/gen_cable_vectors.py" --check

cc -std=c11 -Wall -Wextra -Werror -O1 \
   -o "$out/test_cable_frame" "$here/test_cable_frame.c" "$here/../main/cable_frame.c"
"$out/test_cable_frame" "$here/vectors/cable_frame.txt"

cc -std=c11 -Wall -Wextra -Werror -O1 \
   -o "$out/test_cable_machines" "$here/test_cable_machines.c" "$here/../main/cable_machines.c"
"$out/test_cable_machines"

# The carousel's column<->ring map. Pure arithmetic, and the one part of the swipe-direction setting that
# can be wrong without looking wrong on the board — every jump still lands on a real tile, just a mirrored
# one. Cheaper to prove here than to squint at a dial.
cc -std=c11 -Wall -Wextra -Werror -O1 \
   -o "$out/test_carousel_ring" "$here/test_carousel_ring.c" "$here/../main/ui/carousel_ring.c"
"$out/test_carousel_ring"

# Which dial this image is on, decided from who answered on the I2C bus. Two boards ship on one image;
# the table that tells them apart is arithmetic on a list of addresses, so it is proved here.
cc -std=c11 -Wall -Wextra -Werror -O1 \
   -o "$out/test_board" "$here/test_board.c" "$here/../main/board/board_table.c"
"$out/test_board"
