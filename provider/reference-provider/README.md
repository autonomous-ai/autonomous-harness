# reference-provider

A minimal, deterministic implementation of the **Autonomous machine provider protocol**
(`../spec/README.md`) — an endpoint Autonomous can attach to as a `provider` machine.

It runs no model. Every reply is scripted, which is the point: it exists to prove the protocol is
implementable, to give the backend client something real to talk to, and to be the target the
conformance suite runs against.

**Zero runtime dependencies**, `node:http` and nothing else. A partner should be able to read
`src/server.ts` end to end and know exactly what their own endpoint has to do.

## Run it

```bash
npm install
npm run dev                 # http://127.0.0.1:4319
```

Any non-empty credential is accepted except the literal `bad-key`:

```bash
curl -N localhost:4319 \
  -H 'content-type: application/json' -H 'authorization: Bearer demo' \
  -d '{"jsonrpc":"2.0","id":1,"method":"agent.send",
       "params":{"agentId":"alpha","turnId":"t-1",
                 "message":{"text":"did acme blow through budget?"}}}'
```

`STEP_DELAY_MS` (default 20) controls the pause between streamed steps; the tests set it to 0.

## Scenarios

Selected by what the user's message contains — see `src/scenarios.ts`. **The hostile ones are the
reason this app exists**; a reference that only demonstrates success teaches a partner nothing about
the failure modes their integration will actually hit.

| Say this | What happens | Why it's here |
|---|---|---|
| *(anything else)* | thinking → tool call → text → `turn_completed` | the full-fidelity turn |
| `everything` | every content kind in one turn | proves the vocabulary is reachable — from outside, a kind nobody emits is indistinguishable from one nobody supports |
| `plain` | one event with **no `kind` at all** | a bare provider is conformant |
| `ask me` | ends with `turn_input_required` | the answer arrives on the same `turnId` |
| `fail` | emits output, then `turn_failed` | failure after partial output |
| `die` | stream cut with **no terminal frame** | deliberately breaks the one-terminal rule, so the client can be hardened |
| `compact` | reports `context_compact` | the provider compacted its own context |
| `recap` | `recap_start` / `recap_end` around the summary | the recap pushed on the turn's own stream |

Credential `bad-key` fails every call with HTTP 401 and `unauthenticated`, so the runner's `--bad-key`
probe has something to hit.

## Conformance suite

Point it at **any** provider endpoint — yours, or someone else's:

```bash
npm run conformance -- --url https://agent.example.com --key <credential>

# two optional flags unlock four more checks:
#   --bad-key <invalid credential>   → a rejection must be distinguishable from an outage
#   --ask-phrase "<prompt>"          → the turn_input_required round trip
```

Against this reference provider: **19 passed · 0 failed · 2 need manual review · 5 not verifiable
from outside**.

Two rules it follows, both deliberate:

- **Nothing is skipped silently.** A rule that genuinely cannot be checked from outside — tenant
  isolation, the truncation flag, whether the credential gets logged — is reported as SKIP **with the
  reason printed**. A suite that claims to check everything while quietly checking half of it is worse
  than no suite at all.
- **Every check has a stable `id` slug.** The slug is what the tests match on; the title is what a
  partner reads. Rewording a title must never break the suite that proves the suite works.

```
✔ terminal-frame           Every stream ends with EXACTLY ONE terminal event
✖ history-matches-stream   History returns the SAME event objects the stream emitted
             history and the live stream disagree about the same events
```

Checks are **real calls**, not stubs. `agent.recap` is invoked and its response validated. The
mutations are probed **non-destructively** — `agent.create` with an empty name — which proves the
method is reachable, and distinguishes a provider that declines with a reason (conformant, and the
reason is shown to the user) from one that answers `unsupported` (not).

**The suite is itself tested against deliberate breaks** — see `conformance.spec.ts`. Eleven broken
providers, each violating exactly one rule, each of which the runner must catch: a stream with no
terminal frame and one with two · `agent.send` answering with ordinary JSON instead of SSE · a bad
credential being accepted · a bad credential getting a list back instead of an error · an empty agent
list · tool events with no id · an early cancel ignored · history disagreeing with the stream · an
unknown method being answered · an unknown request field being fatal. A runner that only ever goes
green converts "we did not check" into "we checked and it was fine".

## Tests

```bash
npm test        # 48 tests — provider + the conformance runner itself
npm run typecheck
```

Each test names the rule it pins. When the spec changes, these should be the first thing to go red.

## Layout

| File | Role |
|---|---|
| `src/types.ts` | the whole wire surface, hand-written so it is readable in one file |
| `src/agents.ts` | the agent list and the mutations on it — ids derived on read, never snapshotted |
| `src/scenarios.ts` | the scripted turns, happy and hostile |
| `src/store.ts` | in-memory transcripts — note that **history lives here**, which is why `agent.history` is required |
| `src/server.ts` | JSON-RPC dispatch and SSE |
| `src/conformance.ts` | the runner partners point at their own endpoint |
| `src/conformance.spec.ts` | regression cover for the runner — including that it **reports** an unreachable endpoint instead of throwing, and never reports PASS for a rule it did not actually check |
