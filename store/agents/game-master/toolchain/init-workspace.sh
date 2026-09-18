#!/usr/bin/env bash
# Lay out a Game Master workspace and seed a not-ready verdict. The framework
# copies the template (whose marker placeholder is replaced by the real game).
set -euo pipefail
dsh="${HARNESS_DSH:-autonomous/game-master}"
ws="${1:-$PWD}"
mkdir -p "$ws/game"
cat > "$ws/game/DESIGN.md" <<MD
# Design log — game-master
Decisions tagged USER (you) vs AI (the agent). Add a row each session.
MD
mkdir -p "$ws/.harness"
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"no game yet","findings":[],
 "phases":[{"id":"seed","name":"Seeded core","state":"pending"},
           {"id":"game","name":"The game","state":"pending"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
printf 'initialized by %s\n' "$dsh" > "$ws/.harness-initialized"
