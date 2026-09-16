# Domain-specific harnesses

A **domain-specific harness (DSH)** turns Harness into a product for one domain: PCB design,
3D CAD, short drama, robot training. It is a git repo that Harness installs on a machine. Users see
it as one more tile in New Harness — pick **Copper**, choose a folder, prompt — and get
the domain's skills in the agent, its toolchain on the machine, its viewer in a pane next to the
terminal, and its verdict in the pane header.

Harness never imports a DSH's code. It reads one manifest, copies files into the workspace, runs
the commands the manifest declares, and watches one JSON file. That is the whole coupling, and it
is what lets hundreds of DSHs exist without any of them touching this repo.

## Anatomy

| In the repo | What it is |
|---|---|
| `harness.json` | the manifest: id, name, category, base engine, workspace, skills, toolchain, viewer, verdict path |
| `AGENTS.md` | what the engine is told in every workspace; a `claude` base gets a `CLAUDE.md` that imports it |
| `skills/` | the domain's craft as `SKILL.md` bundles, symlinked into the workspace so edits are live |
| `template/` | a fresh workspace, copied once into an empty folder, plus an optional `init` script |
| `toolchain/setup`, `doctor` | install the domain's tools at install time; say what is missing, one line per check |
| `viewer` | a loopback web server Harness runs beside the terminal; the pane is a webview on it |
| `.harness/verdict.json` | the one file the domain writes and Harness reads: ready or not, findings, phases |

## Build one

