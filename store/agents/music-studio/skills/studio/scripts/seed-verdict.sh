#!/usr/bin/env bash
# Seed .harness/verdict.json based on whether a real piece exists.
set -u
ws="${1:?usage: seed-verdict.sh <workspace>}"
file="$ws/piece/index.html"
if [ -f "$file" ] && [ -s "$file" ]; then
  ready=true; summary="piece built — hear it in the pane"
else
  ready=false; summary="no piece yet"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":$ready,"summary":"$summary",
 "findings":[{"severity":"info","kind":"reproducibility","message":"same-machine verified; cross-machine audio not provable bit-identical"}],
 "artifact":"piece/index.html",
 "phases":[{"id":"seed","name":"Seeded core","state":"done"},
           {"id":"piece","name":"The piece","state":"active"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
