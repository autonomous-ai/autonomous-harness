# Strudel, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Strudel](https://strudel.cc) — TidalCycles in JavaScript: describe a track in the chat pane and
hear it in the Strudel pane as the agent writes the pattern. Runs on Claude Code.

- `harness.json` — engine, template, skill, toolchain, and this package's own viewer.
- `viewer.mjs` + `pane/` — the pane: Strudel's own REPL as a web component, from the package's own
  `node_modules`, no CDN, with what it takes to *see* the music. A transport (Play/Stop, tempo, bar
  and beat, the output's waveform and spectrum); one lane per voice — the arguments of the top-level
  `stack(...)` or the `$:` lines, named after the comment above each — scrolling under a playhead,
  zoomable from 1 to 32 bars, with activity lights, Mute and Solo (`1`–`9`, `⇧1`–`⇧9`) and a hover
  inspector; the code once, lit per voice as it plays. A save hot-swaps the pattern without stopping
  the transport, and a save that does not run shows its error and line while the last good version
  keeps playing. `pane/voices.mjs` is the voice parser (`node --test pane/voices.test.mjs`).
- `toolchain/verdict.py` — the check: the file parses with the same parser the REPL uses, has a
  pattern in it, and says whether it plays offline. `setup.sh` is `npm ci`.
- `skills/strudel/` — the Strudel skill (ours): mini-notation, synths, effects, song structure.
  `template/` — a starter track, synths only, so it plays with no network.

```sh
harness dsh check .                              # conformance
harness dsh install "$PWD" --link                # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py    # the verdict
node --test pane/voices.test.mjs                 # the pane's voice parser
```

## What cannot be checked here

Whether the track sounds good. Strudel plays in a browser, after a click, and no check here listens
to it. The verdict parses the pattern and reports what it can — the pane and the
user's ears do the rest.

## Credit and stewardship

Strudel is Felix Roos's and the Strudel contributors' — [codeberg.org/uzu/strudel](https://codeberg.org/uzu/strudel),
mirrored at [tidalcycles/strudel](https://github.com/tidalcycles/strudel) — and it is licensed
**GNU AGPL-3.0-or-later** (`LICENSE-strudel`). None of it is in this package. `toolchain/setup.sh`
installs `@strudel/repl` from npm into this package's `node_modules`, exactly as the Strudel project
publishes it, unmodified, and the pane serves it from there. The wrapper in this package — the
manifest, the pane server, the skill, the template, the verdict — is MIT (`LICENSE`), written by
Autonomous to bring Strudel into Harness, on the project's behalf, to bootstrap the catalogue.

If you maintain Strudel and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Strudel belong upstream, bugs in
the wrapper belong here, and a newer Strudel is a bump in `package.json`.
