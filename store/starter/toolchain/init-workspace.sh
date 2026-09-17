#!/bin/sh
# Runs once, in a fresh workspace (cwd = the workspace), after the template was copied. Harness sets
# HARNESS_WORKSPACE and HARNESS_DSH_DIR. This one records where it ran, so a test can see it did.
printf 'initialized by %s\n' "${HARNESS_DSH:-?}" > .harness-initialized
