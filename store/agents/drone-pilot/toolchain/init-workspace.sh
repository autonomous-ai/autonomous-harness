#!/usr/bin/env bash
# Lay out a Drone Pilot workspace and seed a not-ready verdict. The framework
# copies the template (whose marker placeholder is replaced by the real flight).
set -euo pipefail
dsh="${HARNESS_DSH:-autonomous/drone-pilot}"
ws="${1:-$PWD}"
mkdir -p "$ws/flight"
cat > "$ws/flight/DESIGN.md" <<MD
# Design log — drone-pilot
Decisions tagged USER (you) vs AI (the agent). Add a row each session.
MD
mkdir -p "$ws/.harness"
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"no flight yet","findings":[],
 "phases":[{"id":"seed","name":"Seeded core","state":"pending"},
           {"id":"flight","name":"The flight","state":"pending"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
printf 'initialized by %s\n' "$dsh" > "$ws/.harness-initialized"
