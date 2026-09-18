#!/bin/sh
# Seed or refresh the verdict feed for a Generative Art workspace.
# Usage: seed-verdict.sh <workspace>
ws="${1:?workspace}"; ws="$(cd "$ws" && pwd)"
mkdir -p "$ws/.harness"
if [ -s "$ws/sketch/index.html" ]; then ready=true; summary="piece rendering — re-seed it in the pane"; else ready=false; summary="no piece yet"; fi
cat > "$ws/.harness/verdict.json" <<JSON
{ "spec": 1, "ready": $ready, "summary": "$summary",
  "artifact": "sketch/index.html",
  "phases": [ { "id": "seed", "name": "Seeded core", "state": "done" },
              { "id": "piece", "name": "The piece", "state": "active" },
              { "id": "edition", "name": "Edition", "state": "pending" } ],
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
echo "verdict: $summary"
