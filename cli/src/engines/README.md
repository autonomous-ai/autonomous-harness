# Adding an agent framework to Harness

**This is the CLI path.** Your agent is a command — run on a laptop, a server, a cloud VM, anywhere
`harness join` runs — and Harness reads the transcript it writes. The code calls that an **engine**,
and this directory holds one folder per engine. If your agent is a service reached over HTTP instead,
you want the API path — [`provider/`](../../../provider/README.md).

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
order. Two engines were each added in a single commit — Muse Code (`b6c58e6`) and Amp (`f15924f`) —
and reading either alongside this page shows every item below in context. Read Amp's if your agent
does not write a transcript at all; see "When your agent writes nothing to disk".

**Launchers are not engines.** A wrapper that configures an environment and then hands the pane to a
vendor CLI — `ori claude`, an `env`-prefixed alias, a shell function — produces an agent of the
*wrapped* engine, with that engine's name, icon and normalizer. Discovery reads through the wrapper
(and most wrappers, ori included, `exec` themselves away entirely), so there is nothing to add here
for one. What a gateway launcher does change is billing: see `lib/gatewayRuntime.ts`, which marks such
a session display-only for model/effort and routes the daemon's own recap through the gateway.

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

The rule also forbids concluding that something is *absent*. Amp's `--help` once appeared to show no
permission bypass, while the binary strings exposed one. Harness no longer launches interactive agent
processes or supplies permission flags, so the user's normal CLI configuration owns that behavior; the
recording still matters because refused tools change the transcript and turn boundary. Grep the binary
before you write "this agent has no X".

The same lesson is already written into `CONTRIBUTING.md` for the example provider: two real bugs
were invisible to hand-written fixtures and obvious the moment a recorded turn was replayed. Record
first. Everything else follows from the recording.

---

## When your agent is a FORK of one already here

Kilo is opencode's fork: same commands, same `~/.local/share/<name>/<name>.db`, same
`{type:'text'|'reasoning'|'step-start'|'step-finish'}` parts, and its own log lines still say
`opencode`. That looks like the cheapest integration possible, and mostly it is — but it is also the
one where the one rule above is easiest to skip, because everything *seems* already known.

Copy the module, then re-measure it. `engines/kilo/` is a deliberate duplicate of `engines/opencode/`
rather than a shared abstraction: the forks are free to drift, and the duplication is where that drift
is allowed to land. Every place the two already differ was found by measuring, and every one of them
fails silently if inherited unchanged:

- **The model-catalog regex.** Opencode's character class has neither `~` nor `:`. On kilo's real
  catalog that silently dropped 23 of 299 ids — every floating `~vendor/model-latest` alias and every
  `:free` / `:discounted` variant — including the model the live session was actually running. The
  picker would simply not have listed the user's own model.
- **The pane footer.** Opencode's resolver anchors on its `Build`/`Plan` agent names. Kilo's agent is
  `code`, so the inherited function matched nothing and returned null forever: a blank model chip, no
  error anywhere. It had to be rewritten, not renamed.
- **The permission behavior.** Kilo's interactive TUI and its non-interactive `run` subcommand do not
  accept the same flags. Harness never adds a flag to the user's TUI process, but its private recap
  worker uses `run`; keep those two paths separate and measure each on the real binary.
- **The ask-the-user dialog.** Opencode draws Claude's numbered dialog inside a box. Kilo draws an
  unnumbered row of options laid out *horizontally*, sharing its line with the key hints, and walked
  with `Right` rather than `Down`. Same product lineage, completely different parser.
- **The turn boundary.** Kilo ends a refused turn with no `step-finish reason:'stop'` at all. Read
  only by opencode's stop rule, that turn never closes: the device tile spins forever and no recap
  runs. The refusal itself had to become a boundary.

Two of those (the catalog and the footer) would have shipped as "working" under any test written from
the parent engine's fixtures. So: inherit the *structure*, measure the *values*. And where a fork's
directory layout matches, check the ENV OVERRIDES separately — kilo honours `XDG_DATA_HOME` and
ignores the `<ENGINE>_DATA_DIR` variable its parent uses, which is the difference between a recap
running in a scratch directory and a recap writing into the user's real store.

---

## When your agent writes nothing to disk

