# example-provider

> ## ⚠ This runs Claude with `--dangerously-skip-permissions`
>
> Claude executes tools **without asking** — it can read, write and delete anything under the
> directory you configure, and run commands there. Point `agents.json` at a scratch directory, not at
> a real repository. `agents.example.json` ships pointing at `/tmp/example-provider-scratch` on
> purpose.

A **real** provider for the Autonomous machine provider protocol (`../spec/README.md`), backed by the
local `claude` CLI.

Where `reference-provider` is scripted and deterministic, this one runs an actual agent. That is the
point: it answers the question a scripted provider cannot — **does the protocol survive a real
agent?** Real agents stream partial tokens, call tools, resume sessions, and keep history in their own
format.

|  | `reference-provider` | `example-provider` |
|---|---|---|
| Replies | scripted | a real Claude turn |
| Job | conformance target, hostile scenarios, CI | prove the protocol survives a real agent |
| Determinism | total | none — **keep it out of CI** |

## Run it

```bash
npm install
cp agents.example.json agents.json      # then edit cwd
mkdir -p /tmp/example-provider-scratch
npm run dev                             # http://127.0.0.1:4502
```

```bash
curl -N localhost:4502 \
  -H 'content-type: application/json' -H 'authorization: Bearer demo' \
  -d '{"jsonrpc":"2.0","id":1,"method":"agent.send",
       "params":{"agentId":"scratch","turnId":"t-1",
                 "message":{"text":"what files are here?"}}}'
```

| Env | Default |
|---|---|
| `AGENTS_FILE` | `./agents.json` |
| `CLAUDE_PATH` | resolved via `which claude`, then the usual install locations |
| `CLAUDE_MODEL` | `claude-sonnet-5`. Pinned, not left to the CLI default: a provider owns its model choice, and Autonomous never sends one |
| `PORT` | `4502` |
| `STATE_FILE` | `./sessions.json` |
| `WORKSPACE_ROOT` | `/tmp/example-provider-scratch` — where `agent.create` puts a new agent's directory |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` |
| `CLAUDE_RECAP_MODEL` | `claude-haiku-4-5-20251001` — the per-turn recap is a one-line headline, not the work, so it gets a small model |
| `RECAP_DISABLED` | unset. `1` skips the recap model entirely and excerpts the turn instead |

## How it works

**Agents come from `agents.json`** — `[{ id, name, description, cwd }]`. Each becomes an `agent.list`
entry; `cwd` is where `claude` is spawned. `agent.create` / `agent.rename` / `agent.delete` really
mutate that file, so an agent created a moment ago is addressable by its very next `agent.send`.

**One turn = one `claude` process**, invoked the way `apps/agent-node/brain` does it:

```
claude --print --verbose --output-format stream-json --input-format stream-json
       --include-partial-messages --dangerously-skip-permissions [--resume <sessionId>]
```

The user's message is passed **verbatim** — no wrapper text, no prepended hints.

**History comes from Claude's own transcripts** at
`~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl`, so `agent.history` costs this provider nothing to
store. A pleasant side effect: **a turn typed straight into a terminal shows up in the transcript
too** — it just does not stream live, since nothing was watching when it ran.

One agent is one Claude session, resumed on every turn, so the whole transcript is one file. A long
one arrives a page at a time: `agent.history` takes `limit` and an opaque `before` cursor and walks
backwards, and stops offering a cursor once the start is reached.

**One mapper, two callers.** `src/mapper.ts` is the only place Claude's shape becomes a provider
event. Stdout lines and JSONL lines carry the same Anthropic message shape, so writing two parsers is
the reliable way to make the live view and the post-refresh view disagree about the same turn — which
is exactly what `agent.history` returning the stream's own objects forbids.

**Recaps are generated per TURN**, on the turn's own stream and just before its terminal event, by a
disposable one-shot `claude --print` (`src/recap.ts`). The turn therefore stays open while the summary
is written — deliberately, and announced: `recap_start` goes out before the wait and `recap_end` after
it, so the client can say "preparing a recap" instead of showing a stall.

