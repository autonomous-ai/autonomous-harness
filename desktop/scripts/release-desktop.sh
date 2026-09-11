#!/usr/bin/env bash
# Cut a desktop release: work out the next version, tag it, push the tag. CI does everything else —
# ../.github/workflows/release-desktop.yml builds macOS + Linux, publishes to GCS, and creates the
# GitHub Release. The tag IS the version; CI never bumps on its own. Tags are "vX.Y.Z_desktop" — the
# "_desktop" suffix is stripped by release-desktop.yml before anything treats it as a version; it
# exists only so this tag never also triggers the CLI's "vX.Y.Z_cli" or the backend's "vX.Y.Z_api"
# release, now that all three live in one repo.
#
# Usage (from the repo root, `make release-desktop ARGS=...` runs the same thing):
#   bash scripts/release-desktop.sh                    # bump the patch and release
#   bash scripts/release-desktop.sh --dry-run          # print everything, tag nothing, push nothing
#   bash scripts/release-desktop.sh --minor            # bump the MINOR version, per the usual semver
#                                                      # convention
#   bash scripts/release-desktop.sh 1.1.0              # release an explicit version
#   bash scripts/release-desktop.sh --notes-file f.md  # hand-written release notes instead of the
#                                                      # generated commit list
#
# THE NEXT VERSION COMES FROM TWO SOURCES, AND BOTH MATTER. Git tags alone are not enough: this repo
# had one tag (v1.0.52) while the live manifest was already serving 1.0.61, because
# scripts/upload-desktop.sh bumps from the manifest and tags nothing. Bumping from tags there would
# have produced 1.0.53 — a version LOWER than what users already run, which every app refuses to
# install (semverGt in lib/update/desktop_updater.dart) while the release still looks successful. So
# the current version is max(highest git tag, highest version in the manifest), across ALL of the
# manifest's desktop-* keys, not just the macOS one.
#
# Requires: git, curl, python3, and push access to origin. No GCS credentials — the manifest is read
# over public HTTPS, exactly as scripts/upload-desktop.sh reads it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- config (all overridable via env) ---
GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
GCS_PUBLIC_BASE_URL="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/desktop/metadata.json}"
META_URL="${META_URL:-${GCS_PUBLIC_BASE_URL%/}/${METADATA_PATH#/}}"
BRANCH="${BRANCH:-main}"

DRY_RUN=0
DO_MINOR=0
ALLOW_NO_MANIFEST=0
NEW_VER=""
NOTES_FILE=""

want_notes_file=0
for arg in "$@"; do
  if [ "$want_notes_file" -eq 1 ]; then NOTES_FILE="$arg"; want_notes_file=0; continue; fi
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --minor) DO_MINOR=1 ;;
    --allow-no-manifest) ALLOW_NO_MANIFEST=1 ;;
    --notes-file) want_notes_file=1 ;;
    --notes-file=*) NOTES_FILE="${arg#*=}" ;;
    -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "ERROR unknown flag: $arg" >&2; exit 1 ;;
    *) NEW_VER="$arg" ;;
  esac
done
[ "$want_notes_file" -eq 0 ] || { echo "ERROR --notes-file needs a path" >&2; exit 1; }

