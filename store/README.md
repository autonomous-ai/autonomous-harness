# The Harness Store

Everything that makes Harness more than a terminal for coding agents lives here: the contract a
package keeps, the packages Autonomous maintains, the listing for packages that live elsewhere, and the
tools to build and check one.

```
store/
  README.md        this guide: what a package is, how to build and publish one, the shelf's rules
  spec/            the contract, frozen; changes are appended to spec/CHANGES.md
  examples/hello-world/  your first harness: instructions, an HTML page, and a shared viewer
  starter/         a complete tier-0 harness to copy
  tools/           daemon-level checks: create an agent over the loopback socket, report what happened
  agents/<name>/   the built-in harnesses: an engine plus skills, toolchain, verdict, usually a pane
  viewers/<name>/  the built-in panes other packages name with viewer.use; never a tile of their own
  registry/        entries for packages that live in repositories of their own
  CANDIDATES.md    the research behind what is on the shelf, and what might come next
  PLAN.md          the first build plan, kept for its reasoning
```

In code and on the wire a package is still a **DSH**, a domain-specific harness: `harness dsh …`,
`dsh_list`, `cli/src/dsh/`. Those names are the CLI's public contract and stay.

## What a package is

A **harness** turns Harness into a product for one domain: PCB design, 3D CAD, a keynote, a robot in
simulation. It is a folder with a manifest — a repository of its own, or one folder of a bigger one —
that Harness installs on a machine. Users see it as one more tile in New Harness — pick **Autonomous
Circuit**, choose a folder, prompt — and get the domain's skills in the agent, its toolchain on the
machine, its viewer in a pane next to the terminal, and its verdict in the pane header. A **viewer**
is the second kind of package (spec 1.1): a pane with no engine that harnesses share, so Blender and
text-to-cad need not each ship a 3D viewer.

Harness never imports a package's code. It reads one manifest, copies files into the workspace, runs
the commands the manifest declares, and watches one JSON file. That is the whole coupling, and it is
what lets hundreds of packages exist without any of them touching the app or the CLI.

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

