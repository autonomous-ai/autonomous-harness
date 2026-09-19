# JUCE Agent Toolkit workspace

This harness turns a request into a real, inspectable audio artifact. Start with
the `juce-agent-toolkit` skill. The editable project is `studio.json` plus files in this workspace.
The viewer follows `out/latest.json` and the run history; save small useful changes as you work.

Run `"$STUDIO_TOOLCHAIN/run.sh" render` after a change. The runner validates controls,
records provenance, writes artifacts, and updates `.harness/verdict.json`. Do not hand-edit the
verdict to claim a run succeeded. Inspect the produced artifact before describing the result.

The browser audition and Python WAV renderer are local DSP previews. The JUCE action compiles a native offline renderer from the workspace CMake project. JUCE toolkit skills also cover creating full DAW plugins; the starter renderer is not a VST3 plugin.

The installed sources are at `$STUDIO_UPSTREAM`. Preserve upstream credit and use the pinned
instructions when extending the domain workflow. Local simulations are the default. Ask before
using a paid generation service or operating physical hardware unless the user already authorized it.

When developing this package itself, keep it independently installable from its folder; shared
runtime copies are synchronized by `store/tools/sync-studios.mjs` and `sync-runtimes.mjs`.
