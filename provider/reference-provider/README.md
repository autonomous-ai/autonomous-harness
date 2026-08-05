# reference-provider

A minimal, deterministic implementation of the **Autonomous machine provider profile**
(`../spec/README.md`) — an A2A agent that Autonomous can attach to as a `provider`
machine.

It runs no model. Every reply is scripted, which is the point: it exists to prove the spec is
implementable, to give the backend client something real to talk to, and to be the target the
conformance suite runs against.

**Zero runtime dependencies**, `node:http` and nothing else. A partner should be able to read
`src/server.ts` end to end and know exactly what their own endpoint has to do.

## Run it

```bash
npm install
npm run dev                 # http://127.0.0.1:4501
curl localhost:4501/.well-known/agent-card.json
```

Send a turn (any non-empty `x-api-key` is accepted except the literal `bad-key`):

```bash
curl -N localhost:4501 \
  -H 'content-type: application/json' -H 'x-api-key: demo' \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendStreamingMessage",
       "params":{"message":{"role":"ROLE_USER","messageId":"m1",
                 "parts":[{"text":"did acme blow through budget?"}]}}}'
```

`STEP_DELAY_MS` (default 20) controls the pause between streamed steps; the tests set it to 0.

## Scenarios

Selected by what the user's message contains — see `src/scenarios.ts`. **The hostile ones are the
reason this app exists**; a reference that only demonstrates success teaches a partner nothing about
the failure modes their integration will actually hit.

| Say this | What happens | Why it's here |
|---|---|---|
| *(anything else)* | thinking → tool call → text → `COMPLETED` | the full-fidelity turn |
| `plain` | one text part, **no metadata at all** | HP-211 — a bare provider is conformant |
| `ask me` | parks in `INPUT_REQUIRED` | HP-104 — answer arrives on the same `taskId` |
| `fail` | emits output, then `FAILED` | failure after partial output |
| `die` | stream cut with **no terminal state** | deliberately violates HP-102, so the client can be hardened |
| `compact` | reports `context_compact` | the provider compacted its own context (spec §9) |
| *(image attachment)* | `FAILED` with a clear message | HP-106 — silent discarding is a violation |

Credential `bad-key` fails every call with HTTP 401 + `-32001`, for exercising HP-013.

## What it deliberately does NOT declare

`workspace-files` and `workspace-write` are absent from the agent card. That is not an oversight — it
exercises the degradation path, where the client must hide those features rather than offer controls
that fail (HP-022).

## Conformance suite

Point it at **any** provider endpoint — yours, or someone else's:

```bash
npm run conformance -- --url https://agent.example.com --key <credential>

# two optional flags unlock three more clauses:
#   --bad-key <invalid credential>   → HP-013 (a rejection must be distinguishable from an outage)
#   --ask-phrase "<prompt>"          → HP-103, HP-104 (cancel, and the INPUT_REQUIRED round trip)
```

Against this reference provider: **22 passed · 0 failed · 2 need manual review · 9 not verifiable from outside**.

Two rules it follows, both deliberate:

- **Nothing is skipped silently.** A clause that genuinely cannot be checked from outside — tenant
  isolation, the 5 MB transcript ceiling, whether the credential gets logged — is reported as SKIP
  **with the reason printed**. A suite that claims to check everything while quietly checking half of
  it is worse than no suite at all.
- **An undeclared extension is a SKIP, not a failure.** Absence is a legitimate answer (HP-022).

Output names the clause, so a red line points at a section of the spec rather than at a symptom:

```
✖ HP-200  ListTasks filters by contextId
            3 task(s) from another context leaked into the filter
```

Extension checks are **real calls**, not stubs: `autonomous.GetRecap` is invoked and its response
validated (including the 200-character ceiling the device renders under). `workspace-write` is probed
**non-destructively** — empty params must yield `-32602` (invalid params) rather than `-32601` (method
not found), which proves the method exists without a conformance runner mutating someone's live
workspace.

The suite itself has been mutation-tested. Six deliberate breaks, each turning exactly one clause red:
`streaming: false` → HP-021 · a mistyped extension URI → HP-003 · ignoring the `contextId` filter →
HP-200 · an unrecognised metadata kind → HP-210 · answering an **undeclared** extension method →
HP-311 · a recap longer than 200 characters → HP-302.

## Tests

```bash
npm test        # 30 tests — provider + the conformance runner itself
npm run typecheck
```

Each test names the clause it pins. When the spec changes, these should be the first thing to go red.
The suite has been mutation-tested: dropping `final` on terminal states, silently discarding images,
and allowing a finished task to be cancelled each turn it red.

## Layout

| File | Role |
|---|---|
| `src/types.ts` | the A2A subset used here, plus the `autonomous.ai/*` metadata — hand-written so the whole wire surface is readable in one file |
| `src/agentCard.ts` | the entire capability negotiation (HP-020 … HP-023) |
| `src/scenarios.ts` | the scripted turns, happy and hostile |
| `src/store.ts` | in-memory tasks — note that **history lives here**, which is why `GetTask`/`ListTasks` are Tier 0 |
| `src/server.ts` | JSON-RPC dispatch and SSE, with HP-xxx clause references inline |
| `src/conformance.ts` | the runner partners point at their own endpoint |
| `src/conformance.spec.ts` | regression cover for the runner — including that it **reports** an unreachable endpoint instead of throwing, and never reports PASS for a clause it did not actually check |
