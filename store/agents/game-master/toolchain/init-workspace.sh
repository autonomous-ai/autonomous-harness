#!/bin/sh
# Harness copies the template before this runs. Preserve the user's design log on repeat calls.
set -eu
ws="${1:-$PWD}"
mkdir -p "$ws/game" "$ws/.harness"
if [ ! -f "$ws/game/DESIGN.md" ]; then
  printf '# Design log — Game Master\n\nRecord date, USER or AI, decision, rationale, and whether it remains in the build.\n' > "$ws/game/DESIGN.md"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"Relay starter available — describe what you want to create","artifact":"game/index.html","findings":[{"severity":"info","kind":"review_pending","message":"Starter provided; personalized changes need browser verification."}],"phases":[{"id":"build","name":"Build","state":"active"},{"id":"verify","name":"Verify","state":"pending"}],"updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
printf 'initialized by %s\n' "${HARNESS_DSH:-autonomous/game-master}" > "$ws/.harness-initialized"