1. **Copy the starter.** [`dsh/starter-dsh/`](starter-dsh/) is a complete tier-0 harness: a
   manifest, an `AGENTS.md`, one skill, a template, a toolchain that installs nothing.

   ```bash
   cp -r dsh/starter-dsh ~/code/my-harness && cd ~/code/my-harness && git init
   ```

   In `harness.json` set `id` (`owner/name`, the install directory and the wire id), `name` (the
   tile), `category` (the tile's second line), `engine` (`claude` or `codex`), and
   `workspace.marker` (a file whose presence means the workspace is already laid out).

2. **Tell the agent its job.** `AGENTS.md` says what the workspace is, where things go, what to do
   first, and how to work so the pane moves: first save within a minute, then build up, check after
   every pass. The craft itself goes in `skills/<name>/SKILL.md`: the dialect, the patterns, the
   commands. Skills are symlinked, so a change in your checkout is live in every workspace.

3. **Lay out the workspace.** `template/` is copied into an empty folder once; then
   `workspace.init` runs with the workspace as its working directory and `HARNESS_DSH_DIR` pointing
   at the install. Seed the first verdict here so the header has a state before the first prompt.

4. **Ship the toolchain with the harness.** `toolchain/setup.sh` runs once at install, in the
   install directory: pin versions and vendor them there (a `node_modules`, a `.venv`), never into
   the user's machine. `toolchain/doctor.sh` exits 0 when the machine can run the harness and prints
   one line per check; Harness shows those lines. Point the agent at the tools through `agent.env`
   (`"MARP_TOOLCHAIN": "${dsh}/toolchain"`); `${dsh}`, `${workspace}` and `${home}` expand.

5. **Write the verdict as a feed.** `.harness/verdict.json` is written at every check and every
   phase change, not at the end. `ready` is the one machine truth; `summary` is the header's line;
   `phases` is how the header says "you are here".

   ```json
   { "spec": 1, "ready": false, "summary": "10 slides so far · 1 warning",
     "findings": [{ "severity": "warning", "kind": "dense", "message": "slide 4 has 61 words" }],
     "artifact": "deck.md",
     "phases": [{ "id": "outline", "name": "Outline", "state": "done" },
                { "id": "draft", "name": "Draft", "state": "active" },
                { "id": "polish", "name": "Polish", "state": "pending" }],
     "updatedAt": "2026-09-15T23:33:00Z" }
   ```

6. **Add the viewer.** `viewer.command` is a long-running process. Harness starts it with
   `HARNESS_VIEWER_PORT`, `HARNESS_WORKSPACE`, `HARNESS_DSH_DIR` and `HARNESS_DSH` in its
   environment, waits for the port to open on `127.0.0.1`, then loads `viewer.url` in the pane
   (`${port}` and `${artifact}` expand; the artifact is what the verdict names, or the newest file
   matching `artifactExtensions`). Serve files from the workspace and nothing outside it, watch the
   workspace, push a reload on every change, and re-run your check on every change so the header
   moves while the agent writes without the agent running anything. Marp's viewer does all of this
   in about 110 lines of Node with no dependencies beyond its renderer.

7. **Check it, install it, run it.**

   ```bash
   harness dsh check .                    # conformance: the manifest, the scripts, the schemas
   harness dsh install . --link           # this checkout as the installed harness (a symlink)
   harness dsh doctor owner/name          # what the machine is missing, if anything
   harness dsh list                       # installed here, and what the registry offers
   ```

   Then New Harness, your tile, a folder, a prompt. For a check without the app,
   [`dsh/tools/dsh-e2e.mjs`](tools/) creates an agent over the daemon's loopback socket and
   reports the materialized workspace, the viewer URL, the pane's environment and the first verdict.
   The viewer process reads its own files when it starts; after you edit it, kill it and the daemon
   respawns it on the new code.

8. **Publish.** Add `dsh/registry/<owner>/<name>.json` in a pull request:

   ```json
   { "id": "owner/name", "name": "Name", "category": "Thing", "description": "One line.",
     "repo": "https://github.com/owner/name", "ref": "main", "engine": "claude",
     "tier": 2, "verified": false }
   ```

   CI clones the repo at that ref and runs the conformance check. Once merged, the app offers the
   tile before the harness is installed and installs it on Create; `verified: true` is for
   first-party entries, everything else shows its git URL on install.

## Tiers

| Tier | Ships | Harness shows |
|---|---|---|
| 0 | manifest, `AGENTS.md`, skills, template | the tile, a terminal with the skills loaded |
| 1 | + a check that writes `.harness/verdict.json` | + ready or not, findings and phases in the pane header |
| 2 | + a viewer server | + the viewer pane beside the terminal, following the artifact |

## Worked examples

| Harness | Base | What it shows |
|---|---|---|
| [Marp](https://github.com/autonomous-ai/autonomous-marp) (Slides) | Claude Code | the smallest complete tier 2: a 110-line viewer with live reload and a present mode, two themes, an offline art generator, a check that writes the verdict, node tests. Start here. |
| [Copper](https://github.com/autonomous-ai/autonomous-circuit) (PCB) | Claude Code | a Python toolchain vendored by `setup.sh`, a board viewer, phases Build / Checks / Fab written by the generation pipeline |
| [Toymaker](https://github.com/autonomous-ai/autonomous-workshop) (CAD) | Codex | a Codex base, CAD scripts as skills, a STEP viewer found through `artifactExtensions`, phases Build / Fit / Print / Motion / Review |

Two rules hold across all of them. The pane is progressive: a harness that only produces a final
file is not one. And the domain stays in the harness: if adding yours needs a change in this repo,
that is a spec change, and [`spec/README.md`](spec/README.md) with its schemas is where the
contract lives. Changes to it are appended to [`spec/CHANGES.md`](spec/CHANGES.md).

## Stewardship of packages built on other people's work

Some first-party packages wrap a project Autonomous did not write: Marp (Yuki Hattori and the Marp
team), text-to-cad and the CAD Viewer (Jake Fitzgerald). Each carries the upstream licence and a
`THIRD_PARTY_NOTICES.md`, changes nothing upstream, names the author on its tile (`author` in the
manifest), and says in its README that Autonomous wrote the wrapper on the project's behalf to
bootstrap the catalogue. The ideal end state is that maintainers own their own Harness package: any
upstream maintainer can ask, on this repository's issues, to have the wrapper repository transferred
and the registry entry pointed at theirs. Until then bugs in the project go upstream and bugs in the
wrapper come here.

