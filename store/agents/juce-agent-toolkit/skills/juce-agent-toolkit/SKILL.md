---
name: juce-agent-toolkit
description: Create and inspect audio projects in the JUCE Agent Toolkit Harness workspace, including its local starter and optional upstream integration.
---

# Instrument maker

Read `studio.json` to understand the current controls; `"$STUDIO_TOOLCHAIN/../studio.config.json"`
describes their ranges. Run `"$STUDIO_TOOLCHAIN/run.sh" render` to make a new result.
Successful artifacts and their measurements are in `out/runs/<id>/`; `out/latest.json` names the
current result. A failed run preserves the last success and records the error in the verdict.

The browser audition and Python WAV renderer are local DSP previews. The JUCE action compiles a native offline renderer from the workspace CMake project. JUCE toolkit skills also cover creating full DAW plugins; the starter renderer is not a VST3 plugin.

Use `"$STUDIO_TOOLCHAIN/../README.md"` for the integration contract and commands. Read the relevant
files under `$STUDIO_UPSTREAM` before using an upstream API. Keep controls within their documented
ranges, preserve the data needed to reproduce a comparison, and distinguish preview results from
native service or hardware output. The viewer supports history and artifact downloads; tell the
user which run contains the result, and what was actually measured.

## Make and validate an instrument

Start by changing one audible property: waveform, pitch, attack, or brightness. Render the
same four-note phrase before and after. Compare peak/RMS levels and listen to both WAV files.
For native DSP changes, edit workspace `Source/main.cpp`, run `juce`, and inspect the measured
recording. Keep the CMake target and WAV command arguments intact so the viewer can run it.

For full plugins, read `$STUDIO_UPSTREAM/skills/juce-project-create/SKILL.md`, then the
`juce-project-starter` and `juce-build-release` skills there. Plugin exports need their own host
and audio checks. The offline renderer is the starter's verified native path.
