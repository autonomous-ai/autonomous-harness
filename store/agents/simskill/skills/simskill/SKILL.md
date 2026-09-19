---
name: simskill
description: Create and inspect simulation projects in the SimSkill Harness workspace, including its local starter and optional upstream integration.
---

# City lab

Read `studio.json` to understand the current controls; `"$STUDIO_TOOLCHAIN/../studio.config.json"`
describes their ranges. Run `"$STUDIO_TOOLCHAIN/run.sh" simulate` to make a new result.
Successful artifacts and their measurements are in `out/runs/<id>/`; `out/latest.json` names the
current result. A failed run preserves the last success and records the error in the verdict.

The local workflow generates an original four-way intersection with SUMO netconvert and simulates actual traffic with SUMO. Playback uses its floating-car output. A comparison is a simulation experiment, not a calibrated forecast for a real city. Intel Macs build pinned SUMO 1.27.1 headlessly with package-local Xerces.

Use `"$STUDIO_TOOLCHAIN/../README.md"` for the integration contract and commands. Read the relevant
files under `$STUDIO_UPSTREAM` before using an upstream API. Keep controls within their documented
ranges, preserve the data needed to reproduce a comparison, and distinguish preview results from
native service or hardware output. The viewer supports history and artifact downloads; tell the
user which run contains the result, and what was actually measured.

## Compare a signal plan

Record the baseline, then change east–west green time while holding demand, duration, and
seed fixed. Inspect `trips.csv`, the generated network, and raw `traffic.xml`. Compare mean
delay for completed trips together with the unfinished count and largest stopped queue.
Do not drop unfinished vehicles when describing congestion.

For custom networks, read `$STUDIO_UPSTREAM/.claude/skills/procedural-memory/` in this order:
`create-single-intersection/SKILL.md`, `run-simulation/SKILL.md`, and
`analyze-simulation-outputs/SKILL.md`. Those pinned procedures explain the native SUMO
commands and raw outputs. The starter is an original intersection, not a calibrated city.
