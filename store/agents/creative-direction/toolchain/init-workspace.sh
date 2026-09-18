#!/usr/bin/env bash
# Lay out a Creative Direction workspace and seed a not-ready verdict. The
# framework copies the template (whose marker placeholder is replaced by the real board).
set -euo pipefail
dsh="${HARNESS_DSH:-autonomous/creative-direction}"
ws="${1:-$PWD}"
mkdir -p "$ws/board"
cat > "$ws/board/DESIGN.md" <<MD
# Design log — creative-direction
Decisions tagged USER (you) vs AI (the agent). Add a row each session.
MD
mkdir -p "$ws/.harness"
cat > "$ws/.harness/verdict.json" <<JSON
{"spec":1,"ready":false,"summary":"no board yet","findings":[],
 "phases":[{"id":"seed","name":"Seeded core","state":"pending"},
           {"id":"board","name":"The board","state":"pending"},
           {"id":"edition","name":"Edition","state":"pending"}]}
JSON
printf 'initialized by %s\n' "$dsh" > "$ws/.harness-initialized"
