#!/bin/sh
# Runs once in a fresh workspace after the template is copied. Harness sets HARNESS_WORKSPACE and
# HARNESS_DSH_DIR. Seed a first verdict so the pane header has a state before the first prompt.
mkdir -p .harness world
cat > .harness/verdict.json <<JSON
{ "spec": 1, "ready": false, "summary": "no world yet — describe one and I'll build it",
  "phases": [ { "id": "world", "name": "World", "state": "pending" } ],
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
cat > world/DESIGN.md <<MD
# Design log

Every crafted decision is tagged USER or AI so a discarded idea doesn't resurrect.

MD
printf 'initialized by %s\n' "${HARNESS_DSH:-?}" > .harness-initialized
