#!/usr/bin/env bash
# Publish ONE of the two macOS builds: build -> pin its renderer -> hand the bundle to
# scripts/upload-desktop.sh --no-build, which packages, notarizes, uploads and merges the manifest
# exactly as it always has. upload-desktop.sh is not modified — everything reaches it through the
# flags and env overrides it already takes. See RELEASE.md, "Two macOS builds".
#
# Usage:
#   bash scripts/publish-macos-variant.sh intel 1.2.4                # desktop-macos       — Skia
#   bash scripts/publish-macos-variant.sh apple-silicon 1.2.4        # desktop-macos-arm64 — Impeller
#   bash scripts/publish-macos-variant.sh intel 1.2.4 --build-only   # build + pin, publish nothing
#   bash scripts/publish-macos-variant.sh intel 1.2.4 --no-notarize  # forwarded to upload-desktop.sh
#   bash scripts/publish-macos-variant.sh intel 1.2.4 --build-only --dart-define=HARNESS_GRID_SURFACE=true
#                                                                    # forwarded to flutter build only
#   (x64 / x86_64 are accepted for intel, arm64 / aarch64 for apple-silicon.)
#
# ONE universal app, two bundles. Flutter renders macOS with Impeller by default, and Intel users
# report the app stuttering while Apple Silicon renders it fine — the one thing that differs between
# them running the same universal build is the GPU Impeller drives. A release build can only opt out
# through Info.plist (`FLTEnableImpeller`; the engine compiles its switches out of release), and an
# Info.plist belongs to a bundle, so choosing by CPU means shipping two. Both stay universal
# (arm64 + x86_64): either one still launches on any Mac, which the Intel one has to (below).
#
# The Intel build keeps the OLD key and file name on purpose. `desktop-macos` is what every install
# from before this split polls, on either CPU, and `desktop-macos-dmg` is what the website download
# serves. Putting the Skia build there fixes every Intel Mac on its next update, with no new updater
# needed first, and hands a new visitor a build that works on whatever Mac they have. Apple Silicon
# moves onto its Impeller build one update later, once it runs an updater that asks for
# desktop-macos-arm64 (lib/update/desktop_updater.dart — the keys below must match it).
#
# The version is REQUIRED: two runs have to publish one version, and upload-desktop.sh's auto-bump
# reads the manifest, so the second run would see the first one's upload and bump again.
#
# OTA_KEY, DMG_KEY, GCS_PATH and DMG_GCS_PATH are set here per build and override the caller's, so the
# two runs can never write each other's keys or paths. Everything else upload-desktop.sh reads
# (GCS_BUCKET, METADATA_PATH, SIGN_IDENTITY, NOTARY_PROFILE, ...) passes straight through.
set -euo pipefail
set +x

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repository root
# Where upload-desktop.sh --no-build picks the bundle up (its APP_BUNDLE, which takes no override).
APP_BUNDLE="$APP_DIR/build/macos/Build/Products/Release/Harness.app"
PLIST="$APP_BUNDLE/Contents/Info.plist"
SIGN_IDENTITY="${SIGN_IDENTITY:-Developer ID Application}"   # same default as upload-desktop.sh

die() { echo "error: $*" >&2; exit 1; }

usage() {
  echo "usage: bash scripts/publish-macos-variant.sh <intel|apple-silicon> <X.Y.Z> [--build-only] [--no-notarize] [--dart-define=KEY=VALUE ...]" >&2
  exit 1
}

# --- args ---
[ $# -ge 2 ] || usage
VARIANT="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"   # macOS bash 3.2 has no ${1,,}
VER="$2"
shift 2
BUILD_ONLY=0
DO_NOTARIZE=1
# Handed to `flutter build` and nowhere else — upload-desktop.sh --no-build never builds. A release
# passes none; .github/workflows/internal-build.yml passes the flags a tester's build carries.
DART_DEFINES=()
for arg in "$@"; do
  case "$arg" in
    --build-only)    BUILD_ONLY=1 ;;
    --no-notarize)   DO_NOTARIZE=0 ;;
    --dart-define=*) DART_DEFINES+=("$arg") ;;
    *) die "unknown argument '$arg' — only --build-only, --no-notarize and --dart-define=KEY=VALUE; the version is explicit, so there is nothing to bump" ;;
  esac
done

# --- the two builds. Keys MUST match _otaKeyMacOS / _otaKeyMacOSArm64 in lib/update/desktop_updater.dart ---
case "$VARIANT" in
  intel|x64|x86_64)
    VARIANT=intel;         RENDERER=skia;     OTA_KEY=desktop-macos;       ARTIFACT=Harness-macos ;;
  apple-silicon|arm64|aarch64)
    VARIANT=apple-silicon; RENDERER=impeller; OTA_KEY=desktop-macos-arm64; ARTIFACT=Harness-macos-arm64 ;;
  *) usage ;;
esac

