# marimo, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[marimo](https://marimo.io): describe an analysis, a model, a dashboard in the chat pane; watch the
reactive notebook come alive in the marimo pane — marimo's own editor on the notebook the agent
writes, cells re-running as the file changes. Runs on Claude Code.

- `harness.json` — engine, template, skills, toolchain, and this package's own viewer (marimo's server).
- `viewer.sh` — `marimo edit --headless --watch` on the workspace's notebook, on the port Harness hands it.
- `skills/` — marimo's own agent skills, verbatim (`PROVENANCE.md`).
- `toolchain/setup.sh` — one venv with the pinned marimo (`MARIMO_VERSION`) and the usual libraries;
  `verdict.py` runs `marimo check` and then the notebook as a script.
- `template/` — a starter notebook: a slider, a dataframe, a chart.

## Credit and stewardship

marimo is the marimo team's — [marimo-team/marimo](https://github.com/marimo-team/marimo),
Apache-2.0 (`LICENSE-marimo`) — and so are the skills in `skills/`
([marimo-team/skills](https://github.com/marimo-team/skills), Apache-2.0, `LICENSE-marimo-skills`,
copied verbatim at the commit in `PROVENANCE.md`). Nothing of either is changed here. This package
is the Harness wrapper — the manifest, the pane script, the template, the toolchain, the verdict —
written by Autonomous to bring marimo into Harness, on the project's behalf, to bootstrap the
catalogue.

If you maintain marimo and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in marimo or its skills belong
upstream, bugs in the wrapper belong here, and a newer marimo is a bump of `MARIMO_VERSION`.

```sh
harness dsh check .                                # conformance
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without marimo
```