The recap is pushed on the turn's OWN stream and also persisted for `agent.recap`. Both, not either: the stream serves the client watching this turn,
and the persisted copy serves a device restoring its tiles after a reboot, which has no stream to
read. Pushing is what makes the recap unambiguously THIS turn's — the pull is scoped to an agent and
takes no turn id, so a client asking the instant a turn ends can only get the previous one.

Four details are load-bearing:

- **No `--resume`.** The summariser must never touch the live session, or the summary lands in the
  transcript and the next turn's history contains a summary of the previous one.
- **`recap` is what the turn ACCOMPLISHED, not what was asked.** Those are different sentences, and
  `metadata.title` — the first user message — is the wrong one. A device tile that echoes the user's
  own prompt back at them is worse than no tile.
- **The caps are re-applied after the model answers.** A model asked for 15 words will sometimes give
  40, and `recap` is capped at 200 characters. Nothing ever appends an
  ellipsis: the tile renders on a small round display, where a line advertising its own truncation
  reads worse than one that simply ends.

- **A `recap_start` is always followed by a `recap_end`**, even when there is nothing to say — the end
  then carries no headline. An indicator that is opened and never closed is worse than one never shown.

A failed or cancelled turn gets no recap, and no start/end pair either. If the one-shot fails, times
out, or `RECAP_DISABLED=1`, the turn's own opening sentence is excerpted instead — a recap is a nicety
and must never be able to retroactively fail a turn that succeeded.

## What it does not do

- **No `turn_input_required`.** With permissions skipped, Claude never asks, so that path stays
  demonstrated only by `reference-provider`'s scripted one.
- **`agent.delete` leaves the directory alone.** Removing an agent from the list is reversible;
  deleting whatever work it produced is not, and an example provider is the last place to be
  destructive.
- **No images.** Refused loudly rather than dropped silently.

## Verification

```bash
npm test         # 43 tests, deterministic — replays a RECORDED real turn; never spawns a model
npm run typecheck
```

Conformance, against a running instance:

```bash
cd ../reference-provider
npx tsx src/conformance.ts --url http://127.0.0.1:4502 --key demo --bad-key bad-key
```

**Zero failures is the headline.** The conformance runner was written against a scripted provider; a
real Claude-backed one passing it is what validates the protocol, the runner, and this app at once.

## Two real bugs the fixtures caught

`src/__fixtures__/real-turn.jsonl` is a **recorded** Claude turn, not hand-written JSON. Both of these
were invisible to invented fixtures and obvious the moment a real turn was replayed:

1. **Nearly every stdout line carries `session_id`.** An early `if (line.session_id) return …` in the
   mapper swallowed *every* event — the turn produced zero parts and no terminal state. Session
   capture is now a separate function (`sessionIdOf`), which removes the whole class of bug.
2. **`tool_use` is announced twice** — once by `content_block_start` (with empty arguments, since
   they stream in later) and again in the complete `assistant` message. Taking both rendered every
   tool twice: 2 `tool_start` against 1 `tool_end`. The complete message is now the single source.

And one the **conformance suite** caught against the live agent:

3. **macOS `/tmp` is a symlink to `/private/tmp`**, and Claude records the resolved path. A configured
   `/tmp/x` made this provider look in `-tmp-x` while Claude had written `-private-tmp-x`, so every
   history read came back empty. `agents.json` paths are now `realpath`-resolved at load.

All three are pinned by tests, and all three tests were mutation-checked.

## Layout

| File | Role |
|---|---|
| `src/types.ts` | the wire surface, copied from `reference-provider` — the apps do not import each other |
| `src/config.ts` | `agents.json` loading and validation; resolves the `claude` binary |
| `src/agents.ts` | the agent list, read from config on every call so a new agent is instantly addressable |
| `src/claude.ts` | spawn, stdin frame, stdout lines, process-group kill |
| `src/mapper.ts` | **the** Claude → provider-event mapping, shared by the live and history paths |
| `src/jsonl.ts` | transcript discovery, reading and time-slicing |
| `src/sessions.ts` | `agentId ↔ claudeSessionId` — one agent is one Claude session — plus turn windows and persisted per-turn recaps |
| `src/recap.ts` | the per-turn recap one-shot, its caps, and the no-model fallback |
| `src/server.ts` | JSON-RPC + SSE |
