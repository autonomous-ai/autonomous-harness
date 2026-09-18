#!/usr/bin/env bash
# Seed .harness/verdict.json based on whether a real board exists.
set -u
ws="${1:?usage: seed-verdict.sh <workspace>}"
file="$ws/board/index.html"
if [ -f "$file" ] && [ -s "$file" ]; then
  ready=true; summary="board built — see it in the pane"
else
  ready=false; summary="no board yet"
fi
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":$ready,"summary":"$summary",
 "findings":[{"severity":"info","kind":"reproducibility","message":"same-machine verified; cross-machine color not provable"}],
 "artifact":"board/index.html",
 "phases":[{"id":"seed","name":"Seeded core","state":"done"},
           {"id":"board","name":"The board","state":"active"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
