#!/usr/bin/env bash
# Publish the macOS and Linux Node archives consumed by Harness Desktop's
# first-run provisioner. The desktop app trusts the sha256 in this manifest,
# never a downloaded checksum file at install time.
#
# Usage: bash scripts/publish-managed-node-runtime.sh 22.16.0
set -euo pipefail
set +x

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <Node version, e.g. 22.16.0>" >&2
  exit 2
fi

for command in curl gsutil shasum python3; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "error: $command is required" >&2
    exit 1
  }
done

GCS_BUCKET="${GCS_BUCKET:-s3-autonomous-upgrade-3}"
PUBLIC_BASE="${GCS_PUBLIC_BASE_URL:-https://storage.googleapis.com/${GCS_BUCKET}}"
METADATA_PATH="${METADATA_PATH:-harness/runtime/metadata.json}"
NODE_BASE="https://nodejs.org/dist/v${VERSION}"
WORK_DIR="$(mktemp -d)"
SRC="$WORK_DIR/metadata.json"
DST="$WORK_DIR/metadata.next.json"
trap 'rm -rf "$WORK_DIR"' EXIT

curl -fsSL "$NODE_BASE/SHASUMS256.txt" -o "$WORK_DIR/SHASUMS256.txt"

declare -a ENTRIES=()
for pair in \
  "darwin:arm64:darwin-arm64" \
  "darwin:x64:darwin-x64" \
  "linux:arm64:linux-arm64" \
  "linux:x64:linux-x64"; do
  IFS=: read -r platform upstream_arch manifest_arch <<< "$pair"
  archive="node-v${VERSION}-${platform}-${upstream_arch}.tar.gz"
  archive_path="$WORK_DIR/$archive"
  curl -fsSL "$NODE_BASE/$archive" -o "$archive_path"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$WORK_DIR/SHASUMS256.txt")"
  actual="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || {
    echo "error: official SHASUMS256.txt has no checksum for $archive" >&2
    exit 1
  }
  [[ "$actual" == "$expected" ]] || {
    echo "error: checksum mismatch for $archive" >&2
    exit 1
  }

  object_path="harness/runtime/node/v${VERSION}/$archive"
  url="${PUBLIC_BASE%/}/${object_path}"
  size="$(wc -c < "$archive_path" | tr -d ' ')"
  echo ">> uploading $archive ($size bytes)"
  gsutil -h 'Cache-Control:public, max-age=31536000, immutable' cp \
    "$archive_path" "gs://${GCS_BUCKET}/${object_path}"
  ENTRIES+=("$manifest_arch|v$VERSION|$url|$actual|$size|node-v${VERSION}-${platform}-${upstream_arch}")
done

if ! gsutil cp "gs://${GCS_BUCKET}/${METADATA_PATH}" "$SRC" 2>/dev/null; then
  printf '{}' > "$SRC"
fi

python3 - "$SRC" "$DST" "${ENTRIES[@]}" <<'PY'
import json, sys
src, dst, *entries = sys.argv[1:]
try:
    with open(src) as f:
        document = json.load(f)
except (OSError, json.JSONDecodeError):
    document = {}
if not isinstance(document, dict):
    document = {}
node = document.get("node")
if not isinstance(node, dict):
    node = {}
document["node"] = node
for entry in entries:
    key, version, url, sha256, size, archive_root = entry.split("|", 5)
    node[key] = {
        "version": version,
        "url": url,
        "sha256": sha256,
        "size": int(size),
        "archiveRoot": archive_root,
    }
with open(dst, "w") as f:
    json.dump(document, f, indent=2)
    f.write("\n")
PY

gsutil -h 'Content-Type:application/json' \
       -h 'Cache-Control:no-cache, no-store, must-revalidate' \
       cp "$DST" "gs://${GCS_BUCKET}/${METADATA_PATH}"

echo ">> published managed Node v${VERSION}"
echo ">> manifest: ${PUBLIC_BASE%/}/${METADATA_PATH}"
