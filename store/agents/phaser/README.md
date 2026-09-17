# Phaser, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Phaser](https://phaser.io): describe a game in the terminal pane — a breakout, a platformer, a
shooter, a puzzle — and play it in the pane beside it while the agent writes it in Phaser 4. Runs on
**Codex**.

- `harness.json` — engine, template, skills, toolchain, and this package's own viewer.
- `viewer.sh` — `vite` on the workspace, on the port Harness hands it, loopback only. Vite's HMR is
  what makes the pane live: the agent saves a scene, the game reloads in place.
- `toolchain/setup.sh` — one `node_modules` in this directory (Phaser 4.2.1, Vite 6, terser, pinned
  in `package.json` and `VERSIONS`) that every workspace symlinks to, so a new game is instant and
  there is one copy of Phaser on the machine.
- `toolchain/verdict.py` — the phases the pane header shows: **Write** (an entry and a scene),
  **Build** (`vite build` — the compile check; parse and resolve errors become findings with a file
  and a line), **Play** (a scene with `create()` and input handling). `python3 -m unittest
  discover -s toolchain` tests the judge without Vite.
- `skills/` — Phaser Studio's own 28 agent skills, vendored verbatim (`PROVENANCE.md`), plus
  `harness-phaser`: the workspace, the pane, the keyboard-focus rule, the verdict.
- `template/` — a Vite + Phaser 4 project, 960×540 scaled to FIT, whose starter is a playable
  breakout drawn entirely with `Graphics` → `generateTexture`; no image files anywhere.

## The one thing worth knowing

The pane is a webview, and **a webview has no keyboard focus until the player clicks inside it**. So
every game here opens on a gate — a title, "Click to play", `this.input.once('pointerdown', …)` —
and ships on-screen touch controls beside the keys, because pointer input needs no focus. That rule
is in `AGENTS.md`, in `skills/harness-phaser/SKILL.md`, in the template, and the verdict says so
when a workspace loses it.

## Credit and stewardship

Phaser is Richard Davey's and Phaser Studio's — [phaserjs/phaser](https://github.com/phaserjs/phaser),
[phaser.io](https://phaser.io) — under the **MIT License** (`LICENSE-phaser`). Nothing of it is
changed here: the engine is installed from npm as released, and Phaser Studio's agent skills are
copied into `skills/` verbatim, at the commit recorded in `PROVENANCE.md`, as the MIT licence
allows. This repository is the Harness wrapper — the manifest, the pane script, the template, the
toolchain, the verdict, the one `harness-phaser` skill — written by Autonomous to bring Phaser into
Harness, on the project's behalf, to bootstrap the catalogue. The wrapper is MIT too (`LICENSE`).

If you maintain Phaser and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we transfer this
repository and point the registry entry at it. Until then: bugs in Phaser belong upstream, bugs in
the wrapper belong here, and a newer Phaser is a bump of `package.json`, `template/package.json` and
`VERSIONS` plus a refresh of `skills/` (`PROVENANCE.md` has the commands).

| | |
|---|---|
| Homepage | <https://phaser.io> |
| Upstream | <https://github.com/phaserjs/phaser> |
| Licence | MIT |

```sh
harness dsh check .                                   # conformance
harness dsh install . --link                          # this checkout as the installed agent
python3 -m unittest discover -s toolchain              # the verdict's judge, without vite
```
