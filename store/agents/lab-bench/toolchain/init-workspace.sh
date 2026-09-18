#!/usr/bin/env bash
# Lay out a Lab Bench workspace and seed a not-ready verdict. The framework
# copies the template (whose marker placeholder is replaced by the real bench).
set -euo pipefail
dsh="${HARNESS_DSH:-autonomous/lab-bench}"
ws="${1:-$PWD}"
mkdir -p "$ws/bench"
cat > "$ws/bench/DESIGN.md" <<MD
# Design log — lab-bench
Decisions tagged USER (you) vs AI (the agent). Add a row each session.
MD
mkdir -p "$ws/.harness"
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"no bench yet","findings":[],
 "phases":[{"id":"seed","name":"Seeded core","state":"pending"},
           {"id":"bench","name":"The bench","state":"pending"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
printf 'initialized by %s\n' "$dsh" > "$ws/.harness-initialized"
