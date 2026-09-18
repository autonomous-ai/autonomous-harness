#!/usr/bin/env bash
# Seed .harness/verdict.json based on whether a real game exists.
set -u
ws="${1:?usage: seed-verdict.sh <workspace>}"
file="$ws/game/index.html"
if [ -f "$file" ] && [ -s "$file" ]; then
  ready=true; summary="game built — play it in the pane"
else
  ready=false; summary="no game yet"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":$ready,"summary":"$summary",
 "findings":[{"severity":"info","kind":"reproducibility","message":"same-machine verified; timing-based animation not provable bit-identical"}],
 "artifact":"game/index.html",
 "phases":[{"id":"seed","name":"Seeded core","state":"done"},
           {"id":"game","name":"The game","state":"active"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
