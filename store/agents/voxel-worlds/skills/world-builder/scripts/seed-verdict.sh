#!/bin/sh
# Seed or refresh the verdict feed for a Voxel Worlds workspace. Written at every check so the
# pane header moves as the agent works, without the agent running anything.
# Usage: seed-verdict.sh <workspace>
ws="${1:?workspace}"; ws="$(cd "$ws" && pwd)"
mkdir -p "$ws/.harness"
if [ -f "$ws/world/index.html" ]; then
  ready=false; summary="no world yet"
  [ -s "$ws/world/index.html" ] && { ready=true; summary="world built — walk it in the pane"; }
else
  ready=false; summary="no world yet"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{ "spec": 1, "ready": $ready, "summary": "$summary",
  "artifact": "world/index.html",
  "phases": [ { "id": "world", "name": "World", "state": "done" },
              { "id": "interaction", "name": "Interaction", "state": "active" },
              { "id": "polish", "name": "Polish", "state": "pending" } ],
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
echo "verdict: $summary"
