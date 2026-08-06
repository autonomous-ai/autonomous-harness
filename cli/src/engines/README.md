# Adding an agent framework to Harness

**This is the CLI path.** Your agent runs on the user's own computer and Harness reads the transcript
it writes; the code calls that an **engine**, and this directory holds one folder per engine. If your
agent runs on *your* servers instead, you want the API path — [`provider/`](../../../provider/README.md).

If you maintain an agent CLI — or you want Harness to drive one it does not support yet — this page
is the whole job, in the order it has to be done.

**What you are building.** Harness does not wrap your agent. Your agent keeps running as the user's
own process, in their own tmux pane, with their own credentials. Harness *watches the transcript your
agent already writes* and turns it into a live event stream: turns, tool calls, todo lists,
sub-agents, questions, completion. An engine is the translator between your agent's transcript and
that stream.

**Set expectations before you start.** This is not a plugin API. There is no registry to append to
and no interface to implement in one file. The codebase branches on `session.engine` in about twenty
shared files, and a new engine touches most of them. That is a real cost and we are not going to
pretend otherwise — but it is a *known* list, not a search, and this page is that list in dependency
order. The most recent engine, Muse Code, was added in a single commit (`b6c58e6`); read it
alongside this page and you will see every item below in context.

---

## The one rule

**Every field name, event kind and tool name you write must be read off a real recorded session from
the real binary. Never inferred from another engine, never hand-written.**

This is not style advice. When Muse was added, the names it uses matched no other engine, and
reasoning by analogy would have produced four failures that are all *silent* — the code runs, the
tests pass, and the product is quietly wrong:

- an empty todo checklist,
- no sub-agent row,
- a question card rendered into the tool feed instead of as a question,
- a missing model picker.

One of them was worse than cosmetic. Muse ends a turn with children nobody waited on — 7 spawns
against 4 waits in a single observed session — and an unclosed sub-agent row **holds `turn_ended`**.
That pinned the device tile on "Processing" every 5 seconds forever and meant no recap was ever
produced. No amount of invented fixture data would have surfaced that; one real session did.

The same lesson is already written into `CONTRIBUTING.md` for the example provider: two real bugs
were invisible to hand-written fixtures and obvious the moment a recorded turn was replayed. Record
first. Everything else follows from the recording.

---

## Before you open a PR

Open an issue first with:

1. **The agent's name** and where its CLI lives.
2. **Where it writes its transcript** — the exact path pattern, e.g.
   `sessions/YYYY/MM/DD/<uuid>/session.jsonl`.
3. **Whether it can call a hook on session start.** This is the single biggest fork in the work —
   see Stage B.
4. **One recorded session**, lightly redacted, that includes at minimum: a turn, a tool call, and a
   completion. If the agent has sub-agents or asks the user questions, include those too.

That issue is enough for us to tell you which of the stages below you actually need. Several are
optional, and which ones depend entirely on what your agent can do.

---

## Stage A — make the engine exist

Mechanical. Three files, no judgment required.

| File | What to add |
|---|---|
| `engines/types.ts` | Your name in the `AgentEngine` union. This is the source of truth; TypeScript will now tell you most of the remaining work |
| `lib/engineBin.ts` | The binary name, the `<ENGINE>_PATH` env override, and what to print as `harness <cmd>`. Add aliases if your CLI has more than one spelling — a user reaching for the name they know should not get "unknown command" |
| `config/env.ts` | `<ENGINE>_HOME` and `<ENGINE>_CONFIG_DIR` defaults, so a user with a non-standard install can point Harness at it |

After Stage A, run `npm run typecheck`. The errors it prints are a good first map of Stages B–E.

## Stage B — let Harness find the sessions

**Everything about this stage depends on one question: can your agent call a hook when a session
starts?**

**If it can** — add your engine name to the validator in `cli/hook/notify.mjs`. Harness learns about
the session the moment it opens. This is the easy path.

**If it cannot** — Harness has to scan for sessions, and you need two more things: a `reader.ts` in
your engine folder that walks the session tree, and a case in `lib/sessionRepair.ts` that binds a
tmux pane to a session by scanning. Muse is the worked example, and its comment is worth quoting
because it is the trap: *"Muse's hooks never fire, so this scan is the ONLY way a muse pane is ever
bound."* Note that being listed in `notify.mjs` does not mean hooks work — Muse is listed there
purely as a valid engine string.

Scanning also has to solve **which project a session belongs to**, and the answer is usually not in
the path. For Muse, nothing in `sessions/YYYY/MM/DD/<uuid>/session.jsonl` names the project;
`workspace_root` in the first record is the only link.

Either way, two more files:

| File | What to add |
|---|---|
| `lib/registry.ts` | Where your transcripts live, and your name in the two `engine === …` accept-lists so the wire protocol will carry it |
| `lib/tmux.ts` | How to recognise your process in a pane, and your resume flags so a session id can be recovered from the command line |

