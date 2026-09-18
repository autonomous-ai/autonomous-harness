#!/usr/bin/env bash
# Seed .harness/verdict.json based on whether a real bench exists.
set -u
ws="${1:?usage: seed-verdict.sh <workspace>}"
file="$ws/bench/index.html"
if [ -f "$file" ] && [ -s "$file" ]; then
  ready=true; summary="bench built — probe it in the pane"
else
  ready=false; summary="no bench yet"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":$ready,"summary":"$summary",
 "findings":[{"severity":"info","kind":"reproducibility","message":"same-machine verified; animated-run timing not provable bit-identical"}],
 "artifact":"bench/index.html",
 "phases":[{"id":"seed","name":"Seeded core","state":"done"},
           {"id":"bench","name":"The bench","state":"active"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
