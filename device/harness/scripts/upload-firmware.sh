#!/usr/bin/env bash
# Full device firmware release: bump version -> build -> upload to a PUBLIC GCS bucket.
# Devices fetch the manifest + binary straight from GCS (no backend involved — see main/ota.c /
# DEVICE_OTA_METADATA_URL) and self-update on their next boot / ~6h check. See RELEASE.md.
#
# Usage:
#   bash scripts/upload-firmware.sh              # auto-bump (0.1.2 -> 0.1.3; 0.1.99 -> 0.2.1)
#   bash scripts/upload-firmware.sh 0.2.0        # release an explicit version
#   bash scripts/upload-firmware.sh --no-bump    # keep version.txt as-is, build + upload
#   bash scripts/upload-firmware.sh --no-build   # skip the build, upload the existing build/ artifact
#   bash scripts/upload-firmware.sh --no-commit  # deprecated no-op (version is no longer git-tracked)
#   GCS_BUCKET=other-bucket bash scripts/upload-firmware.sh   # env overrides (see below)
#
# The CURRENT version is read from the remote metadata.json on GCS (single source of truth) and the
# patch is bumped from there — the local version.txt is NOT committed/pushed (only written so the
# build can stamp the firmware). Steps: (1) resolve+bump version, (2) idf.py build, (3) upload .bin +
# merge metadata.json to GCS.
# Prereqs: `gsutil` authenticated (gcloud auth) with WRITE access to the bucket; the bucket/objects
# must be public-read so devices can download without credentials. `idf.py` on PATH (or IDF_PATH set).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"    # device/harness
VER_FILE="$HERE/version.txt"
# A DEDICATED prod build dir + DEVICE_FORCE_PROD so a published binary is always production (ignores any
# local provisioned_config.h) WITHOUT moving the header, and without clobbering the interactive `build/`
# dir — both stay warm (with ccache, near-instant rebuilds). Override BUILD_DIR via env if needed.
BUILD_DIR="${BUILD_DIR:-$HERE/build-prod}"
BIN="$BUILD_DIR/interns_commander.bin"

# --- GCS config (all overridable via env) ---
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PUBLIC_BASE_URL="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/esp32/ota/metadata.json}"
OTA_KEY="${OTA_KEY:-commander}"   # must match DEVICE_OTA_KEY in main/config_store.h

next_firmware_version() {
  local current="$1" major minor patch
  if [[ ! "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "error: version '$current' must look like X.Y.Z" >&2
    return 1
  fi
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  patch=$((10#${BASH_REMATCH[3]}))
  if (( patch >= 99 )); then
    printf '%d.%d.1\n' "$major" "$((minor + 1))"
  else
    printf '%d.%d.%d\n' "$major" "$minor" "$((patch + 1))"
  fi
}

# --- Parse args (optional explicit version + flags) ---
NEW_VER=""
DO_BUMP=1
DO_BUILD=1
DO_COMMIT=1
for arg in "$@"; do
  case "$arg" in
    --no-bump)   DO_BUMP=0 ;;
    --no-build)  DO_BUILD=0 ;;
    --no-commit) DO_COMMIT=0 ;;   # deprecated no-op: version.txt is no longer committed
    -*)          echo "error: unknown flag '$arg'" >&2; exit 1 ;;
    *)           NEW_VER="$arg" ;;
  esac
done

command -v gsutil >/dev/null 2>&1 || { echo "error: gsutil not found — install/authenticate the gcloud SDK" >&2; exit 1; }

# Restore version.txt (if we bumped it) and clean temp files when the release doesn't finish — so a
# failed run (e.g. build error) doesn't leave version.txt advanced with nothing published.
cleanup() {
  local rc=$?
  if [ -n "${BUMPED_FROM:-}" ] && [ "${PUBLISHED:-0}" -ne 1 ]; then
    printf '%s\n' "$BUMPED_FROM" > "$VER_FILE"
    echo ">> restored version.txt to $BUMPED_FROM (release did not complete)" >&2
  fi
  rm -f "${SRC:-}" "${DST:-}" "${BUILD_LOG:-}"
  return $rc
}
trap cleanup EXIT

