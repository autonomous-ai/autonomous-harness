#!/usr/bin/env bash
# Lay out a Music Studio workspace and seed a not-ready verdict. The framework
# copies the template (whose marker placeholder is replaced by the real piece).
set -euo pipefail
dsh="${HARNESS_DSH:-autonomous/music-studio}"
ws="${1:-$PWD}"
mkdir -p "$ws/piece"
cat > "$ws/piece/DESIGN.md" <<MD
# Design log — music-studio
Decisions tagged USER (you) vs AI (the agent). Add a row each session.
MD
mkdir -p "$ws/.harness"
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"no piece yet","findings":[],
 "phases":[{"id":"seed","name":"Seeded core","state":"pending"},
           {"id":"piece","name":"The piece","state":"pending"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
printf 'initialized by %s\n' "$dsh" > "$ws/.harness-initialized"