# Same rules as next_desktop_version()/bump_minor_version() in scripts/upload-desktop.sh:55-86, which
# is where this convention is defined. Note the rollover: .99 goes to the next MINOR at .1, not .0.
next_patch_version() {
  local current="$1" major minor patch
  if [[ ! "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "ERROR version '$current' must look like X.Y.Z" >&2
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

next_minor_version() {
  local current="$1" major minor
  if [[ ! "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    echo "ERROR version '$current' must look like X.Y.Z" >&2
    return 1
  fi
  major=$((10#${BASH_REMATCH[1]}))
  minor=$((10#${BASH_REMATCH[2]}))
  printf '%d.%d.1\n' "$major" "$((minor + 1))"
}

# Strictly greater, comparing X.Y.Z numerically — the same test the app applies before it will install
# anything (semverGt, lib/update/desktop_updater.dart:73).
version_gt() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}

# --- preflight: tooling ---
for tool in git curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR $tool not found — it is needed to cut a release" >&2; exit 1; }
done

# --- preflight: the tag must capture exactly what was tested, and CI must be able to fetch it ---
git rev-parse --git-dir >/dev/null 2>&1 || { echo "ERROR not a git repository: $ROOT" >&2; exit 1; }
git fetch --tags --quiet origin

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR working tree is dirty — a release tag must capture the tested source exactly:" >&2
  git status --short | sed 's/^/        /' >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$HEAD_SHA" "origin/$BRANCH" 2>/dev/null; then
  echo "ERROR HEAD is not on origin/$BRANCH — push the commit first, or CI will build a commit nobody else has." >&2
  exit 1
fi

# --- current version, source 1: the highest release tag in git ---
# The brace group keeps `set -e` from killing the script when grep legitimately matches nothing.
# Only "vX.Y.Z_desktop" tags count — the CLI's and backend's tags share this repo. Strip "v" and
# "_desktop" so TAG_VER is a bare X.Y.Z for the comparisons below.
TAG_VER="$(git tag -l 'v*_desktop' \
  | { grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)_desktop$' || true; } \
  | sed -E 's/^v//; s/_desktop$//' \
  | sort -V | tail -1)"
LAST_TAG=""
[ -z "$TAG_VER" ] || LAST_TAG="v${TAG_VER}_desktop"
TAG_VER="${TAG_VER:-0.0.0}"

# --- current version, source 2: the highest version actually being served ---
# Every desktop-* key, because each publisher only ever wrote its own: a linux-only publish would be
# invisible if we read desktop-macos alone, and stepping over it is how a downgrade gets released.
GCS_READ="$(curl -fsSL "$META_URL" 2>/dev/null | python3 -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
if not isinstance(data, dict):
    sys.exit(0)
best, holder = None, ""
for key, entry in data.items():
    if not key.startswith("desktop-") or not isinstance(entry, dict):
        continue
    version = entry.get("version")
    if not isinstance(version, str):
        continue
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)$", version.strip())
    if not m:
        continue
    parsed = tuple(int(g) for g in m.groups())
    if best is None or parsed > best:
        best, holder = parsed, key
if best is not None:
    print("%d.%d.%d %s" % (best + (holder,)))
' 2>/dev/null || true)"

GCS_VER="${GCS_READ%% *}"
GCS_KEY="${GCS_READ#* }"
if [ -z "$GCS_VER" ]; then
  if [ "$ALLOW_NO_MANIFEST" -eq 1 ]; then
    echo ">> WARNING could not read $META_URL — continuing on git tags alone (--allow-no-manifest)" >&2
    GCS_VER="0.0.0"
    GCS_KEY="(unavailable)"
  else
    echo "ERROR could not read the live manifest at $META_URL" >&2
    echo "      It is the only record of what users are actually running, and releasing without it" >&2
    echo "      risks publishing a version LOWER than the one already being served." >&2
    echo "      Re-run with --allow-no-manifest only if the bucket is genuinely down." >&2
    exit 1
  fi
fi

# --- the next version ---
CUR="$TAG_VER"
version_gt "$GCS_VER" "$CUR" && CUR="$GCS_VER"

if [ -n "$NEW_VER" ]; then
  VER="$NEW_VER"
elif [ "$DO_MINOR" -eq 1 ]; then
  VER="$(next_minor_version "$CUR")"
else
  VER="$(next_patch_version "$CUR")"
fi

if [[ ! "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR version '$VER' must look like X.Y.Z — release.yml rejects anything else" >&2
  exit 1
fi

TAG="v${VER}_desktop"

# The last gate against a release nobody can install.
if ! version_gt "$VER" "$GCS_VER"; then
  echo "ERROR $VER is not higher than $GCS_VER, which is already published ($GCS_KEY)." >&2
  echo "      Every running app would refuse it and the release would still look successful." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "ERROR tag $TAG already exists. Re-tagging a released version breaks the tag<->build mapping." >&2
  exit 1
fi

# --- release notes: the tag message IS the GitHub Release body ---
# release.yml's github-release job hard-fails on a lightweight tag or an empty message — and it runs
# AFTER the manifest is already live, so a missing message means a half-done release: users are
# downloading a build that has no Release page. Refuse to tag without notes rather than find out then.
NOTES="$(mktemp)"
trap 'rm -f "${NOTES:-}"' EXIT
if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || { echo "ERROR notes file not found: $NOTES_FILE" >&2; exit 1; }
  cat "$NOTES_FILE" > "$NOTES"
else
  {
    printf 'Harness Desktop %s\n\n' "$VER"
    if [ -n "$LAST_TAG" ]; then
      git log --no-merges --pretty='- %s' "${LAST_TAG}..HEAD"
    else
      git log --no-merges --pretty='- %s' -20
    fi
  } > "$NOTES"
fi
[ -s "$NOTES" ] || { echo "ERROR release notes are empty — CI would fail after publishing" >&2; exit 1; }

# --- summary (shared by dry runs and real ones) ---
echo ""
echo "  last git tag       ${LAST_TAG:-（none）} ($TAG_VER)"
echo "  live on GCS        $GCS_VER (highest of the desktop-* keys: $GCS_KEY)"
if version_gt "$GCS_VER" "$TAG_VER"; then
  echo "  NOTE               the manifest is ahead of git — versions were published without a tag."
  echo "                     Bumping from tags alone here would publish a downgrade."
fi
echo "  releasing          $VER   (tag $TAG on ${HEAD_SHA:0:12})"
if [ "$DO_MINOR" -eq 1 ] || [ "${VER%%.*}" != "${CUR%%.*}" ] || [ "$(echo "$VER" | cut -d. -f2)" != "$(echo "$CUR" | cut -d. -f2)" ]; then
  echo "  NOTE               this is a major/minor version bump."
fi
echo ""
echo "  release notes:"
sed 's/^/      /' "$NOTES"
echo ""

if [ "$DRY_RUN" -eq 1 ]; then
  echo "  dry run — nothing tagged, nothing pushed."
  exit 0
fi

# --- tag and push ---
git tag -a "$TAG" --cleanup=verbatim -F "$NOTES"
git push origin "$TAG"

echo ""
echo "  pushed $TAG → CI builds macOS + Linux, publishes to GCS, and cuts the GitHub Release."
echo "  watch : gh run watch \$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
echo ""
