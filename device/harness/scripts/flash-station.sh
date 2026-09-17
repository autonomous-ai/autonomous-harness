#!/usr/bin/env bash
# Flash station — one board at a time, no typing between boards.
#
#   plug in  →  it flashes  →  it beeps  →  unplug  →  plug the next
#
# Built for a batch: the image is prepared ONCE up front and every board gets the same bytes, so the
# per-board cost is the write itself and nothing else. Roughly 10-20s a board; the script prints the real
# number for each and a running average, because the estimate is worth checking against the bench.
#
# WHY IT IS SHAPED LIKE THIS — three things cost more than the write, and all three are removed here:
#
#   · `idf.py flash` re-runs a ninja build check before every flash. Ten boards, ten pointless waits.
#     This calls esptool directly on an already-built image.
#   · Probing the chip first (`esptool chip_id`) RESETS it, and on the S3's native USB-Serial-JTAG a reset
#     is a USB re-enumeration — the port disappears and does not always come back. Measured twice on the
#     bench. So nothing here touches the board before the write.
#   · Typing between boards. The loop waits for the port itself.
#
# Usage:
#   scripts/flash-station.sh                  # merge from build-prod, then run the station
#   scripts/flash-station.sh --image out.bin  # use a prepared image (no ESP-IDF needed for this path)
#   scripts/flash-station.sh --merge-only     # just produce the merged image and exit
#
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${BUILD_DIR:-$HERE/build-prod}"
MERGED="${MERGED:-$HERE/build-prod/circle-merged.bin}"

IMAGE=""
MERGE_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image)      IMAGE="${2:-}"; shift 2 ;;
    --merge-only) MERGE_ONLY=1; shift ;;
    -h|--help)    sed -n '2,26p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# ── ESP-IDF (only needed to MERGE; flashing a prepared image needs esptool alone) ──────────────────────
have_esptool() { command -v esptool.py >/dev/null 2>&1; }
if ! have_esptool; then
  for cand in "${IDF_PATH:+$IDF_PATH/export.sh}" "$HOME/esp/esp-idf/export.sh" "$HOME/esp/v5.5/esp-idf/export.sh"; do
    [ -n "$cand" ] && [ -f "$cand" ] && { . "$cand" >/dev/null 2>&1; break; }
  done
fi
have_esptool || { echo "error: esptool.py not found. Source the ESP-IDF env, or pip install esptool." >&2; exit 1; }

# ── A desktop app holding the port looks EXACTLY like dead hardware ────────────────────────────────────
# esptool opens the port fine and then reads nothing, and reports "device reports readiness to read but
# returned no data" or "No serial data received" — which reads as a bad cable, a brown-out or a board that
# will not enter download mode. It is none of those. On this bench the QuickDial companion app claims the
# ESP32's CDC port and never lets go; three flashing sessions were lost to it before `lsof` gave it up.
# Check once, up front, and name the culprit instead of letting the operator chase the hardware.
port_holders() { lsof /dev/cu.usbmodem* /dev/tty.usbmodem* 2>/dev/null | awk 'NR>1 {print $1" (pid "$2")"}' | sort -u; }
holders="$(port_holders)"
if [ -n "$holders" ]; then
  echo "⚠ something already has the serial port — esptool will fail in a way that looks like broken hardware:"
  echo "$holders" | sed 's/^/    /'
  echo "  Quit it, then run this again."
  exit 1
fi

# pyserial ships with the IDF python env and is how ports are matched to a USB VENDOR — the only way to
# tell an S3 from the square board's CH343 bridge WITHOUT touching either of them.
PY="$(command -v python3 || command -v python)"
$PY -c "import serial.tools.list_ports" 2>/dev/null || {
  echo "error: pyserial missing. Source the ESP-IDF env (its python env has it)." >&2; exit 1; }

# ── Prepare the image ─────────────────────────────────────────────────────────────────────────────────
# One file written at 0x0 instead of four separate erase+write cycles, and a machine that only has
# esptool can flash it — no toolchain, no build tree.
if [ -z "$IMAGE" ]; then
  [ -f "$BUILD_DIR/flash_args" ] || { echo "error: no build at $BUILD_DIR (run the prod build first)" >&2; exit 1; }
  echo ">> merging $BUILD_DIR → $MERGED"
  ( cd "$BUILD_DIR" && esptool.py --chip esp32s3 merge_bin -o "$MERGED" @flash_args ) || exit 1
  IMAGE="$MERGED"
