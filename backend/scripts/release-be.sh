#!/usr/bin/env bash
# Cut a backend release: bump the version, tag HEAD `vX.Y.Z`, push the tag.
#
#   ./scripts/release-be.sh              # patch bump  (v1.1.2 -> v1.1.3)
#   ./scripts/release-be.sh minor        # v1.1.2 -> v1.2.0
#   ./scripts/release-be.sh major        # v1.1.2 -> v2.0.0
#   ./scripts/release-be.sh 1.4.1        # exact version -> v1.4.1
#   ./scripts/release-be.sh --dry-run    # print what it WOULD do, touch nothing
#
# Pushing the tag is the whole point: .github/workflows/production-be-build.yaml triggers on
# SemVer tags (`vX.Y.Z`) and builds
# Dockerfile.k8s -> autonomous-code-be.
# The image ArgoCD deploys is named after this tag, so the tag must point at the commit you want live.
# Bash 3.2-compatible (macOS default).
set -euo pipefail

SERVICE="backend (autonomous-code-be)"
WORKFLOW=".github/workflows/production-be-build.yaml"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
BUMP="patch"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    patch|minor|major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="exact"; EXACT="${arg#v}" ;;
    *) echo "usage: $0 [patch|minor|major|X.Y.Z] [--dry-run]" >&2; exit 1 ;;
  esac
done

if [[ "$BUMP" == "exact" ]] &&
  ! [[ "$EXACT" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "ERROR exact version '$EXACT' is invalid; use SemVer X.Y.Z (for example 1.4.1)." >&2
  exit 1
fi

# --- preflight: the tag names a commit, so that commit must be the right one and must be on origin.
git fetch --tags --quiet origin

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
HEAD_SHA="$(git rev-parse HEAD)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR working tree is dirty — release tags must capture the tested source exactly:" >&2
  git status --short | sed 's/^/        /' >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$HEAD_SHA" "origin/$BRANCH" 2>/dev/null; then
  echo "ERROR HEAD is not on origin/$BRANCH — push the commit first, or CI will build a commit nobody else has." >&2
  exit 1
fi

# --- next version: highest valid SemVer release tag, then bump.
# `sort -V` handles numeric ordering while grep drops malformed tags.
LATEST="$(git tag -l 'v*' \
  | { grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || true; } \
  | sed -E 's/^v//' \
  | sort -V | tail -1)"
LATEST="${LATEST:-0.0.0}"

MAJOR="${LATEST%%.*}"
REST="${LATEST#*.}"
MINOR="${REST%%.*}"
PATCH="${REST#*.}"

case "$BUMP" in
  patch) NEXT="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) NEXT="$MAJOR.$((MINOR + 1)).0" ;;
  major) NEXT="$((MAJOR + 1)).0.0" ;;
  exact) NEXT="$EXACT" ;;
esac

TAG="v${NEXT}"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "ERROR tag $TAG already exists. Re-tagging a released version breaks the image<->commit mapping." >&2
  exit 1
fi

echo "  service : $SERVICE"
echo "  branch  : $BRANCH @ $(git rev-parse --short HEAD)  $(git log -1 --format=%s | cut -c1-60)"
echo "  latest  : v$LATEST"
echo "  new tag : $TAG   [$BUMP]"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "  DRY RUN — nothing tagged or pushed."
  exit 0
fi

git tag -a "$TAG" -m "$SERVICE release $TAG"
git push origin "$TAG"

echo ""
echo "  pushed $TAG → CI builds autonomous-code-be and rolls it out. Nothing else to do."
echo "  watch : gh run list --workflow='Docker production backend build' --limit 3"
