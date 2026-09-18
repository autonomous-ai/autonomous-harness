#!/bin/sh
# Runs once in a fresh workspace after the template is copied.
mkdir -p .harness sketch
cat > .harness/verdict.json <<JSON
{ "spec": 1, "ready": false, "summary": "no piece yet — describe one and I'll render it",
  "phases": [ { "id": "seed", "name": "Seeded core", "state": "pending" } ],
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
cat > sketch/DESIGN.md <<MD
# Design log

Every crafted decision is tagged USER or AI so a discarded idea doesn't resurrect.

MD
printf 'initialized by %s\n' "${HARNESS_DSH:-?}" > .harness-initialized
