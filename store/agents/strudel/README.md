# Strudel, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Strudel](https://strudel.cc) — TidalCycles in JavaScript: describe a track in the chat pane and
hear it in the Strudel pane as the agent writes the pattern. Runs on Claude Code.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `viewer.mjs` — the pane: Strudel's own REPL as a web component, from the package's own
  `node_modules`, no CDN. Play and Stop in a bar above it, the file's text below it, and a save
  hot-swaps the pattern on the next cycle instead of restarting the transport.
- `toolchain/verdict.py` — the check: the file parses with the same parser the REPL uses, has a
  pattern in it, and says whether it plays offline. `setup.sh` is `npm ci`.
- `skills/strudel/` — the Strudel skill (ours): mini-notation, synths, effects, song structure.
  `template/` — a starter track, synths only, so it plays with no network.

```sh
harness dsh check .                              # conformance
harness dsh install . --link                     # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py    # the verdict
```

## What cannot be checked here

Whether the track sounds good, or sounds at all. There is no headless audio: Strudel plays in a
browser, after a click. The verdict parses the pattern and reports what it can — the pane and the
user's ears do the rest.

## Credit and stewardship

Strudel is Felix Roos's and the Strudel contributors' — [codeberg.org/uzu/strudel](https://codeberg.org/uzu/strudel),
mirrored at [tidalcycles/strudel](https://github.com/tidalcycles/strudel) — and it is licensed
**GNU AGPL-3.0-or-later** (`LICENSE-strudel`). None of it is in this repository. `toolchain/setup.sh`
installs `@strudel/repl` from npm into this package's `node_modules`, exactly as the Strudel project
publishes it, unmodified, and the pane serves it from there. The wrapper in this repository — the
manifest, the pane server, the skill, the template, the verdict — is MIT (`LICENSE`), written by
Autonomous to bring Strudel into Harness, on the project's behalf, to bootstrap the catalogue.

If you maintain Strudel and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in Strudel belong upstream, bugs in
the wrapper belong here, and a newer Strudel is a bump in `package.json`.
