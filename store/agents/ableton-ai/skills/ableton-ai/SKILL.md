---
name: ableton-ai
description: Create and inspect music projects in the Ableton AI Harness workspace, including its local starter and optional upstream integration.
---

# Loop room

Read `studio.json` to understand the current controls; `"$STUDIO_TOOLCHAIN/../studio.config.json"`
describes their ranges. Run `"$STUDIO_TOOLCHAIN/run.sh" render` to make a new result.
Successful artifacts and their measurements are in `out/runs/<id>/`; `out/latest.json` names the
current result. A failed run preserves the last success and records the error in the verdict.

The starter is a local synthesized MIDI sequencer. It writes a standard MIDI file and WAV preview without Ableton. The optional Live action reads a running Ableton AI bridge; it does not overwrite tracks or start transport.

Use `"$STUDIO_TOOLCHAIN/../README.md"` for the integration contract and commands. Read the relevant
files under `$STUDIO_UPSTREAM` before using an upstream API. Keep controls within their documented
ranges, preserve the data needed to reproduce a comparison, and distinguish preview results from
native service or hardware output. The viewer supports history and artifact downloads; tell the
user which run contains the result, and what was actually measured.

## Make a loop that can leave the viewer

Choose a scale, tempo, density, and swing. Audition the step grid, keep a run, and verify
`notes.json`, `loop.mid`, and `loop.wav`. A nonempty sixteen-character `pattern` mask overrides
density; clear it to regenerate a seeded rhythm. The browser and exporter share a tested
pattern algorithm, so note pitches, velocity, and timing remain reproducible.

Read `$STUDIO_UPSTREAM/skills/ableton/SKILL.md` for real Live composition and its documented
track/device/clip operations. The wrapper's `live` action is a read-only session snapshot; it
does not import the MIDI, change a set, or start transport. Enable the pinned upstream control
surface before using its native tools, and preserve the user's current session.