# --- Step 1: resolve + write the version ---
# Source of truth for the CURRENT version = the one already published in the remote metadata.json on
# GCS (public, no auth), NOT the local version.txt (which drifts / isn't committed). Falls back to
# version.txt then 0.0.0 if the fetch/parse fails.
META_URL="${GCS_PUBLIC_BASE_URL%/}/${METADATA_PATH#/}"
CUR="$(curl -fsSL "$META_URL" 2>/dev/null | python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get(sys.argv[1], {}).get("version", ""))
except Exception:
    print("")
' "$OTA_KEY" 2>/dev/null || true)"
if [ -n "$CUR" ]; then
  echo ">> current published version (from metadata.json): $CUR"
else
  CUR="$(tr -d ' \t\r\n' < "$VER_FILE" 2>/dev/null || echo '0.0.0')"
  echo ">> could not read remote metadata — falling back to local version.txt: $CUR" >&2
fi
if [ -n "$NEW_VER" ]; then
  VER="$NEW_VER"                                   # explicit version wins
elif [ "$DO_BUMP" -eq 1 ]; then
  VER="$(next_firmware_version "$CUR")"
else
  VER="$CUR"                                       # --no-bump: keep current
fi

[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version '$VER' must look like X.Y.Z" >&2; exit 1; }
if [ "$VER" != "$CUR" ]; then
  echo ">> version: $CUR -> $VER"
  BUMPED_FROM="$CUR"                 # cleanup() reverts to this if the release later fails
  printf '%s\n' "$VER" > "$VER_FILE"
  touch "$VER_FILE"   # force esp_app_desc to pick up the new version on the next build
else
  echo ">> version: $VER (unchanged)"
  [ "$DO_BUILD" -eq 1 ] && echo "   note: version unchanged — devices already on $VER will NOT update"
fi

# --- Step 2: build ---
if [ "$DO_BUILD" -eq 1 ]; then
  if ! command -v idf.py >/dev/null 2>&1; then
    # Auto-source the ESP-IDF env from IDF_PATH or common install locations.
    for cand in "${IDF_PATH:+$IDF_PATH/export.sh}" "$HOME/esp/esp-idf/export.sh" "$HOME/esp/v5.5/esp-idf/export.sh"; do
      if [ -n "$cand" ] && [ -f "$cand" ]; then
        export_log="$(mktemp)"
        # shellcheck disable=SC1091
        set +u
        if . "$cand" >"$export_log" 2>&1; then
          set -u
          rm -f "$export_log"
          break
        fi
        set -u
        echo ">> warning: failed to source ESP-IDF env from $cand" >&2
        sed 's/^/   /' "$export_log" >&2
        rm -f "$export_log"
      fi
    done
  fi
  command -v idf.py >/dev/null 2>&1 || {
    echo "error: idf.py not found. Source the ESP-IDF env first (. \$IDF_PATH/export.sh) or pass --no-build" >&2
    exit 1
  }
  # Build against a THROWAWAY sdkconfig, regenerated from sdkconfig.defaults on every release.
  #
  # A release must not inherit whatever config this machine happens to have. `sdkconfig` is gitignored and
  # generated, and ESP-IDF seeds it from sdkconfig.defaults ONLY when it does not exist — so a checkout that
  # has been building since before a defaults change keeps the old values indefinitely, with no warning.
  # That is how 0.0.1/0.0.2 shipped with an 8 KiB main task stack two weeks after the fix raising it to
  # 10 KiB landed, producing firmware that crashed mid-OTA and could not update itself.
  #
  # Deleting it costs a reconfigure (~10s) per release and makes the published binary a function of the
  # tracked defaults alone. The developer's interactive device/harness/sdkconfig is left untouched.
  RELEASE_SDKCONFIG="$BUILD_DIR/sdkconfig.release"
  rm -f "$RELEASE_SDKCONFIG"
  echo ">> building… (prod: -DDEVICE_FORCE_PROD=1, build dir $BUILD_DIR, fresh config from sdkconfig.defaults)"
  BUILD_LOG="$(mktemp)"
  if ! idf.py -C "$HERE" -B "$BUILD_DIR" -DSDKCONFIG="$RELEASE_SDKCONFIG" -DDEVICE_FORCE_PROD=1 build 2>&1 | tee "$BUILD_LOG"; then
    if grep -q "idf.py fullclean" "$BUILD_LOG"; then
      echo ">> build env changed; running idf.py fullclean and retrying once"
      idf.py -C "$HERE" -B "$BUILD_DIR" fullclean
      rm -f "$RELEASE_SDKCONFIG"
      idf.py -C "$HERE" -B "$BUILD_DIR" -DSDKCONFIG="$RELEASE_SDKCONFIG" -DDEVICE_FORCE_PROD=1 build
    else
      exit 1
    fi
  fi
  rm -f "$BUILD_LOG"
  BUILD_LOG=""
fi

[ -f "$BIN" ] || { echo "error: $BIN not found — build first (drop --no-build)" >&2; exit 1; }

# --- Step 3: upload the .bin + merge the manifest ---
GCS_PATH="${GCS_PATH:-harness/esp32/bin/${VER}.bin}"
SHA="$(shasum -a 256 "$BIN" | awk '{print $1}')"
SIZE="$(wc -c < "$BIN" | tr -d ' ')"
URL="${GCS_PUBLIC_BASE_URL%/}/${GCS_PATH#/}"

echo ">> uploading firmware $VER ($SIZE bytes, sha256=$SHA)"
echo "   dest: gs://${GCS_BUCKET}/${GCS_PATH}"
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" cp "$BIN" "gs://${GCS_BUCKET}/${GCS_PATH}"

echo ">> merging manifest: gs://${GCS_BUCKET}/${METADATA_PATH}  (${OTA_KEY} = {version,url,sha256,size})"
SRC="$(mktemp)"; DST="$(mktemp)"   # removed by cleanup() on EXIT
if ! gsutil cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$SRC" 2>/dev/null; then
  echo "   (no existing metadata.json — creating a new one)"
  printf '{}' > "$SRC"
fi
# NOTE: pass the in/out paths via argv; do NOT pipe the existing JSON through a `python3 - <<HEREDOC`
# invocation — the heredoc claims stdin so the pipe is dropped and the file would be overwritten empty.
python3 - "$SRC" "$DST" "$OTA_KEY" "$VER" "$URL" "$SHA" "$SIZE" <<'PY'
import json, sys
src, dst, key, version, url, sha, size = sys.argv[1:8]
try:
    with open(src) as f:
        raw = f.read()
    data = json.loads(raw) if raw.strip() else {}
except (OSError, json.JSONDecodeError):
    data = {}
if not isinstance(data, dict):
    data = {}
data[key] = {"version": version, "url": url, "sha256": sha, "size": int(size)}
with open(dst, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
gsutil -h "Content-Type:application/json" \
       -h "Cache-Control:no-cache, no-store, must-revalidate" \
       cp "$DST" "gs://${GCS_BUCKET}/${METADATA_PATH}"
PUBLISHED=1   # release completed — cleanup() must NOT revert version.txt

# The version is tracked by the remote metadata.json (single source of truth) — we do NOT git-commit
# or push version.txt. It stays modified locally (used only to stamp the firmware at build time).

echo ""
echo ">> published firmware $VER"
echo "   url:      $URL"
echo "   sha256:   $SHA"
echo "   manifest: ${GCS_PUBLIC_BASE_URL%/}/${METADATA_PATH#/}"
echo "   devices will update to $VER on their next boot or within ~6h."
