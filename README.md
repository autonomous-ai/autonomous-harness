# Autonomous Harness

The [Autonomous Harness](https://www.autonomous.ai/harness) is a device and a service for running
coding agents: one sentence, spoken to a disc on your desk, dispatched to the agents already running
on your laptop, your server, and in the cloud.

https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

This repository is where the parts other people need to build against are published — specs,
reference implementations, and the tools to check your own work against them.

| | |
|---|---|
| [`cli/`](cli/README.md) | **`harness` CLI** — run the coding-agent CLIs you already use (Claude Code, Codex, Cursor, OpenCode, Pi, Hermes, Command Code, Devin, Muse Code) in tmux on your own machine and drive them from the web app or the device. End-to-end encrypted browser channel; the agents stay your processes with your credentials |
| [`cli/src/engines/`](cli/src/engines/README.md) | **Agent frameworks** — one folder per agent Harness can drive. **Adding a tenth is a pull request**, and that page is the whole job in dependency order |
| [`provider/`](provider/README.md) | **Provider protocol** — make your own agent platform available on the Machine. Users connect it with a URL and a credential, then drive it from the web app or the device. A profile of [A2A](https://github.com/a2aagent/A2A) v1.0.1, with a reference implementation and a conformance runner |

More will be published here as it stabilises. Each section is self-contained: its own README, its own
packages, its own tests.

## Getting started

Every section stands on its own — start with its README.

### Making your agent work with Harness

There are two ways in, and which one you want depends on where your agent runs. Pick the wrong one
and you will do a lot of work in the wrong place, so start here:

| Your agent is… | You want | Where |
|---|---|---|
| **A CLI the user runs on their own machine**, writing a transcript to disk as it goes | an **engine** — a folder in the CLI that translates your transcript into Harness's event stream | [`cli/src/engines/README.md`](cli/src/engines/README.md) |
| **A hosted platform** the user reaches over the network with a URL and a credential | a **provider** — implement the A2A profile and run the conformance suite against your endpoint | [`provider/README.md`](provider/README.md) |

Rough guide: if the user types your agent's name in a terminal, it is an engine. If they log into it,
it is a provider. Nine engines ship today; adding the tenth is a pull request.

```bash
# provider: run the reference implementation, then check your own endpoint against it
cd provider/reference-provider && npm install && npm run dev
npm run conformance -- --url https://your-endpoint --key <credential>

# engine: typecheck and replay the recorded-session fixtures
cd cli && npm install && npm run typecheck && npm test
```

## Conventions across this repository

- **Specs are numbered.** Every normative statement has a stable id, so a failure can point at a
  clause rather than a symptom, and a conformance runner can assert one check per id.
- **Specs are compatibility contracts.** Optional fields may be added; nothing published is renamed,
  removed, retyped or reinterpreted without a new revision served alongside the old one.
- **Reference implementations carry no runtime dependencies.** You should be able to read one end to
  end and know what your own implementation has to do, without installing anything to understand it.

## Contributing, security, licence

- Gaps in a spec, or a clause its runner cannot actually verify, are the most useful thing to report —
  see [CONTRIBUTING.md](CONTRIBUTING.md).
- Security reports: **not the issue tracker** — see [SECURITY.md](SECURITY.md).
- Licensed under [Apache-2.0](LICENSE).