**First time?** Follow [Hello World](../CONTRIBUTING.md#your-first-harness): copy a tiny package,
install it locally, and change a greeting in a live HTML preview. It includes the viewer in
`harness.json` with `"viewer": { "use": "autonomous/web-viewer" }`. No app changes are needed.

The steps below explain the optional pieces as your harness grows. Skills, a toolchain, and a
verdict are useful when your domain needs them; a first harness does not need every piece.

1. **Copy the starter.** [`starter/`](starter/) is a complete tier-0 harness: a manifest, an
   `AGENTS.md`, one skill, a template, a toolchain that installs nothing.

   ```bash
   cp -r store/starter store/agents/my-harness      # a built-in package, in this repository
   cp -r store/starter ~/code/my-harness            # or one that lives in a repository of its own
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
   harness dsh check "$PWD"               # conformance: the manifest, the scripts, the schemas
   harness dsh install "$PWD" --link      # this folder as the installed harness (a symlink)
   harness dsh doctor owner/name          # what the machine is missing, if anything
   harness dsh list                       # installed here, and what the registry offers
   ```

   Then New Harness, your tile, a folder, a prompt. For a check without the app,
   [`tools/dsh-e2e.mjs`](tools/) creates an agent over the daemon's loopback socket and
   reports the materialized workspace, the viewer URL, the pane's environment and the first verdict.
   The viewer process reads its own files when it starts; after you edit it, kill it and the daemon
   respawns it on the new code.

## Publish a harness

Two ways, depending on where the package lives.

**In this repository**, as a built-in: the folder is `store/agents/<name>` (or `store/viewers/<name>`),
its id `autonomous/<name>`, and beside `harness.json` a `store.json` with what the store page shows
that a manifest does not know. The catalog publisher lists every such folder; there is no entry to write.

```json
{ "homepage": "https://typst.app", "upstream": "https://github.com/typst/typst", "license": "MIT",
  "tagline": "Markup-based typesetting system",
  "screenshots": [],
  "examples": [{ "prompt": "A one-page invoice for Studio Nord, due in 30 days.",
                 "image": "https://raw.githubusercontent.com/autonomous-ai/openharness/main/store/showcase/typst/invoice.jpg",
                 "caption": "Invoice · 1 page PDF" }] }
```

`tagline` (≤ 80 characters) is the line under the harness's name in New Harness's agent search —
"MuJoCo by Google DeepMind", then "Advanced physics simulation". Take it from the project's own website
or repository, in its words, shortened only by dropping clauses. A package without one shows its category.

`examples` (≤ 8) is what the product page leads with: a prompt, a picture of what the harness really
made from it, and a line naming the result. The page types the prompt out, reveals the picture, and
"Try this prompt" opens New Harness with the prompt as the first message. Pictures live in
`store/showcase/<name>/`, 1600×1000 JPEG under 350 KB, and are real output — never a mock-up.

**In a repository of its own**: add `store/registry/<owner>/<name>.json` in a pull request.

```json
{ "id": "owner/name", "name": "Name", "category": "Thing", "description": "One line.",
  "repo": "https://github.com/owner/name", "ref": "main", "engine": "claude",
  "tier": 2, "verified": false }
```

If the harness uses a shared viewer, include `"viewerUse": "autonomous/web-viewer"` (or the
matching viewer ID) in the registry entry so the Store can show its dependencies before install.
Built-in entries derive this field from the manifest automatically.

A package that is one folder of a bigger repository names it with `"path"`; install then fetches
that folder alone. Run the conformance check and include a real example in the PR; the full test
suite is currently triggered manually. Once merged, the catalog publisher lists it automatically.
The app offers the tile before the package is installed. `verified: true` marks built-in packages;
community packages show their source on install.

### Live catalog

The live catalog is published independently of app and CLI releases. The publisher validates
the complete catalog, checks viewer dependencies, pins built-in packages to the source commit,
and writes one `catalog.json` to the `store-catalog` branch. It uses GitHub only; it does not build
or release the app, run package setup scripts, or access cloud infrastructure. Authors do not
edit a generated index.

Package changes merged into `main` trigger
[`Publish Store catalog`](../.github/workflows/publish-store-catalog.yml), which runs the publisher
on `main` as merged; it uses pinned official actions, gives write permission to the publishing job
alone, and never runs on pull requests or forks. **Actions → Publish Store catalog → Run workflow**
republishes by hand. A maintainer can also publish from a clean, current `main` checkout with
`node store/tools/catalog.mjs --publish`, supplying `GITHUB_TOKEN` with repository contents-write
access.

The CLI reads that public JSON over HTTPS, using conditional requests and a five-minute cache.
Concurrent requests share one fetch. An open Store asks connected machines again every minute;
reopening it also asks. New harnesses and shared viewers appear without a client restart or another
app/CLI release. GitHub caching and the refresh interval mean publication is not instantaneous.

The last validated catalog is saved on disk. If GitHub is unavailable, slow, or serves an invalid
response, clients keep that catalog; a first offline launch uses the bundled catalog. Installed
harnesses remain listed even if their Store entry is removed. Refreshing metadata does not install,
update, or execute packages. Get resolves both the harness and its viewer from the live catalog,
and an already-installed viewer is reused.

Validate publication locally without writing to GitHub:

```bash
node store/tools/catalog.mjs
```

`HARNESS_STORE_CATALOG_URL` selects a catalog mirror or a loopback HTTP fixture for development.
`HARNESS_STORE_REF` still overrides built-in install refs for testing a branch. Existing clients
need the CLI version containing the live reader once; subsequent package publications do not need
releases. Changes to the runtime or package protocol can still require a client update.

## Tiers

| Tier | Ships | Harness shows |
|---|---|---|
| 0 | manifest and instructions; optional skills and template | the tile, a terminal with the instructions loaded |
| 1 | + a check that writes `.harness/verdict.json` | + ready or not, findings and phases in the pane header |
| 2 | + a viewer server | + the viewer pane beside the terminal, following the artifact |

## Worked examples

| Harness | Base | What it shows |
|---|---|---|
| [Hello World](examples/hello-world/) | Codex | a greeting in plain HTML, with a shared viewer declared in the manifest; no build step |
| [Marp](https://github.com/autonomous-ai/openharness/tree/main/store/agents/marp) (Slides) | Claude Code | the smallest complete tier 2: a 110-line viewer with live reload and a present mode, two themes, an offline art generator, a check that writes the verdict, node tests. Start here. |
| [Blender](https://github.com/autonomous-ai/openharness/tree/main/store/agents/blender) (3D) | Claude Code | a pinned `bpy` in a venv set up by `setup.sh`, a helper module the skill teaches, and a viewer package it shares through `viewer.use` |
| [Autonomous Circuit](https://github.com/autonomous-ai/openharness/tree/main/store/agents/autonomous-circuit) (PCB) | Claude Code | a wrapper of another team's project: setup fetches it at a pinned commit and runs its own setup, doctor, init and board viewer |
| [Autonomous Workshop](https://github.com/autonomous-ai/openharness/tree/main/store/agents/autonomous-workshop) (CAD) | Codex | the same shape on a Codex base, with the store's CAD Viewer as its pane, phases Build / Fit / Print / Motion / Review |

Visual harnesses should show work progressively. A terminal-only harness is welcome too. Domain
behavior stays in the package: adding a harness on a supported engine should not need changes to
the app or daemon. If you need a new shared capability, discuss it through the
[`spec/README.md`](spec/README.md) contract. Changes are appended to [`spec/CHANGES.md`](spec/CHANGES.md).

## The built-in shelf

The packages Autonomous maintains are folders here, and the rules below hold for every one of them.
`cli/src/dsh/store.spec.ts` fails the build when a folder breaks one.

- **The two kinds keep different contracts**, so the folder says which: `kind` in `harness.json` agrees
  with `agents/` or `viewers/`.
- **The folder is the upstream project's own name**, and the id is `autonomous/<folder>`: `mujoco`,
  `blender`, `text-to-cad`, `autonomous-circuit`. A wrapper never renames what it wraps.
- **One place per fact.** Name, category, author, description and engine are the manifest's; homepage,
  upstream, licence and screenshots are `store.json`'s. The CLI build turns each folder into its
  registry entry (repo this repository, path the folder, tier from what the manifest ships). The
  live publisher pins its ref to the source commit; the offline build fallback uses `main`.
- **`harness dsh check` passes** on the folder as it is committed.
- **Credit travels with the code.** A `LICENSE` for the wrapper, the upstream's licence beside it when
  anything of theirs is in the folder, and a README whose "Credit and stewardship" section says whose
  project it is.
- **Fetch what is not ours to copy.** A compiler, a model zoo, a project's skills without a licence to
  vendor, another team's repository: `toolchain/setup.sh` fetches it at a pinned version (named in the
  folder's `VERSIONS`) into an ignored directory, never into git.

A user presses Get in the store; the daemon makes a sparse, blob-less clone of this repository, keeps
the one folder, and runs its setup. From a terminal:

```sh
harness dsh install autonomous/typst                          # from the shelf
harness dsh update autonomous/typst                           # update the package; keep projects
harness dsh install "$PWD/store/agents/typst" --link          # this working tree, for development
HARNESS_STORE_REF=my-branch harness start                     # the shelf from a pushed branch
```

A package that outgrows its folder, or whose upstream maintainers want it, moves to a repository of
its own and gets an entry in `registry/` instead. Nothing changes for the people who installed it.

## The store in the app

The app's start page has a door to the store: every harness as a card, and a page per harness — its
mark, who made it (`author`), its category and description, where it lives (`repo` and `path`,
`homepage`, `upstream`), what it is licensed under (`license`), prompts beside what they made
(`examples`), pictures (`screenshots`), ratings and
reviews, and installation actions for this computer: Get, Update, Open and Remove. Installing is still what it always was — a
clone (for a built-in package, of its one folder) under `~/.harness/dsh` on one machine, its toolchain
set up beside it — so the page is honest about that: a harness is on a machine, not on an account.
Ratings and reviews are the signed-in person's, one per package, kept in the control plane, never in
this repository.

The sidebar starts with Search, followed by Discover and six broad sections: Design, Engineering,
Media, Science, Games and Code. Cards show Get, Update or Open for each harness; its page manages installation
on this computer. Package manifests keep their precise domain labels, grouped only for browsing.

Updates are explicit. The Store shows **Update** when a matching catalog source publishes a different
commit with changed package content. Built-in catalog entries carry their package folder's Git tree
revision, so a change elsewhere in the monorepo does not flag every installed harness. Hover over the
short installed version on a package page to see the installed and available commits.

`harness dsh update <id>` follows the matching catalog's published ref, or the recorded source/ref
for an unlisted package or private fork. A community catalog needs a full commit SHA in `ref` to
advertise updates; moving branches can still be updated from the CLI. Linked checkouts are updated
directly by their owner.

The updater fetches and validates a replacement, retains the previous package, and runs setup and
doctor at the permanent installation path. A failed check restores the old files and installed
record. Workspaces, copied instructions, output files and session identities are preserved; existing
skill links resolve to the updated package. Running sessions are not restarted. Setup scripts may
change external tools, and those external side effects cannot be rolled back. Shared viewer updates
are independent: open their page from **Viewers**, then choose **Update**.

Viewer packages are shared dependencies, not Store listings. Installing a harness installs its viewer
on that machine when needed; another harness using the same viewer reuses the installed copy. Viewers
stay out of Discover, search and categories. Authors can still inspect and manage them with
`harness dsh list`, `update`, `doctor` and `remove`. A small **Viewers** icon at the bottom of the Store
sidebar opens the viewer inventory, where each viewer shows its installed machines and the agents
that depend on it. Dependency names come from the machines' catalogs, including community packages;
an older daemon may not report that information yet.

## Stewardship of packages built on other people's work

Some first-party packages wrap a project Autonomous did not write: Marp (Yuki Hattori and the Marp
team), text-to-cad and the CAD Viewer (Jake Fitzgerald). Each carries the upstream licence and a
`THIRD_PARTY_NOTICES.md`, changes nothing upstream, names the author on its tile (`author` in the
manifest), and says in its README that Autonomous wrote the wrapper on the project's behalf to
bootstrap the catalogue. The ideal end state is that maintainers own their own Harness package: any
upstream maintainer can ask, on this repository's issues, to have the wrapper's folder moved into a
repository of theirs and the registry entry pointed at it. Until then bugs in the project go upstream
and bugs in the wrapper come here.

Other Autonomous projects are upstreams too. Autonomous Circuit and Autonomous Workshop live in their
teams' own repositories; their store packages are wrappers that fetch them read-only at a pinned
commit and change nothing there, exactly as the MuJoCo package fetches Menagerie.