fi
[ -f "$IMAGE" ] || { echo "error: image not found: $IMAGE" >&2; exit 1; }
SZ=$($PY -c "import os,sys; print(f'{os.path.getsize(sys.argv[1])/1048576:.2f}')" "$IMAGE")
echo ">> image: $IMAGE  (${SZ} MB)"
[ "$MERGE_ONLY" = "1" ] && exit 0

# ── Port discovery, by USB VENDOR ─────────────────────────────────────────────────────────────────────
#   0x303a = Espressif native USB-Serial-JTAG → the round board (ESP32-S3)
#   0x1a86 = WCH CH343 bridge                 → the SQUARE board (ESP32-P4). Refused on purpose: the two
#            images are for different SoCs and a board that takes the wrong one boot-loops until someone
#            reaches it with a cable.
s3_ports()  { $PY -c "
from serial.tools import list_ports
print('\n'.join(p.device for p in list_ports.comports() if p.vid == 0x303a))"; }
foreign_ports() { $PY -c "
from serial.tools import list_ports
print('\n'.join(p.device for p in list_ports.comports() if p.vid == 0x1a86))"; }

beep() { afplay /System/Library/Sounds/Glass.aiff >/dev/null 2>&1 || printf '\a'; }
fail_beep() { afplay /System/Library/Sounds/Basso.aiff >/dev/null 2>&1 || printf '\a\a'; }

flash_one() {   # $1 = port ; echoes nothing, returns 0 on success
  esptool.py --chip esp32s3 --port "$1" --before default_reset --after hard_reset \
             write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB 0x0 "$IMAGE" \
             >/tmp/flash-station.log 2>&1
}

# ── The loop ──────────────────────────────────────────────────────────────────────────────────────────
n=0; total=0
echo
echo "── flash station ready ── plug a board in. Ctrl-C to stop."
echo

while true; do
  # 1. wait for a board
  port=""
  while [ -z "$port" ]; do
    port="$(s3_ports | head -1)"
    if [ -z "$port" ]; then
      fp="$(foreign_ports | head -1)"
      [ -n "$fp" ] && { echo "   ⚠ that is the SQUARE (P4) board on $fp — refusing. Unplug it."; sleep 3; }
      sleep 1
    fi
  done

  n=$((n+1))
  printf "▸ board #%d on %s … " "$n" "$port"
  t0=$SECONDS

  # 2. flash, retrying — the port name CHANGES across a re-enumeration, so it is re-resolved each attempt
  ok=0
  for attempt in 1 2 3; do
    flash_one "$port" && { ok=1; break; }
    sleep 2
    port="$(s3_ports | head -1)"
    [ -z "$port" ] && break          # unplugged mid-way: abandon this one
    [ "$attempt" = "1" ] && printf "retry… "
  done

  # 3. still stuck → almost always the board not entering download mode on its own
  if [ "$ok" != "1" ]; then
    fail_beep
    echo
    echo "   ✗ could not talk to it. Hold BOOT, tap RESET, release BOOT — then leave it plugged in."
    # esptool's LAST line is a link to its troubleshooting page, not the failure — pull the real one.
    echo "     ($(grep -m1 'A fatal error occurred' /tmp/flash-station.log || tail -1 /tmp/flash-station.log))"
    while [ "$ok" != "1" ]; do
      port="$(s3_ports | head -1)"
      [ -z "$port" ] && { echo "   … unplugged, skipping."; break; }
      flash_one "$port" && ok=1 || sleep 2
    done
    [ "$ok" = "1" ] && echo "   ✓ recovered."
  fi

  if [ "$ok" = "1" ]; then
    dt=$((SECONDS - t0)); total=$((total + dt))
    beep
    printf "✓ %ds  (done %d, avg %ds)\n" "$dt" "$n" "$((total / n))"
  else
    n=$((n-1))
  fi

  # 4. wait for the unplug. The board REBOOTS after flashing and comes back under a NEW port name, so
  #    "has the port changed" is not a usable signal — waiting for the port to be GONE is.
  echo "   unplug it, then plug the next one."
  while [ -n "$(s3_ports | head -1)" ]; do sleep 1; done
  echo
done
