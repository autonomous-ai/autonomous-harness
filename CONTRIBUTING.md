# Contributing to OpenHarness

Welcome! OpenHarness grows when someone shares a new capability. A harness for a tool you love,
a better example, a small fix, or a clearer sentence can be your first contribution.

**Start with a harness.** You can build one without changing the app, writing a provider, or
learning the platform internals. Keep it in your own repository or contribute it here. Both are
first-class ways to participate, and both use the same package format.

[Your first harness](#your-first-harness) · [Share it](#share-your-harness) ·
[Other contributions](#other-ways-to-contribute) · [Pull requests](#how-a-change-lands)

## Your first harness

You'll need the OpenHarness app and `harness` CLI. This example uses an installed, configured
Codex engine; the package checks themselves do not need a model or account.

### 1. Copy Hello World

From a checkout of this repository:

```bash
harness dsh install "$PWD/store/viewers/web-viewer" --link
cp -R store/examples/hello-world ../my-first-harness
cd ../my-first-harness
```

The first command links the shared viewer from this checkout. Store installations normally install
that dependency automatically; this also lets you try a new viewer before it reaches a release.

**Agent + viewer = harness.** This example has three working files:

- [`harness.json`](store/examples/hello-world/harness.json) declares the agent and its viewer.
- [`AGENTS.md`](store/examples/hello-world/AGENTS.md) teaches the agent to change the greeting.
- [`template/index.html`](store/examples/hello-world/template/index.html) is copied into the new project.

```json
{
  "spec": 1,
  "id": "examples/hello-world",
  "name": "Hello World",
  "description": "Your first OpenHarness package: make a greeting in a live HTML preview.",
  "category": "Example",
  "author": "OpenHarness contributors",
  "engine": "codex",
  "workspace": {
    "template": "template",
    "marker": "index.html"
  },
  "agent": {
    "instructions": "AGENTS.md"
  },
  "viewer": {
    "use": "autonomous/web-viewer"
  }
}
```

`viewer.use` links to the shared **Web Viewer**. OpenHarness runs it beside the agent and reuses an
existing installation. You write ordinary HTML; no viewer implementation, SDK, or build step is
needed. The preview reloads when the agent saves the page.

### 2. Check it and try it

```bash
harness dsh check .
harness dsh install "$PWD" --link
```

The check should end with `examples/hello-world conforms to spec 1`. Warnings about optional
skills and a doctor command are expected in this minimal example. It validates the package;
it does not ask a model to perform the task.

In the app, press **⌘N**, choose **Hello World** (look under **More** if needed), and use a new
project on the machine where you installed it. Ask:

> Say hello to Ada.

The agent should change `index.html` to say `Hello, Ada!`. Watch it update in the viewer beside
the terminal. You have now run an agent and a viewer together as your own harness.

`--link` keeps the installed package connected to your checkout. Edit the instructions and start
a fresh session in a new project to try them; instructions already copied into an existing
project are preserved. You can remove this example with `harness dsh remove examples/hello-world`;
your source folder and projects remain.

### 3. Make it yours

Change `id` to `your-handle/your-harness`, give it a useful `name` and `description`, and put your
name in `author`. Use lowercase letters, digits, and dashes in the two parts of the ID. Remove
the old linked installation before changing the ID, then check and install the new one.

Teach one concrete workflow in `AGENTS.md`: what someone asks for, what the agent produces, and
how it checks the result. For example, turn meeting notes into a decision log or teach a CLI
CAD tool to build a printable part. You can use `claude` instead of `codex` if that better fits
your workflow; install and configure that engine, then test it too.

Add only what your harness needs:

| When you need… | Add… |
|---|---|
| Reusable techniques or commands | `skills/<name>/SKILL.md` |
| Starting files for a project | `workspace.template` and a marker file |
| Extra software | `toolchain.setup` and a `toolchain.doctor` readiness check |
| A visible result beside the terminal | An existing `viewer.use` dependency, or your own viewer |
| Progress and validation in the pane | A check that writes `.harness/verdict.json` |

The [full starter](store/starter/) demonstrates skills, a template, and setup hooks. The
[Store guide](store/README.md#build-one) explains these optional pieces. For a complete visual
example, see [Marp](store/agents/marp/) or [Blender](store/agents/blender/).

## Share your harness

You do not need permission to build a harness or share its repository. Choose the route that fits:

- **Your own repository:** publish the package with a README and license. Anyone can install it
  with `harness dsh install https://github.com/YOUR-HANDLE/YOUR-HARNESS`. To list it in the Store,
  submit a small entry at `store/registry/<owner>/<name>.json`. You keep the code and its maintenance.
- **This repository:** contribute a folder at `store/agents/<name>/` with a `harness.json` and
  `store.json`. Built-in package IDs use `autonomous/<name>`; the `author` field credits the actual
  author or upstream project. The CLI build generates the listing from those files.

The [publishing examples](store/README.md#publish-a-harness) show the exact metadata for both routes.
A Store listing reaches users with a CLI release after it is merged.

For a first pull request, give reviewers a short path to the same result you saw:

- What can someone make with it? Include one copyable prompt and its output or a screenshot.
- Which engine, operating system, and tool versions did you try?
- Does `harness dsh check` pass? If there are setup or doctor commands, show a clean install too.
- Credit upstream authors, include the appropriate license, and state required accounts or paid tools.

One useful, tested workflow is a good first contribution. An issue is optional for a new harness;
open one if you want feedback or help choosing an approach. AI-assisted contributions are welcome:
read what you submit and run the example yourself.

## Other ways to contribute

| You want to… | Start here |
|---|---|
| Improve an existing harness | Its folder in [store/agents](store/agents/) and its own README |
| Share a viewer other harnesses can reuse | [Store guide](store/README.md), [viewer packages](store/viewers/) |
| Add a coding engine | [Engine integration guide](cli/src/engines/README.md) |
| Add an API provider | [Provider guide](provider/README.md) |
| Improve terminal behavior, shortcuts, or accessibility | [Development guide](docs/development.md), [keyboard guide](docs/keyboard.md) |
| Help with Linux or Windows compatibility | [Development guide](docs/development.md#platform-support) |
| Support another hardware board | [Firmware guide](device/harness/README.md) |
| Fix documentation or report a bug | A small PR, or an issue with steps to reproduce |

For a new engine, multiplexer, or a change to a shared protocol, open an issue first so we can agree
on the interface. A new harness using an existing engine does not need that platform work.
Security reports go through [SECURITY.md](SECURITY.md).

## How a change lands

1. **Fork and branch.** Fork this repository on GitHub, clone your fork, and create a branch such
   as `add-my-harness`. Open a pull request against `main` when it is ready; a draft is welcome if
   you need help. No separate issue is required for a small fix or documentation change.
2. **Run the checks relevant to your change.** A harness contribution starts with its package
   check and a real example. Platform changes use the package checks below and in the
   [development guide](docs/development.md). Say exactly what ran and what did not.
3. **Make it reproducible.** Use the PR template to describe the result, how to try it, and the
   validation. Remove credentials and private project content from logs and recordings.
4. **Review together.** A maintainer checks the change and may ask you to refine it. CI is
   currently run manually through **Actions → CI → Run workflow**; a PR does not automatically
   exercise the app, real engines, or hardware. Report those checks separately.
5. **Merge and release.** PRs are squash-merged. Rebase on the latest `main` when needed to keep
   the diff readable. Merging and publishing are separate: app, CLI, and firmware releases have
   their own schedules.

## Conventions across this repository

- **Specs are numbered.** Every normative statement has a stable id, so a failure can point at a
  clause rather than a symptom, and a conformance runner can assert one check per id.
- **Specs are compatibility contracts.** Optional fields may be added; nothing published is renamed,
  removed, retyped or reinterpreted without a new revision served alongside the old one.
- **Reference implementations carry no runtime dependencies.** You should be able to read one end to
  end and know what your own implementation has to do, without installing anything to understand it.

## The CLI (`cli/`) — engines and multiplexers

```bash
cd cli && npm install && npm run typecheck && npm test
```

That is the bar for every pull request that touches `cli/`. Two further suites exist and are
**opt-in**, because they need software the machine may not have — they skip themselves rather than
fail, which is also why forgetting them is easy:

```bash
npm run test:tmux-real     # RUN_REAL_TMUX_DISCOVERY=1 — drives a real tmux server
npm run test:herdr-real    # RUN_REAL_HERDR=1 — drives isolated Herdr sessions/workspaces
npm run test:cursor-e2e    # RUN_CURSOR_E2E=1 — needs a real cursor-agent CLI
```

If your change touches how agents are discovered or driven, run both real multiplexer suites for the
software available on your machine and say exactly which versions and engine rows ran. A missing
binary, credential, or onboarding step is an unavailable row, not a passing one.

### Adding an engine

[`cli/src/engines/README.md`](cli/src/engines/README.md) is the whole job in dependency order. The
rule that matters more than the rest: **every tool name, field name and event name must be read off a
real recorded session from the real binary.** Names inferred by analogy from another engine have
failed silently three times — an empty checklist, a missing sub-agent row, a question card rendered
into the tool feed — and each one passed its unit tests first.

### Adding a multiplexer

Harness drives agents inside tmux and Herdr 0.8.x protocol 19, watching both by default with nothing to
configure. Another multiplexer is welcome, on one condition: it is **added alongside them, not swapped
in.** Existing registries contain tmux pane identity, so replacing the multiplexer orphans running
agents on upgrade. Yours becomes another implementation behind the same interface instead of another
rewrite.

Four things decide how much work this is, and the first one is not in this repository at all:

1. **Can a process running inside a pane tell which pane it is in — and with which of the values your
   tool actually exports?** tmux exports `$TMUX_PANE`; Herdr exports `HERDR_PANE_ID`,
   `HERDR_SOCKET_PATH`, `HERDR_ENV`, `HERDR_TAB_ID` and `HERDR_WORKSPACE_ID`. Read that list off a real
   pane before you rely on any of it. Herdr 0.8.0 exports **no session name**, and matching endpoints by
   name — a reasonable-looking assumption — silently rejected every hook it ever sent: no session bound,
   resumed conversations opened blank, and turns typed in a pane produced no events at all. Identify the
   endpoint by something the tool really puts in the environment, accept more than one form of it, and
   treat a hint that identifies nothing as matching nothing. The shell hooks in `cli/hook/notify.mjs`
   and the in-process plugins and extensions generated in `cli/src/lib/hooks.ts` read typed hints and
   stay deliberately inert without a verifiable runtime. If your multiplexer exports no per-pane
   identifier into the child environment, no abstraction on our side can rescue discovery.
   **Check this before writing anything else.**
2. **Pane ids are validated and namespaced.** Identity must include the backend instance so public
   pane ids from two multiplexers or configured endpoints cannot collide.
3. **The recap workers scrub every backend's location variables.** `cli/src/lib/oneshot.ts` removes
   them before spawning an ephemeral summary run, so that run cannot register itself as an agent.
   Miss the equivalent for yours and every recap spawns a phantom agent — silent, and thoroughly
   unpleasant to trace.
4. **Detection has to be free when your tool is absent.** Backends are auto-detected before every five
   second reconcile, so presence is decided by a `PATH` walk (`herdrBinaryAvailable` in
   `cli/src/lib/herdrSessions.ts`) and nothing is spawned until that succeeds. An installed-but-broken
   version must degrade to "nothing to adopt", never to a startup failure: only an operator who named
   the backend explicitly gets an error, because only they asked for it.

The command surface itself is small: list panes with their pid and working directory, send literal
text and logical keys, capture the pane, display a message, and create and kill sessions/workspaces.
Lifecycle methods are explicit backend capabilities for callers that request them; normal Harness
startup does not create user sessions, and deleting an agent does not close its pane. Note that
reading the conversation does **not** go through the multiplexer — each engine tails its own store on
disk — so the scope is narrower than it first looks. What decides the difficulty is how well your
multiplexer answers "read this pane" and "send keys to this pane", because that is what the question
dialogs and the model pickers are driven with.

## Found a gap in the spec?

Say so. The profile is written against one product's needs, and the first partners to implement it
will find things it does not answer. An operation that is neither Tier 0, nor a named extension, nor
explicitly out of scope is a **gap**, not an implicit "no" — Appendix C of [`provider/spec/README.md`](provider/spec/README.md) is the
audit that is supposed to catch those, and it is not infallible.

Open an issue quoting the clause id (`HP-xxx`), or the absence of one.

## Found a clause the runner cannot actually check?

Even more useful. A conformance suite that reports PASS for something it never tested is worse than
one that admits it cannot. If a check is green for the wrong reason, that is a bug in the runner.

## Changing the spec

It is a compatibility contract, and the rules in §12 are binding:

- Optional fields **may** be added to a published revision.
- A published field **must not** be renamed, removed, retyped, or reinterpreted.
- Anything else needs a new revision, served alongside its predecessor for a deprecation window.

Every normative statement gets a stable `HP-xxx` id, and a new one needs a matching check in
`provider/reference-provider/src/conformance.ts` — or an explicit SKIP saying why it cannot be verified from
outside. Silence is not an option; that rule is the reason the suite is trustworthy.

## Provider code (`provider/`)

```bash
cd provider/reference-provider && npm ci && npm run typecheck && npm test
```

Both packages have **no runtime dependencies** and that is a constraint, not an accident: a partner
should be able to read the reference implementation end to end without installing anything to
understand it. A pull request that adds one needs to argue for it.

`example-provider` needs a real `claude` CLI and a live model, so CI runs its typecheck and unit
tests only — never its end-to-end path. Its unit tests replay a **recorded** turn; do not replace
those fixtures with hand-written JSON. Two real bugs in that mapper were invisible to invented
fixtures and obvious the moment a real turn was replayed.