[[ "$VER" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "version '$VER' must look like X.Y.Z"
# Same formula as build_number_for() in upload-desktop.sh — keep the two in step, so a bundle built
# here carries the CFBundleVersion that script would have stamped.
BUILD_NUM=$(( 10#${BASH_REMATCH[1]} * 10000 + 10#${BASH_REMATCH[2]} * 100 + 10#${BASH_REMATCH[3]} ))

[ "$(uname -s)" = Darwin ] || die "a macOS build needs a macOS host"
command -v flutter >/dev/null 2>&1 || die "flutter not found"

# --- build ---
echo ">> building the $VARIANT build $VER (build $BUILD_NUM), rendering on $RENDERER"
# Names only: a define's value can be a credential (GRID_API_TOKEN is one).
for define in ${DART_DEFINES[@]+"${DART_DEFINES[@]}"}; do
  define="${define#--dart-define=}"
  echo "   dart-define ${define%%=*}"
done
# Removed first for the reason upload-desktop.sh removes it: an incremental Xcode build can skip
# re-stamping Info.plist and leave a previous version inside.
rm -rf "$APP_BUNDLE"
# `${a[@]+"${a[@]}"}`: an empty array under `set -u` is an error on the bash 3.2 macOS ships.
( cd "$APP_DIR" && flutter build macos --release --build-name="$VER" --build-number="$BUILD_NUM" \
    ${DART_DEFINES[@]+"${DART_DEFINES[@]}"} )
[ -d "$APP_BUNDLE" ] || die "app bundle missing after the build: $APP_BUNDLE"

# --- pin the renderer ---
renderer_key() { /usr/libexec/PlistBuddy -c "Print :FLTEnableImpeller" "$PLIST" 2>/dev/null || true; }

case "$RENDERER" in
  impeller)
    # Nothing to write — Impeller is the engine's default. Only something to rule out: an opt-out
    # committed to macos/Runner/Info.plist would quietly put Apple Silicon on Skia as well.
    got="$(renderer_key)"
    [ -z "$got" ] || [ "$got" = true ] \
      || die "Info.plist carries FLTEnableImpeller=$got — the Apple Silicon build must render on Impeller"
    ;;
  skia)
    ENTITLEMENTS_BEFORE="$(codesign -d --entitlements - --xml "$APP_BUNDLE" 2>/dev/null)"
    # Delete-then-Add: `Set` fails on a key the source Info.plist does not have.
    /usr/libexec/PlistBuddy -c "Delete :FLTEnableImpeller" "$PLIST" 2>/dev/null || true
    /usr/libexec/PlistBuddy -c "Add :FLTEnableImpeller bool false" "$PLIST"
    # Read back: a build that quietly kept Impeller looks exactly like a fix that did not work, and
    # finding that out costs a release cycle and a user.
    [ "$(renderer_key)" = false ] || die "FLTEnableImpeller did not stick in $PLIST"
    # The edit broke the seal Xcode put on the bundle, and macOS will not launch a bundle whose
    # Info.plist no longer matches its signature. Re-sign the OUTER bundle only — the frameworks inside
    # are untouched and keep their own signatures — carrying over what Xcode signed it with: the
    # hardened runtime notarization requires, and the entitlements (get-task-allow=false above all).
    echo ">> re-signing $APP_BUNDLE ($SIGN_IDENTITY)"
    codesign --force --sign "$SIGN_IDENTITY" --timestamp --options runtime \
      --preserve-metadata=identifier,entitlements,requirements,flags,runtime "$APP_BUNDLE"
    [ "$(codesign -d --entitlements - --xml "$APP_BUNDLE" 2>/dev/null)" = "$ENTITLEMENTS_BEFORE" ] \
      || die "re-signing changed the bundle's entitlements"
    ;;
esac

# Both builds, whatever happened above: fail here rather than at Apple's notary ten minutes later.
codesign --verify --deep --strict "$APP_BUNDLE" || die "the signature does not verify: $APP_BUNDLE"
# Captured, not piped into `grep -q`: grep exiting early SIGPIPEs codesign, which pipefail reports.
SIGNATURE="$(codesign -dv "$APP_BUNDLE" 2>&1)"
[[ "$SIGNATURE" == *"flags="*"runtime"* ]] || die "hardened runtime missing — notarization would reject it"
KEY="$(renderer_key)"
echo ">> $VARIANT build $VER ready: $RENDERER (FLTEnableImpeller=${KEY:-unset, the engine default})"

if [ "$BUILD_ONLY" -eq 1 ]; then
  echo ">> --build-only: nothing published. The bundle is at $APP_BUNDLE"
  exit 0
fi

# --- publish, through the unmodified script ---
export OTA_KEY
export DMG_KEY="$OTA_KEY-dmg"
export GCS_PATH="harness/desktop/$VER/$ARTIFACT.zip"
export DMG_GCS_PATH="harness/desktop/$VER/$ARTIFACT.dmg"
set -- --no-build "$VER"
[ "$DO_NOTARIZE" -eq 1 ] || set -- "$@" --no-notarize
exec bash "$APP_DIR/scripts/upload-desktop.sh" "$@"
