#!/bin/bash
# Regenerate the device's Geist faces — one per (weight, size) the UI actually uses.
#
# The TTFs are VENDORED under fonts/ rather than read from the system. Geist is SIL OFL 1.1, which permits
# embedding and redistribution, so anyone who clones this repo can rebuild the fonts.
#
# RANGE is what Geist supplies. FB is filled from Arial Unicode and is computed as
#   (the ranges this firmware builds) MINUS (what Geist has), INTERSECTED with (what Arial has)
# so the two blocks are disjoint and font precedence never matters.
#
# 0x2713 (check) and 0x2717 (cross) sit in FB, NOT in RANGE: Geist has neither, and they belong to no
# contiguous block, so they are the easiest thing here to lose. Losing them once already turned the
# selected-machine tick into an empty box. If you touch the ranges, re-run the coverage check.
set -e
cd "$(cd "$(dirname "$0")/.." && pwd)"
FB=0x00AD,0x0114-0x0115,0x012C-0x012D,0x0138,0x013F-0x0140,0x0149,0x014E-0x014F,0x017F-0x018E,0x0190-0x0191,0x0193-0x019F,0x01A2-0x01AE,0x01B1-0x01CC,0x01CF-0x01E3,0x01EA-0x01F5,0x01FA-0x0217,0x1E00-0x1E1F,0x1E22-0x1E7F,0x1E86-0x1E9B,0x2015-0x2017,0x201B,0x201F,0x2023-0x2025,0x2713,0x2717
REG=fonts/Geist-Regular.ttf
MED=fonts/Geist-Medium.ttf
SEM=fonts/Geist-SemiBold.ttf
ARIAL="/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
RANGE=0x20-0x7F,0xA0-0x24F,0x1E00-0x1EFF,0x2013-0x2026,0x203A
gen() {  # gen <src> <tag> <size>
  local out="main/ui/geist_$2_$3.c"
  [ -s "$out" ] && { echo "  skip $out"; return; }
  npx --yes lv_font_conv@1.5.3 --bpp 4 --size "$3" --format lvgl --no-compress --no-prefilter \
    --font "$1" --range "$RANGE" --font "$ARIAL" --range "$FB" \
    -o "$out" --lv-include lvgl.h
  printf "  %-26s %6.0f KB\n" "$out" "$(($(stat -f%z "$out")/1024))"
}
# Exactly the five faces ui_screens.c references — same sizes as the Roboto Condensed set they replace.
# Body/labels. 16/24/32 arrived with the Settings screens, which the design sets at those sizes.
for s in 16 20 24 25 32 34 38; do gen "$REG" reg "$s"; done
for s in 28 32 38 48;       do gen "$MED" med "$s"; done
# One SemiBold: the reset confirm's primary, which the design sets a weight above its neighbours.
for s in 24;                do gen "$SEM" sem "$s"; done
# The Overview's agent count — DIGITS ONLY. A 64px face over the full range would be the largest file in
# the tree for one number; ten glyphs and a space are a few KB. Anything else set in it draws a box.
digits() {  # digits <src> <tag> <size>
  local out="main/ui/geist_$2_$3.c"
  [ -s "$out" ] && { echo "  skip $out"; return; }
  npx --yes lv_font_conv@1.5.3 --bpp 4 --size "$3" --format lvgl --no-compress --no-prefilter \
    --font "$1" --range 0x20,0x30-0x39 -o "$out" --lv-include lvgl.h
  printf "  %-26s %6.0f KB\n" "$out" "$(($(stat -f%z "$out")/1024))"
}
digits "$MED" med 64
echo "xong"
