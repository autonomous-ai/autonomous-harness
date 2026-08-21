#!/usr/bin/env bash
# Release the `harness` adapter CLI: bump version -> bundle -> upload to a PUBLIC GCS bucket.
# Running daemons poll the manifest (ADAPTER_UPDATE_URL) and self-update within ~1 min. See RELEASE.md.
#
# Usage:
#   bash scripts/upload-cli.sh              # auto-bump (0.0.1 -> 0.0.2; 0.0.99 -> 0.1.1)
#   bash scripts/upload-cli.sh 0.1.0        # release an explicit version
#   bash scripts/upload-cli.sh --no-bump    # keep the current version, bundle + upload
#   bash scripts/upload-cli.sh --no-build   # upload the existing dist/ artifact as-is
#   GCS_BUCKET=other bash scripts/upload-cli.sh   # env overrides (see below)
#
# The CURRENT version is read from the remote metadata.json on GCS (single source of truth) and the
# patch is bumped from there — nothing is git-committed (the version is injected into the bundle via
# ADAPTER_VERSION, so the running binary's version equals the published manifest version).
# Prereqs: `gsutil` authenticated with WRITE access; the bucket/objects must be public-read; `node`+`npm`.
set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # this package
CLI="$ADAPTER_DIR/dist/cli.js"
NOTIFY="$ADAPTER_DIR/dist/notify.mjs"

# --- GCS config (all overridable via env) ---
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PUBLIC_BASE_URL="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/cli/metadata.json}"
OTA_KEY="${OTA_KEY:-cli}"   # must match ADAPTER_UPDATE_KEY in src/config/env.ts

next_adapter_version() {
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
for arg in "$@"; do
  case "$arg" in
    --no-bump)  DO_BUMP=0 ;;
    --no-build) DO_BUILD=0 ;;
    -*)         echo "error: unknown flag '$arg'" >&2; exit 1 ;;
    *)          NEW_VER="$arg" ;;
  esac
done

command -v gsutil >/dev/null 2>&1 || { echo "error: gsutil not found — install/authenticate the gcloud SDK" >&2; exit 1; }
command -v node   >/dev/null 2>&1 || { echo "error: node not found" >&2; exit 1; }

cleanup() { rm -f "${SRC:-}" "${DST:-}"; }
trap cleanup EXIT

# --- Step 1: resolve the version (source of truth = remote metadata.json; fallback = package.json) ---
META_URL="${GCS_PUBLIC_BASE_URL%/}/${METADATA_PATH#/}"
CUR="$(curl -fsSL "$META_URL" 2>/dev/null | node -e '
let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
  try { process.stdout.write(String((JSON.parse(s)[process.argv[1]]||{}).version||"")) } catch { process.stdout.write("") }
})' "$OTA_KEY" 2>/dev/null || true)"
if [ -n "$CUR" ]; then
  echo ">> current published version (from metadata.json): $CUR"
else
  CUR="$(node -p "require('$ADAPTER_DIR/package.json').version" 2>/dev/null || echo '0.0.0')"
  echo ">> could not read remote metadata — falling back to package.json: $CUR" >&2
fi
if [ -n "$NEW_VER" ]; then
  VER="$NEW_VER"                                   # explicit version wins
elif [ "$DO_BUMP" -eq 1 ]; then
  VER="$(next_adapter_version "$CUR")"
else
  VER="$CUR"                                       # --no-bump: keep current
fi
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: version '$VER' must look like X.Y.Z" >&2; exit 1; }
echo ">> releasing adapter version: $VER"

# --- Step 2: bundle (version baked into the artifact) ---
if [ "$DO_BUILD" -eq 1 ]; then
  echo ">> bundling…"
  ( cd "$ADAPTER_DIR" && ADAPTER_VERSION="$VER" npm run bundle )
fi
[ -f "$CLI" ] && [ -f "$NOTIFY" ] || { echo "error: dist/cli.js or dist/notify.mjs missing — bundle first (drop --no-build)" >&2; exit 1; }
head -1 "$CLI" | grep -q '^#!' || { echo "error: dist/cli.js lost its shebang on line 1 (esbuild change?)" >&2; exit 1; }
[ "$(node "$CLI" version)" = "$VER" ] || { echo "error: bundled version != $VER (ADAPTER_VERSION not injected)" >&2; exit 1; }

# --- Step 3: upload both artifacts + merge the manifest ---
CLI_GCS="harness/cli/${VER}/cli.js"
NOTIFY_GCS="harness/cli/${VER}/notify.mjs"
CLI_URL="${GCS_PUBLIC_BASE_URL%/}/${CLI_GCS}"
NOTIFY_URL="${GCS_PUBLIC_BASE_URL%/}/${NOTIFY_GCS}"
# `shasum` is a Perl script and is absent from minimal Linux images (only perl-base is installed);
# `sha256sum` is coreutils and is always there. Prefer it so a release can also be cut from Ubuntu.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}
CLI_SHA="$(sha256_of "$CLI")";     CLI_SIZE="$(wc -c < "$CLI" | tr -d ' ')"
NOTIFY_SHA="$(sha256_of "$NOTIFY")"; NOTIFY_SIZE="$(wc -c < "$NOTIFY" | tr -d ' ')"

echo ">> uploading cli.js ($CLI_SIZE bytes) + notify.mjs ($NOTIFY_SIZE bytes)"
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" cp "$CLI"    "gs://${GCS_BUCKET}/${CLI_GCS}"
gsutil -h "Cache-Control:no-cache, no-store, must-revalidate" cp "$NOTIFY" "gs://${GCS_BUCKET}/${NOTIFY_GCS}"

echo ">> merging manifest: gs://${GCS_BUCKET}/${METADATA_PATH}  (${OTA_KEY})"
SRC="$(mktemp)"; DST="$(mktemp)"   # removed by cleanup() on EXIT
if ! gsutil cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$SRC" 2>/dev/null; then
  echo "   (no existing metadata.json — creating a new one)"
  printf '{}' > "$SRC"
fi
# Pass paths/values via argv (NOT a heredoc through stdin — that would claim the pipe and blank the file).
node "$ADAPTER_DIR/scripts/merge-manifest.mjs" \
  "$SRC" "$DST" "$OTA_KEY" "$VER" \
  "$CLI_URL" "$CLI_SHA" "$CLI_SIZE" \
  "$NOTIFY_URL" "$NOTIFY_SHA" "$NOTIFY_SIZE"
gsutil -h "Content-Type:application/json" \
       -h "Cache-Control:no-cache, no-store, must-revalidate" \
       cp "$DST" "gs://${GCS_BUCKET}/${METADATA_PATH}"

echo ""
echo ">> published adapter $VER"
echo "   cli:      $CLI_URL  (sha256 $CLI_SHA)"
echo "   notify:   $NOTIFY_URL"
echo "   manifest: $META_URL"
echo "   running daemons self-update to $VER within ~1 min."
