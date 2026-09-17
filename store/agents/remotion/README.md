# Remotion, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Remotion](https://www.remotion.dev): describe a video in the chat pane, watch it play in the Remotion
Studio pane as the agent writes it in React, then render it to MP4. Runs on Claude Code.

- `harness.json` — engine, template, skills, toolchain, and this package's own viewer (Remotion Studio).
- `viewer.sh` — `remotion studio` on the workspace, on the port Harness hands it, `BROWSER=none`.
- `toolchain/setup.sh` — one `node_modules` (pinned in `package.json`) that every workspace links to,
  the headless browser Remotion renders with, and Remotion's own agent skills **fetched** at the
  commit in `VERSIONS` — not copied into this package, because
  [remotion-dev/skills](https://github.com/remotion-dev/skills) carries no licence to copy under.
  `verdict.py` bundles the project and lists its compositions.
- `template/` — a Remotion project: one composition, a title beat.

## Credit and stewardship

Remotion is Remotion AG's — [remotion-dev/remotion](https://github.com/remotion-dev/remotion) — under
the **Remotion License** (`LICENSE-remotion`): free for individuals and for companies of up to three
people, a company licence otherwise (remotion.dev/license). Nothing of it is changed here; it is
installed from npm as released, and its skills are fetched from its own repository at install time.
This folder is the Harness wrapper — the manifest, the pane script, the template, the toolchain,
the verdict — written by Autonomous to bring Remotion into Harness, on the project's behalf, to
bootstrap the catalogue. The wrapper is MIT; the Remotion License governs Remotion.

If you maintain Remotion and want to own its Harness package, it is yours: open an issue on
[autonomous-harness](https://github.com/autonomous-ai/autonomous-harness/issues) and we move this folder into a
repository of yours and point the registry entry at it. Until then: bugs in Remotion belong upstream, bugs in
the wrapper belong here, and a newer Remotion is a bump of `package.json` and `VERSIONS`.

```sh
harness dsh check .                                # conformance (warns: skills arrive with setup)
harness dsh install "$PWD" --link                  # this checkout as the installed agent
python3 -m unittest toolchain/test_verdict.py      # the verdict, without remotion
```
