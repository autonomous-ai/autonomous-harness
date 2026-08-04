# example-provider

> ## ⚠ This runs Claude with `--dangerously-skip-permissions`
>
> Claude executes tools **without asking** — it can read, write and delete anything under the
> directory you configure, and run commands there. Point `agents.json` at a scratch directory, not at
> a real repository. `agents.example.json` ships pointing at `/tmp/example-provider-scratch` on
> purpose.

A **real** A2A provider for the Autonomous harness provider profile
(`../spec/README.md`), backed by the local `claude` CLI.

Where `apps/reference-provider` is scripted and deterministic, this one runs an actual agent. That is
the point: it answers the question a scripted provider cannot — **does the profile survive a real
agent?** Real agents stream partial tokens, call tools, resume sessions, and keep history in their own
format.

|  | `reference-provider` | `example-provider` |
|---|---|---|
| Replies | scripted | a real Claude turn |
| Job | conformance target, hostile scenarios, CI | prove the profile survives a real agent |
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
  -H 'content-type: application/json' -H 'x-api-key: demo' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendStreamingMessage",
       "params":{"message":{"role":"ROLE_USER","messageId":"m1",
                 "parts":[{"text":"what files are here?"}]}}}'
```

| Env | Default |
|---|---|
| `AGENTS_FILE` | `./agents.json` |
| `CLAUDE_PATH` | resolved via `which claude`, then the usual install locations |
| `CLAUDE_MODEL` | `claude-sonnet-5`. Pinned, not left to the CLI default: a provider owns its model choice, and Autonomous never sends one (spec §9) |
| `PORT` | `4502` |
| `STATE_FILE` | `./sessions.json` |
| `WORKSPACE_ROOT` | `/tmp/example-provider-scratch` — where `autonomous.CreateProject` puts a new agent's directory |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` |

## How it works

**Agents come from `agents.json`** — `[{ id, name, description, cwd }]`. Each becomes an
`AgentCard.skills[]` entry; `cwd` is where `claude` is spawned.

**One turn = one `claude` process**, invoked the way `apps/agent-node/brain` does it:

```
claude --print --verbose --output-format stream-json --input-format stream-json
       --include-partial-messages --dangerously-skip-permissions [--resume <sessionId>]
```

The user's message is passed **verbatim** — no wrapper text, no prepended hints.

**History comes from Claude's own transcripts** at
`~/.claude/projects/<mangled-cwd>/<sessionId>.jsonl`, so `GetTask` and `ListTasks` cost this provider
nothing. A pleasant side effect: **a turn typed straight into a terminal shows up in the session list
too** — it just does not stream live, since this app implements no `SubscribeToTask`.

**One mapper, two callers.** `src/mapper.ts` is the only place Claude's shape becomes A2A. Stdout
events and JSONL lines carry the same Anthropic message shape, so writing two parsers is the reliable
way to make the live view and the post-refresh view disagree.

## What it does not do

- **No `INPUT_REQUIRED`.** With permissions skipped, Claude never asks, so HP-104 stays demonstrated
  only by `reference-provider`'s scripted path.
- **No `SubscribeToTask`** — deliberately out of scope.
- **No session writes.** `workspace-write` is declared with `params: { projects: true, sessions: false }`:
  creating an agent is ours to do, but retitling or deleting a session would mean editing the user's
  own Claude transcripts under `~/.claude`.
- **No images.** Refused loudly rather than dropped silently (HP-106).

## Verification

```bash
npm test         # 31 tests, deterministic — replays a RECORDED real turn
npm run typecheck
```

Conformance, against a running instance:

```bash
cd ../reference-provider
npx tsx src/conformance.ts --url http://127.0.0.1:4502 --key demo --bad-key bad-key
# 21 passed · 0 failed · 2 manual · 10 not verifiable from outside
```

**That result is the headline.** The conformance runner was written against a scripted provider; a
real Claude-backed one passing it is what validates the profile, the runner, and this app at once.

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
   history read came back empty and HP-201 failed. `agents.json` paths are now `realpath`-resolved at
   load.

All three are pinned by tests, and all three tests were mutation-checked.

## Layout

| File | Role |
|---|---|
| `src/types.ts` | the A2A subset, copied from `reference-provider` — apps do not import each other |
| `src/config.ts` | `agents.json` loading and validation; resolves the `claude` binary |
| `src/agentCard.ts` | the card, built **from** the agent list |
| `src/claude.ts` | spawn, stdin frame, stdout lines, process-group kill |
| `src/mapper.ts` | **the** Claude → A2A mapping, shared by the live and history paths |
| `src/jsonl.ts` | transcript discovery, reading and time-slicing |
| `src/sessions.ts` | `contextId ↔ claudeSessionId`, and task windows |
| `src/server.ts` | JSON-RPC + SSE, with HP-xxx clause references inline |
