# Provider Protocol

Make your agent platform available on the [Autonomous Harness](https://www.autonomous.ai/machine).
A user connects it with a **URL and a credential**, then drives it from the web app or from the
hardware device on their desk.

**Authenticate, call a method, handle the response.** JSON-RPC 2.0 over HTTPS to one URL, with
Server-Sent Events for the one method that streams. Eight methods, no SDK, nothing to discover, and
no capability negotiation — if you can serve JSON over HTTPS, you can implement this in an afternoon.

| | |
|---|---|
| [`spec/`](spec/README.md) | The contract — one page |
| [`spec/onboarding.md`](spec/onboarding.md) | What to do once you conform, and what to expect from us |
| [`reference-provider/`](reference-provider/) | Scripted and deterministic — **and it ships the conformance runner** |
| [`example-provider/`](example-provider/) | A real one, backed by the Claude Code CLI |

## Quick start

See it work before reading the spec:

```bash
cd reference-provider && npm install && npm run dev     # http://127.0.0.1:4501
curl -H 'Authorization: Bearer any-key' -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}' localhost:4501
```

Then point the runner at your own endpoint. **Zero failures is the bar:**

```bash
npm run conformance -- --url https://your-endpoint --key <credential>
```

Every line names a rule, so a red result points at something specific rather than at a symptom:

```
✔ terminal-frame           Every stream ends with EXACTLY ONE terminal event
✖ history-matches-stream   History returns the SAME event objects the stream emitted
             history and the live stream disagree about the same events
```

## What you actually have to implement

**Eight methods.** All of them are required, and that is the whole surface:

| | Backs |
|---|---|
| `agent.list` | the agents a user picks from — authenticated, so it can differ per tenant |
| `agent.send` → SSE | a turn |
| `agent.history` | rebuilding the conversation |
| `turn.cancel` | stopping a turn |
| `agent.create` / `agent.rename` / `agent.delete` | managing the agent list |
| `agent.recap` | short per-turn summaries the hardware device shows |

History is required, not optional: **Autonomous stores no transcript for a provider machine.** Without
it, a page refresh loses the conversation.

**"Required" does not mean "pretend".** If your agents are managed inside your own product, answer
`invalid_request` with a message instead of faking a mutation — we show that message to the user
(*"Agents are managed in Example Co"*), which tells them more than a control that silently vanished.
A provider that summarises nothing answers `agent.recap` with an empty list, and we derive one from
the turn's own text.

## What is in this section

```
spec/                 the contract + JSON Schemas
reference-provider/   zero runtime dependencies — readable end to end
example-provider/     a real agent; runs Claude with permissions skipped ⚠ read its README first
```

Both packages are plain TypeScript with **no runtime dependencies** — Node ≥ 20, or ≥ 20.12 for
`example-provider`, which reads its `.env` with the platform's own `process.loadEnvFile` rather than
take a dependency on one. That is on purpose:
you should be able to read `reference-provider/src/server.ts` and know exactly what your own endpoint
has to do.

## Contributing, security, licence

- Found a gap in the spec, or a rule the runner cannot actually check? [Open an issue](https://github.com/autonomous-ai/autonomous-harness/issues) — see [CONTRIBUTING.md](../CONTRIBUTING.md).
- Security reports: **not the issue tracker** — see [SECURITY.md](../SECURITY.md).
- Licensed under [Apache-2.0](../LICENSE).
