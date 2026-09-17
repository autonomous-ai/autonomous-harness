#!/usr/bin/env bash
# Mirror the standalone esptool binaries into the PUBLIC GCS bucket, for the operations flasher.
#
#   bash scripts/upload-flasher.sh              # mirror + print the sha256 block
#   bash scripts/upload-flasher.sh --dry-run    # show what would be uploaded
#
# This is OPTIONAL. The flasher (apps/web/src/app/flash-circle.sh/flash-circle.sh) installs esptool by
# itself, from the vendor's release, verified against a sha256 it carries. The mirror exists for one
# case: an operations laptop on a network that blocks that download. It also pins the bytes, so the
# vendor cannot move them under us.
#
# The flasher SCRIPT is not published here — it is served by the web app at
# harness.autonomous.ai/flash-circle.sh and ships with a web deploy (same as /cli/install.sh). Nothing in
# this script touches metadata.json, so a mirror refresh can never disturb the fleet's OTA manifest.
#
# Prereqs: an authenticated `gsutil` with write access (objects must be public-read), plus curl.
# Published layout:  harness/flasher/esptool/<ver>/<asset>  (+ <asset>.sha256)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The flasher is the single source of truth for WHICH esptool is expected — read it from there rather
# than keeping a second copy of the version in this file, which would silently drift.
FLASHER="${FLASHER:-$HERE/../web/src/app/flash-circle.sh/flash-circle.sh}"

GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
FLASHER_PREFIX="${FLASHER_PREFIX:-harness/flasher}"
ESPTOOL_RELEASE_BASE="${ESPTOOL_RELEASE_BASE:-https://github.com/espressif/esptool/releases/download}"

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --mirror-esptool) ;;   # accepted for muscle memory; mirroring is all this script does now
    *) echo "error: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }
[ -f "$FLASHER" ] || { echo "error: flasher not found at $FLASHER" >&2; exit 1; }
[ "$DRY" -eq 1 ] || command -v gsutil >/dev/null 2>&1 || { echo "error: gsutil not found — install/authenticate the gcloud SDK" >&2; exit 1; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}
run() { if [ "$DRY" -eq 1 ]; then echo "   [dry-run] $*"; else "$@"; fi; }

ESPTOOL_VER="$(sed -n 's/^ESPTOOL_VERSION="${ESPTOOL_VERSION:-\([^}]*\)}".*/\1/p' "$FLASHER" | head -1)"
[ -n "$ESPTOOL_VER" ] || { echo "error: cannot read ESPTOOL_VERSION from $FLASHER" >&2; exit 1; }

echo ">> mirroring esptool $ESPTOOL_VER (as required by $(basename "$FLASHER"))"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PINS=""

# Every platform the flasher's esptool_asset() can ask for. Keep the two lists in step: a missing asset
# here becomes a silent fallback on exactly one kind of operator laptop — the sort of gap that only
# shows up in the field.
for asset in \
  "esptool-v${ESPTOOL_VER}-macos-arm64.tar.gz" \
  "esptool-v${ESPTOOL_VER}-macos-amd64.tar.gz" \
  "esptool-v${ESPTOOL_VER}-linux-amd64.tar.gz" \
  "esptool-v${ESPTOOL_VER}-linux-aarch64.tar.gz" \
  "esptool-v${ESPTOOL_VER}-linux-armv7.tar.gz" ; do
  echo "   ↓ $asset"
  curl -fsSL --retry 2 -o "$TMP/$asset" "${ESPTOOL_RELEASE_BASE}/v${ESPTOOL_VER}/${asset}" \
    || { echo "error: could not download $asset — is v$ESPTOOL_VER the right esptool tag?" >&2; exit 1; }
  sha="$(sha256_of "$TMP/$asset")"
  printf '%s  %s\n' "$sha" "$asset" > "$TMP/$asset.sha256"
  PINS="${PINS}    ${asset})$(printf '%*s' $(( 38 - ${#asset} )) '')echo ${sha} ;;
"
  dest="gs://${GCS_BUCKET}/${FLASHER_PREFIX}/esptool/${ESPTOOL_VER}/${asset}"
  echo "   ↑ $dest"
  run gsutil -q cp "$TMP/$asset" "$dest"
  run gsutil -q cp "$TMP/$asset.sha256" "${dest}.sha256"
done

echo ""
echo ">> paste into esptool_pinned_sha() in $(basename "$FLASHER"):"
printf '%s' "$PINS"
echo ""
echo ">> done. The flasher prefers this mirror and falls back to the vendor release."
exit 0
