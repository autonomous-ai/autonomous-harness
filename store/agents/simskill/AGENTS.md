# SimSkill workspace

This harness turns a request into a real, inspectable simulation artifact. Start with
the `simskill` skill. The editable project is `studio.json` plus files in this workspace.
The viewer follows `out/latest.json` and the run history; save small useful changes as you work.

Run `"$STUDIO_TOOLCHAIN/run.sh" simulate` after a change. The runner validates controls,
records provenance, writes artifacts, and updates `.harness/verdict.json`. Do not hand-edit the
verdict to claim a run succeeded. Inspect the produced artifact before describing the result.

The local workflow generates an original four-way intersection with SUMO netconvert and simulates actual traffic with SUMO. Playback uses its floating-car output. A comparison is a simulation experiment, not a calibrated forecast for a real city. Intel Macs build pinned SUMO 1.27.1 headlessly with package-local Xerces.

The installed sources are at `$STUDIO_UPSTREAM`. Preserve upstream credit and use the pinned
instructions when extending the domain workflow. Local simulations are the default. Ask before
using a paid generation service or operating physical hardware unless the user already authorized it.

When developing this package itself, keep it independently installable from its folder; shared
runtime copies are synchronized by `store/tools/sync-studios.mjs` and `sync-runtimes.mjs`.
