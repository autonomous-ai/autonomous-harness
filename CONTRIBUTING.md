# Contributing

Two kinds of contribution land here, and they have different bars.

**The CLI** is the code path — a new agent framework, or a second terminal multiplexer — and it is
welcome. What to run and what the bar is: [The CLI](#the-cli-cli--engines-and-multiplexers) below.
Open an issue first; for an engine, bring a recorded session from the real binary, because that
recording decides most of the design and is the difference between an engine that works and one that
fails silently.

**Everything about the provider spec** is after that, where the most useful contributions are usually
not code at all.

## How a change lands

1. **Open an issue first.** For an engine, attach the recorded session; for a multiplexer, answer the
   pane-identity question below before writing code. Both save you from building the wrong shape.
2. **Fork, then branch.** Work on a branch in your fork — nobody pushes to `main` directly.

   ```bash
   gh repo fork autonomous-ai/autonomous-harness --clone   # or fork on the web, then clone your fork
   cd autonomous-harness
   git remote add upstream https://github.com/autonomous-ai/autonomous-harness.git
   git checkout -b herdr-support
   ```

3. **Run the checks for whichever package you touched** (see the two sections below) and keep the
   change to one package where you can. Then push and open the request:

   ```bash
   git push -u origin herdr-support
   gh pr create --base main            # or open it from the web UI
   ```

   To pick up changes from `main` while your branch is open, **rebase — do not merge**:

   ```bash
   git fetch upstream && git rebase upstream/main
   ```

   A merge commit in the branch is not fatal (the squash flattens it anyway), but rebasing keeps the
   diff readable, which is the whole review.
4. **Open a pull request against `main`,** and say in the description **which checks you ran and what
   you ran them against** — "`npm test` plus `test:tmux-real` on tmux 3.5a, macOS" is worth more than
   a green checkbox.

   That last part is not politeness: **there is no CI on pull requests yet.** Nothing runs
   automatically when you push, so what you report is what a reviewer starts from.
5. **Review is manual, and hands-on.** A maintainer pulls the branch and runs the suites locally. For
   an engine or a multiplexer that also means installing the real software, so tell us exactly what to
   install and how you exercised it — a change nobody can reproduce cannot be merged, however good it
   looks.
6. **Merges are squashed.** The history here is linear on purpose; write the commit message for
   someone reading `git log` in a year, not for the diff.
7. **Merging is not shipping.** The CLI self-distributes, so a change reaches users on the next
   release, which a maintainer cuts. Expect a gap between "merged" and "my machine has it".

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

Harness drives agents inside tmux and Herdr 0.8.x protocol 19. Another multiplexer is welcome, on one
condition: it is **added alongside tmux, not swapped in for it.** Existing registries contain tmux
pane identity, so replacing the multiplexer orphans running agents on upgrade. tmux stays the default,
yours becomes another implementation behind the same interface instead of another rewrite.

Three things decide how much work this is, and the first one is not in this repository at all:

1. **Can a process running inside a pane tell which pane it is in?** tmux exports `$TMUX_PANE`; Herdr
   exports its pane, session, and socket context. The shell hooks in `cli/hook/notify.mjs` and the
   in-process plugins and extensions generated in `cli/src/lib/hooks.ts` read typed hints and stay
   deliberately inert without a verifiable configured runtime. If your multiplexer exports no
   per-pane identifier into the child environment, no abstraction on our side can rescue discovery.
   **Check this before writing anything else.**
2. **Pane ids are validated and namespaced.** Identity must include the backend instance so public
   pane ids from two multiplexers or configured endpoints cannot collide.
3. **The recap workers scrub every backend's location variables.** `cli/src/lib/oneshot.ts` removes
   them before spawning an ephemeral summary run, so that run cannot register itself as an agent.
   Miss the equivalent for yours and every recap spawns a phantom agent — silent, and thoroughly
   unpleasant to trace.

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
explicitly out of scope is a **gap**, not an implicit "no" — Appendix C of `spec/README.md` is the
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
`reference-provider/src/conformance.ts` — or an explicit SKIP saying why it cannot be verified from
outside. Silence is not an option; that rule is the reason the suite is trustworthy.

## Provider code (`provider/`)

```bash
cd reference-provider && npm install && npm run typecheck && npm test
```

Both packages have **no runtime dependencies** and that is a constraint, not an accident: a partner
should be able to read the reference implementation end to end without installing anything to
understand it. A pull request that adds one needs to argue for it.

`example-provider` needs a real `claude` CLI and a live model, so CI runs its typecheck and unit
tests only — never its end-to-end path. Its unit tests replay a **recorded** turn; do not replace
those fixtures with hand-written JSON. Two real bugs in that mapper were invisible to invented
fixtures and obvious the moment a real turn was replayed.
