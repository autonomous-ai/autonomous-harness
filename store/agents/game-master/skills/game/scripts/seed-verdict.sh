#!/bin/sh
# Presence is not evidence of correctness. Only the agent's actual checks may establish ready:true.
set -eu
ws="${1:?usage: seed-verdict.sh WORKSPACE}"
mkdir -p "$ws/.harness"
summary="No artifact yet"; phase=pending
if [ -s "$ws/game/index.html" ]; then summary="Artifact available — browser verification pending"; phase=active; fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"$summary","artifact":"game/index.html","findings":[{"severity":"info","kind":"verification_pending","message":"File presence checked; behavior, output quality and reproducibility have not been verified by this helper."}],"phases":[{"id":"build","name":"Build","state":"$phase"},{"id":"verify","name":"Verify","state":"pending"}],"updatedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
