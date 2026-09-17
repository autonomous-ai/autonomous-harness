# text-to-cad, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for Jake Fitzgerald's
[text-to-cad](https://github.com/earthtojake/text-to-cad): describe a part in the chat pane, get
STEP with mesh exports, drawings, robot descriptions and G-code, and watch it take shape in the CAD
Viewer pane beside the terminal. Runs on Claude Code; the skills are upstream's, pinned and unedited.

- `harness.json` — the manifest (spec 1.1): engine, template, skills, toolchain, `viewer.use`.
- `skills/` — text-to-cad's eleven skills at the release in `PROVENANCE.md`, verbatim.
- `AGENTS.md` — what the agent is told: where the toolchain is, build early, verdict after each build.
- `template/` — a fresh workspace in the skill's own project layout, with a starter part.
- `toolchain/` — `setup.sh` (one venv: the pinned `cadgen`, the skills' extras, a browser for
  snapshots), `doctor.sh`, `init-workspace.sh`, and `verdict.py`, the pane header.
- The pane is [`autonomous/cad-viewer`](https://github.com/autonomous-ai/autonomous-harness/tree/main/store/viewers/cad-viewer),
  installed with this package.

## Credit and stewardship

text-to-cad is Jake Fitzgerald's: [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad), MIT, copyright 2026 Thompson Labs LLC (`LICENSE-text-to-cad`); `skills/` is his release, byte for byte (`PROVENANCE.md`). Nothing of it is changed here.
This folder is the Harness wrapper — the manifest, the agent guide, the workspace template, the toolchain and the verdict writer — written by Autonomous to bring text-to-cad into
Harness. We did that work on the project's behalf, to bootstrap the catalogue; the credit for what
the agent can do belongs upstream.

If you maintain text-to-cad and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in text-to-cad belong upstream, bugs in the
wrapper belong here, and a newer release is a `skills/` swap and a `CADGEN_VERSION` bump.

```sh
harness dsh check .                              # conformance
harness dsh install "$PWD" --link                # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py    # the verdict, without cadgen
```
