# Marp harness

> Marp is Yuki Hattori's and the Marp team's. This package brings it into Harness; see
> *Credit and stewardship* below.

A domain-specific harness for [Autonomous Harness](https://github.com/autonomous-ai/autonomous-harness):
describe a talk in the chat pane, watch a keynote take shape in the viewer pane — black or white,
huge type, generated art, speaker notes — and export it to PDF, PPTX or HTML. Runs on Claude Code;
slides are [Marp](https://marp.app) Markdown on the harness's `keynote-dark` / `keynote-light` themes.

- `harness.json` — the manifest Harness reads (spec 1).
- `AGENTS.md` — what the agent is told; `skills/marp-deck` — the dialect, patterns, check, export.
- `themes/` — `keynote-dark.css`, `keynote-light.css`: the slide classes (`hero`, `statement`,
  `section`, `pillars`, `image`, `number`, `chart`, `quote`, `closing`, `omt`).
- `template/` — a fresh workspace: a seven-slide keynote in `deck.md`, its art in `assets/`.
- `toolchain/` — the pinned `marp-core` + `marp-cli`, the viewer (`viewer.mjs` + `viewer/`: a
  slide with its notes and a filmstrip, a grid, a presenter view with next slide, notes and timer,
  full-screen presenting with a black screen and go-to-slide, live redraws that keep your slide or
  follow the agent's edit, findings marked on their slides), the check, and `art.mjs` (wallpapers,
  charts and device frames, offline).

```sh
harness dsh check .          # conformance
harness dsh install "$PWD" --link # this checkout as the installed harness
cd toolchain && npm test          # the check, the phases, the themes, the art
```

## Credit and stewardship

Marp is Yuki Hattori's and the Marp team's: [marp-team/marp-core](https://github.com/marp-team/marp-core) and [marp-cli](https://github.com/marp-team/marp-cli), MIT, copyright 2018 Marp team (`LICENSE-marp`, `THIRD_PARTY_NOTICES.md`). Nothing of it is changed here.
This folder is the Harness wrapper — the manifest, the agent guide, the keynote themes, the art generator, the viewer page, the check, the workspace template — written by Autonomous to bring Marp into
Harness. We did that work on the project's behalf, to bootstrap the catalogue; the credit for what
the agent can do belongs upstream.

If you maintain Marp and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Marp belong upstream, bugs in the
wrapper belong here, and a newer release is a bump of `toolchain/package.json`.