`lib/tmux.ts` deserves care. If your launcher `exec`s a differently-named real binary, the pane
process is not the name the user typed — Muse's pane shows `muse-bin-<version>`, and matching only
the bare name silently finds nothing.

## Stage C — read the transcript

**This is the actual work, and the only part that is universal.** Nine engines ship today; Claude
Code is the default and has no folder here, and every one of the other eight has exactly two files in
common — nothing else in this directory is shared by all of them:

```
engines/<name>/normalizer.ts        transcript line  →  LiveEvent[]
engines/<name>/normalizer.spec.ts   replayed against a recorded session
lib/__fixtures__/<name>-session.jsonl   the recording itself
```

The contract is in `engines/types.ts` and it is small:

```ts
export interface EngineNormalizer {
  ingest(line: string): LiveEvent[]   // one transcript line in, zero or more events out
  finishReplay(): LiveEvent[]         // flush anything still open at end of replay
  readonly turnOpen: boolean          // is a turn in flight right now
}
```

What the product needs you to emit, in rough order of how much it matters:

- **turn start and turn end.** Everything downstream keys off these. A turn that never ends pins the
  device on "Processing" and suppresses the recap.
- **text and thinking deltas** — what streams into the web chat.
- **tool start and tool end**, with the tool name and its main argument.
- **todo lists**, if your agent has them.
- **sub-agent spawn and completion**, if it has those.
- **completion, cancellation and error.**

Sub-agents are where engines differ most, and where reading beats guessing. In Muse, the child id
comes back in the *result* of `subagent_spawn`, not in its arguments; a spawn can be rejected
outright with `command_id_reused` and that child never runs, so its row has to close right there;
`subagent_wait` returning `status: "ready"` is the completion signal; and `subagent_read_result` is
never called at all. None of that is guessable from the tool names.

**Write the spec against the recording, not against your reading of the docs.** If your agent's
behaviour changes, we want a new recording, not an edited fixture.

## Stage D — drive the agent

Only needed for the capabilities your agent actually has. Skip what does not apply.

| File | What to add |
|---|---|
| `lib/launch.ts` | How to start it, and any environment that must be pinned. Muse forks a background self-update on every invocation that can replace the binary mid-session, so `MUSE_NO_AUTO_UPDATE=1` is set — **an agent must not change under the person using it** |
| `lib/sessionInput.ts` | How text is submitted, and how long to wait before deciding the submit failed. Muse writes its `started` record as soon as it accepts a prompt, so 6 seconds is enough; a slower agent needs a longer window |
| `lib/enginePermissions.ts` | The flag that turns off approval prompts, plus the finer flags you *own*. Listing owned flags is what lets a user who passes one of them keep their choice instead of getting ours on top |
| `lib/sessionRepair.ts` | Rebinding a pane to its session after a restart |
| `lib/oneshot.ts` | Running a single prompt outside an interactive session |

## Stage E — the product surfaces

Each of these is independently optional. Ship without them and the feature is simply absent rather
than broken — which is the right failure mode, and why they are last.

| File | Gives the user |
|---|---|
| `engines/<name>/runtimeProfile.ts` + `lib/runtimeProfile.ts` | The model and effort pickers |
| `engines/<name>/askQuestion.ts` + `lib/askQuestion.ts` + `lib/__fixtures__/question-<name>.txt` | Your agent's questions as answerable cards on the device and the web, instead of text in the tool feed |
| `lib/summarize.ts` | The end-of-turn recap. Note the pooling rule: agents that take their recap prompt as argv rather than stdin cannot be pre-warmed, so they opt out of the worker pool |
| `lib/goalCommand.ts` | `/goal` and `/loop` support |
| `cli.ts` | Wire the normalizer into the watcher — the last connection that makes it live |
| `backendSocket.ts` | Your name in the wire-protocol accept-lists |

---

## Verify

```bash
cd cli
npm install
npm run typecheck
npm test
```

Then the part no test suite can do for you: **run your agent for real**, through a full turn, and
watch it in the web UI. Confirm the tile goes `processing → done → summary`. That specific sequence
is the one that catches an unclosed row, and it is how the Muse bug above was found.

## The pull request

Open it against `main` with:

- [ ] The recorded session fixture, and specs that replay it
- [ ] `npm run typecheck` and `npm test` green
- [ ] A note saying which stages you implemented and which you deliberately skipped
- [ ] **Evidence of one real end-to-end turn** — the tile going processing → done → summary
- [ ] Anything you learned that contradicts what you would have assumed, called out in the commit
  message

That last item is the one we value most. The Muse commit is the model: it records exactly which four
things analogy would have got wrong, and why. Someone adding the tenth engine will read it.

## Getting help

- **The engine's transcript format is undocumented and you are reverse-engineering it** — that is
  normal. Open an issue with a recording and we will read it with you.
- **A stage in this page does not match the code** — that is a bug in this page. Say so; it is the
  most useful report we get.
- Security issues: **not the issue tracker** — see [`SECURITY.md`](../../../SECURITY.md).