This page assumes Harness can read a transcript your agent already writes. Amp is the case where
that is false: its threads live on its own server, and the only local artefacts are a `session.json`
and a debug log that records block *counts* and frame *lengths* with no message text at all. Its
`threads export` command can fetch a conversation, but it is a network round trip of over a second
and it never shows a message before that message is finished — so it cannot back a live stream.

If that describes your agent, do not write a poller against your own API. Check whether you expose a
plugin or extension API, and have Harness's plugin **write** the transcript it then tails. Amp does
exactly this: `installAmpPlugin` in `lib/hooks.ts` drops a plugin that appends JSONL from five
lifecycle events, and from there Amp is an ordinary file-backed engine on every path in this
document. The OpenCode plugin and the Pi extension are the same idea used only for discovery.

Three things that pattern gets wrong if nobody warns you, all found by running it:

- **A plugin's working directory is the plugin's own.** Amp's reported `<project>/.amp/plugins`, not
  the agent's directory. The `cwd` recorded in the transcript is what re-binds a session after a
  daemon restart, so a wrong one means an agent that can never be found again. Read the real directory
  from the plugin's host context or the discovered pane metadata.
- **Your events may not carry assistant text.** None of Amp's five do. The text has to be read from
  the thread handle the plugin already holds — and because that handle already contains the
  in-flight message when a tool is called, snapshotting there emits a message's prose *before* the
  tool it called, which is the order a transcript needs. Deduplicate by message id plus block index.
- **A start event can simply not fire.** A prompt submitted while Amp is still connecting is queued,
  and the queued message is dispatched with no `agent.start` at all — the recorded transcript went
  straight to thinking and ended with a turn end whose id matched no start. The normalizer opens a
  turn on the first content record, or that entire turn is invisible and its end is dropped.

---

## When hooks and transcript events disagree about ordering

Grok Build supplies both global hooks and an ACP-style `updates.jsonl`, but they do different jobs.
Use the hook to discover and register the session; use the transcript as the authoritative turn stream.
The real Grok recording exposed five details that are easy to get wrong by copying Claude's hook path:

- Grok hook payload fields use camelCase (`hookEventName`, `sessionId`, `workspaceRoot`), while the event
  values themselves are lowercase snake case (`session_start`, `user_prompt_submit`, `stop_failure`). The
  shared notifier originally expected Claude's fields and canonical event values; normalise both axes.
- A normal `Stop` hook was persisted before the final `agent_message_chunk` and `turn_completed` records.
  Closing on that hook drops the actual answer, so Grok closes a normal turn only on `turn_completed`;
  `StopFailure` remains a hook backstop for failed turns.
- `spawn_subagent` is reported as a `Task`, and that tool result means only that the background task was
  accepted. Its row stays open until the separate `subagent_finished` update arrives.
- The planning tool is `todo_write`, not another engine's similarly named tool. It maps to `TodoWrite`
  so `input.todos[].content` reaches the device checklist.
- Session directories usually encode the cwd as one URL component. Long paths live under a hash instead,
  with the original cwd in `.cwd`; discovery and restart repair must handle both layouts.
- Grok creates no session when the TUI merely opens. The first prompt creates it and fires the hooks, so
  a remote first prompt must be injected into the discovered process pane before a session id exists. Holding it
  until registration deadlocks on the very `UserPromptSubmit` event that registration needs.

The recorded envelope is `{timestamp, method, params:{sessionId, update, _meta}}`. Keep its fixture as a
real recording: a hand-written sequence would not reveal the Stop-before-final-message ordering above.

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
| `lib/engineBin.ts` | The canonical vendor command, the `<ENGINE>_PATH` env override, and the ordered discovery list. Harness observes this command in tmux; it never dispatches `harness <engine>` |
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

**If it cannot hook but it can plug in** — a plugin beats a scan, because it runs inside your agent
and can see both `$TMUX_PANE` and the session id, so it registers instead of being guessed at. The
OpenCode plugin, the Pi extension and the Amp plugin all do this from `lib/hooks.ts`; none of the
three needs an entry in `notify.mjs`, which is only for the shell-hook engines.

