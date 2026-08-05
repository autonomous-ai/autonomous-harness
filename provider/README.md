# Provider Protocol

Make your agent platform available on the [Autonomous Harness](https://www.autonomous.ai/machine).
A user connects it with a **URL and a credential**, then drives it from the web app or from the
hardware device on their desk.

**This is a profile of [A2A](https://github.com/a2aagent/A2A) v1.0.1, not a new protocol.** If you
already run a conformant A2A agent, most of it is done. Everything specific to Autonomous is either
standard A2A used as intended, or a declared A2A extension — nothing here forks the standard.

| | |
|---|---|
| [`spec/`](spec/README.md) | The contract. 40 numbered clauses (`HP-xxx`) |
| [`spec/onboarding.md`](spec/onboarding.md) | What to do once you conform, and what to expect from us |
| [`reference-provider/`](reference-provider/) | Scripted and deterministic — **and it ships the conformance runner** |
| [`example-provider/`](example-provider/) | A real one, backed by the Claude Code CLI |

## Quick start

See it work before reading the spec:

```bash
cd reference-provider && npm install && npm run dev     # http://127.0.0.1:4501
curl localhost:4501/.well-known/agent-card.json
```

Then point the runner at your own endpoint. **Zero failures is the bar:**

```bash
npm run conformance -- --url https://your-endpoint --key <credential>
```

It names the clause on every line, so a red result points at a section of the spec rather than at a
symptom:

```
✔ HP-021  capabilities.streaming is true
✖ HP-200  ListTasks filters by contextId
            3 task(s) from another context leaked into the filter
```

## What you actually have to implement

**Tier 0 is all A2A core.** There is no Autonomous-specific work in it at all:

| | Backs |
|---|---|
| Agent Card at `/.well-known/agent-card.json` | capability discovery, and your agent list |
| `SendStreamingMessage` → SSE | a turn |
| `CancelTask` | stopping one |
| `ListTasks` · `GetTask` | history |

History is required, not optional: **Autonomous stores no transcript for a provider machine.** Without
those two, a page refresh loses the conversation.

**Everything else is an optional, declared extension** — file browsing, workspace writes, per-turn
recaps, voice routing. An extension you do not declare is simply absent, and the product hides the
feature rather than offering a control that fails.

Two things are deliberately **not** in the profile: model selection (you own your model configuration)
and end-to-end encryption (the plaintext originates on your side; users are told this in our UI).

## What is in this section

```
spec/                 the contract + JSON Schemas
reference-provider/   zero runtime dependencies — readable end to end
example-provider/     a real agent; runs Claude with permissions skipped ⚠ read its README first
```

Both packages are plain TypeScript on Node ≥ 20 with **no runtime dependencies**. That is on purpose:
you should be able to read `reference-provider/src/server.ts` and know exactly what your own endpoint
has to do.

## Contributing, security, licence

- Found a gap in the spec, or a clause the runner cannot actually check? [Open an issue](https://github.com/autonomous-ai/autonomous-harness/issues) — see [CONTRIBUTING.md](../CONTRIBUTING.md).
- Security reports: **not the issue tracker** — see [SECURITY.md](../SECURITY.md).
- Licensed under [Apache-2.0](../LICENSE).
