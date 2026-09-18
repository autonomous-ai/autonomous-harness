#!/usr/bin/env bash
# Seed .harness/verdict.json based on whether a real flight exists.
set -u
ws="${1:?usage: seed-verdict.sh <workspace>}"
file="$ws/flight/index.html"
if [ -f "$file" ] && [ -s "$file" ]; then
  ready=true; summary="flight built — fly it in the pane"
else
  ready=false; summary="no flight yet"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":$ready,"summary":"$summary",
 "findings":[{"severity":"info","kind":"reproducibility","message":"same-machine verified; frame-timing physics not provable bit-identical"}],
 "artifact":"flight/index.html",
 "phases":[{"id":"seed","name":"Seeded core","state":"done"},
           {"id":"flight","name":"The flight","state":"active"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