Scanning is also not always possible by DIRECTORY. agy records no cwd in its transcript, names its
folder by the conversation id, and keeps a `conversation_summaries.db` that looks like the index for
exactly this and holds only IDE rows, never CLI ones. What it does leave is
`presence/<conversationId>.lock`, held open by the live process — a pid→conversation map and a liveness
test in one. `findLiveSession` takes an optional `pid` for that case (`lsof` on macOS,
`/proc/<pid>/fd` on Linux). Look for a lock, a socket, or an open descriptor before concluding a
directory scan is impossible.

Scanning also has to solve **which project a session belongs to**, and the answer is usually not in
the path. For Muse, nothing in `sessions/YYYY/MM/DD/<uuid>/session.jsonl` names the project;
`workspace_root` in the first record is the only link. Where the plugin writes the transcript itself
this is free — Amp's plugin puts `cwd` on the first line precisely so the ordinary scan works.

**A hook can also break the agent, so install only the events you need.** agy's `PreToolUse` contract
makes `decision` REQUIRED, and a handler that prints anything else — including the `{}` every other
hook here returns — is read as a DENIAL: measured on a real pane as "Tool call denied by pre-tool hook"
on every tool call of the turn. Harness installs only `PreInvocation` (announce) and `Stop` (turn
boundary) for agy. Read each event's output contract before adding it; tool events come off the
transcript anyway.

**And check whether the announce event repeats.** agy has no session-start event at all; the nearest
thing, `PreInvocation`, fires before EVERY model round-trip — four to seven times in one measured turn.
Registration is idempotent, but `handleRegistered` treats a `SessionStart` hook as a reason to re-fold
the transcript, so each repeat re-emitted `turn_started` for a turn already open (two `turn_started`,
one `turn_ended`). agy is excluded from that reset in `cli.ts`, the way cursor already was.

Worth knowing even if you do not need it: some agents already record which terminal opened which
session. Amp keys `lastThreadByTerminal` in its `session.json` by `tmux:<pane>@<server-pid>,<session>`,
an exact pane→thread map. Harness does not use it (the repair path is asked about a directory, not a
pane) but it is the kind of thing to look for before assuming a scan is the only option.

Either way, two more files:

| File | What to add |
|---|---|
| `lib/registry.ts` | Where your transcripts live, and your name in the two `engine === …` accept-lists so the wire protocol will carry it |
| `lib/tmux.ts` | How to recognise your process in a pane, and your resume flags so a session id can be recovered from the command line |

`lib/tmux.ts` deserves care. If the vendor command `exec`s a differently-named real binary, the pane
process is not the name the user typed — Muse's pane shows `muse-bin-<version>`, and matching only
the bare name silently finds nothing.

## Stage C — read the transcript

**This is the actual work, and the only part that is universal.** Claude Code is the default and has
no folder here; every other engine has exactly two files in common, and nothing else in this
directory is shared by all of them:

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

**Not every status word resolves.** agy writes a backgrounded step as `status: "RUNNING"` and, the file
being append-only, that line is never rewritten to `DONE`. Holding the turn open on it pins the device
tile on "Processing" for ever. The step still CLOSES its tool row — it is the call's result, it just
says the work continues elsewhere.

**If the transcript has no end-of-turn record at all, say where the answer actually lives.** agy's is
its `Stop` hook. That works while the daemon is running and fails on restart: folding a FINISHED
conversation reports the last turn as still open and nothing is ever coming to close it (measured:
`turn_heartbeat` every second, indefinitely). Its pane knows — `? for shortcuts` when idle,
`esc to cancel` while busy — so attach reads the pane once and closes the folded turn.

**A dialog you can read is not a dialog you can judge.** Copilot names the SUBJECT of a permission
prompt above the question, not in it: "Copilot is attempting to access the following URL:" over a
boxed value, then "Do you want to allow this access?" with a bare "Yes" as option 1. The shared parser
returns the question correctly and the device still gets a choice nobody can make — approving network
access without seeing the domain. Fold the subject into the question; leave the rows alone.

**And one silent run does not prove a prompt is absent.** Copilot gates on FOLDER trust first, so a
shell command in a trusted directory runs with no prompt at all — which reads exactly like "this
engine never asks". Its permission model is patterns (`shell(cmd)`, `write(path)`, `url(domain)`),
and it took a URL fetch to raise one. Find the condition that triggers the prompt before writing that
an engine has none.

