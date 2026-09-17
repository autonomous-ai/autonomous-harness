# Remotion, as a Harness agent

[Harness](https://github.com/autonomous-ai/autonomous-harness) agent package for
[Remotion](https://www.remotion.dev): describe a video in the chat pane, watch it play in the Remotion
Studio pane as the agent writes it in React, then render it to MP4. Runs on Claude Code.

- `harness.json` — engine, template, skills, toolchain, and this package's own viewer (Remotion Studio).
- `viewer.sh` → `viewer.mjs` + `viewer.html` — the pane. Remotion Studio runs on a private loopback
  port (`toolchain/loopback.cjs` keeps it off the network: Remotion binds every interface and has no
  flag for it) and is proxied on the port Harness hands the pane, under a slim bar: **Studio** —
  opened on the composition whose source changed last, with a nudge when the agent registers a new
  one — and **Renders** — every video, GIF and still in `out/`, newest first, with a player
  (Space, ← →, `,` `.` frame steps, L loop, F full screen), stale renders marked, and the render in
  progress as a progress bar that the bar mirrors from either tab.
- `toolchain/remotion` — `$REMOTION` for the agent: Remotion's CLI unchanged, except that `render`
  and `still` write their progress to `.harness/render.json` for the pane and print it every tenth
  of the way instead of every frame.
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
node --test toolchain/test_remotion.mjs            # $REMOTION's progress parsing
```