**One process can change session underneath you.** Every engine here but Copilot starts a new process
to switch conversations, so `bindObservedAgent` stops at the first `agent.sessionId` and never looks
again. Copilot's `/resume` switches IN PROCESS: same pid, same pane, different conversation — and the
pane then shows something the daemon is not streaming.

Worse, the switch leaves almost no trace. Measured: resuming writes not one byte to `events.jsonl`
and fires no hook until the next prompt, so neither a transcript tail nor a directory scan can see it.
The one thing it does is take a lock, `session-state/<id>/inuse.<pid>.lock` — and it does NOT release
the old one, so a process holds several and the NEWEST is the current session.

When adding an engine, ask whether switching conversations requires a new process. If it does not, the
bind path needs a re-check for an already-bound agent, and something that identifies the CURRENT
session of a live pid.

**A fold is not a live stream, and `--resume` is where that bites.** Every engine here whose turn is
closed by a HOOK has the same hole: attaching to an existing conversation folds its transcript, the
fold opens a turn on the last user message, and no hook is coming to close it — the tile spins on a
conversation that finished hours ago. It has now shipped twice, on agy and on Copilot.

Whatever closes a turn LIVE, you also need an answer for "was the last exchange in this FILE
finished?", and the two are rarely the same source:

- agy's transcript records no end at all, so it asks the PANE (`? for shortcuts` idle vs
  `esc to cancel` busy) once at attach.
- Copilot's records `assistant.turn_end` — useless as a live boundary, since it marks a model
  round-trip and one exchange holds several, but its POSITION settles history exactly:
  open iff something started after the last one ended (`copilotHistoryTurnOpen`).

Test it by folding a fixture that ENDS, and asserting the fold and the answer disagree. A fixture that
stops mid-turn will pass a broken implementation.

**Two announce events for one turn is a thing that happens.** Copilot fires `userPromptSubmitted` and
then `sessionStart` (measured 2.5s apart, in that order — its sessionStart comes AFTER the first
prompt). Both register, registration is idempotent, and that is fine — but `handleRegistered` treats a
`SessionStart` hook as a reason to re-fold the transcript, so the second one re-emitted `turn_started`
for a turn already open. Copilot is excluded from that reset in `cli.ts`, next to cursor and agy.

**Read the hook's exit-code contract before installing an event, not just its payload.** Copilot's
docs are explicit that every hook fails OPEN except `preToolUse`, which fails CLOSED: a non-zero exit
denies the tool. A crashing hook would stop the user's agent from running anything. It is not
installed — the same rows are in the transcript anyway. (agy's version of this trap is worse: there
`{}` itself is a denial.)

## Stage D — drive the agent

Only needed for the capabilities your agent actually has. Skip what does not apply.

| File | What to add |
|---|---|
| `lib/sessionInput.ts` | How text is submitted, and how long to wait before deciding the submit failed. Muse writes its `started` record as soon as it accepts a prompt, so 6 seconds is enough; a slower agent needs a longer window |
| `lib/sessionRepair.ts` | Rebinding a pane to its session after a restart |
| `lib/oneshot.ts` | Running a single prompt outside an interactive session |

## Stage E — the product surfaces

Each of these is independently optional. Ship without them and the feature is simply absent rather
than broken — which is the right failure mode, and why they are last.

| File | Gives the user |
|---|---|
| `engines/<name>/runtimeProfile.ts` + `lib/runtimeProfile.ts` | The model and effort pickers. Some agents expose neither: Amp has no model list at all, only four agent *modes*, so the mode is reported as the model and the effort axis stays `auto`. Note the engine name also lives inside `PROFILE_RE` — miss it there and the picker vanishes with no error |
| `engines/<name>/askQuestion.ts` + `lib/askQuestion.ts` + `lib/__fixtures__/question-<name>.txt` | Your agent's questions as answerable cards on the device and the web, instead of text in the tool feed. It need not be a question *tool*: Amp has none, and the only thing it blocks a person on is its approval prompt — whose rows are unnumbered, so they are walked with `Down` and committed with `Enter` rather than by pressing a digit |
| `lib/__fixtures__/permission-<name>.txt` | The same card for your agent's **permission prompt**, which matters more than the question does — see below |

### Permission prompts

Harness does not launch your agent and supplies it no permission flags, so an approval prompt is the
pane's ordinary state, not an edge case. Left unparsed it is invisible: the turn sits at `Processing`
until someone walks to the computer. So an approval is modelled as a question whose options are the
approval choices, and it rides the same `commander_question` / `question_response` round trip — no new
frame, and the firmware's existing question screen renders it unchanged.

Most engines need **no parser**. `parsePermissionPane` in `lib/askQuestion.ts` reads any dialog that ends
in numbered rows under a line of key hints, identifying it by the rows rather than the prose: an approval
always offers a way to say yes and a way to say no. Claude, Command Code, codex, hermes and muse are all
read that way, and opencode's prompt is the horizontal one kilo inherited from it. Write a parser only
when your agent's rows are shaped differently — devin's carry no dot after the number, grok's sit in `(●)`
markers, cursor's are unnumbered and print their own key — and put it beside the question parser in
`engines/<name>/askQuestion.ts`. If your agent already
has a question parser, remember the permission prompt is usually a DIFFERENT dialog: muse needs
`parseMuseQuestionPane(capture) ?? parseQuestionPane(capture)` because only the first of those two
recognises its questions and only the second recognises its approvals.

Two rules that came out of measuring nine of these:

- **Never drop the row that declines.** A device user given three ways to approve and none to refuse
  cannot answer the prompt at all.
- **Drop rows that open a text editor** (`Edit command`, `Describe change to command`) — the device
  cannot type into them. This is not cosmetic: the firmware shows `OPT_MAX` = 6 options and truncates
  the rest silently, so on devin's seven-row prompt the row that falls off the end is `No`.

And do not conclude "this agent never asks" from one probe. Muse was filed that way after a single
sandboxed file write it simply *denied*; its approval is on by default and appears the moment the call is
one the sandbox allows but policy gates — network egress, in the end. Check the agent's own flags first:
something like `--yolo`, `--approval-mode` or `--dangerously-skip-permissions` existing at all is proof
there is a prompt to skip. Only pi has none — no such flag, no permission key in its settings, and
`curl`, a file write and a plain `rm` all run unprompted.

**Do not wire up the startup trust dialog.** Six engines open with some form of "do you trust this
directory?" (pi, devin, muse, cursor, codex, commandcode). It is not this feature: harness does not launch
the engine, so the person already answered it at their own keyboard, and the watcher only polls a pane
once the session is registered — which is later. Surfacing it would be dead code.

To capture the fixture: start your agent in tmux under its own config, ask it to run
`curl -s https://api.coingecko.com/api/v3/simple/price?ids=bitcoin`, and while the prompt is up run
`tmux capture-pane -p -e -t <pane> -S -80 > src/lib/__fixtures__/permission-<name>.txt`. Keep `-e`: the
existing fixtures carry their SGR codes because that is what `captureTmuxPane` returns. Then press the
digit and watch what happens. There are three mechanisms in the tree already, so check which one you
have: a digit that selects **and** submits (claude, commandcode, codex, muse, hermes, devin, grok), an
unnumbered list walked with arrows (amp, kilo, opencode), or unnumbered rows that each print their own
key (cursor — `(y)`, `(tab)`, `(shift+tab)`, `(esc or n)`, carried in `number` so `rowKeys` presses it).
And probe more than one kind of action before deciding your agent has only one prompt: claude gates the
command *and* the edit, cursor gates only the command.
| `lib/summarize.ts` | The end-of-turn recap. Note the pooling rule: agents that take their recap prompt as argv rather than stdin cannot be pre-warmed, so they opt out of the worker pool. Pick the cheapest setting your agent has for it — this is the one call Harness makes on its own, on every turn |
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
things analogy would have got wrong, and why. Whoever adds the next engine will read it.

## Getting help

- **The engine's transcript format is undocumented and you are reverse-engineering it** — that is
  normal. Open an issue with a recording and we will read it with you.
- **A stage in this page does not match the code** — that is a bug in this page. Say so; it is the
  most useful report we get.
- Security issues: **not the issue tracker** — see [`SECURITY.md`](../../../SECURITY.md).
