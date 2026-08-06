# Autonomous Harness

**[Harness](https://www.autonomous.ai/harness) is a device for working with AI agents.** It sits on
your desk like any other input device — keyboard in the middle, mouse on the right, Harness on the
left. Speak one sentence to it and the work goes to the agents already running on your laptop, your
servers, and in the cloud. The screen shows you what all of them are doing.

Keyboard = type. Mouse = point. **Harness = delegate.**

https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

## How it works

One device, every machine you own. The agents stay your processes, on your hardware, with your
credentials — Harness watches them and gives you one place to steer them from.

```
          Harness (the device)              web app
                     └────────────┬────────────┘
                                  │  end-to-end encrypted
                        ┌─────────┴─────────┐
                        │  Autonomous relay │   ciphertext in, ciphertext out
                        └─────────┬─────────┘
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
     your laptop             your server            your platform
    `harness join`          `harness join`          your HTTP API
          │                       │                       │
     claude · codex          hermes · muse           agents running on
     cursor · …              opencode · …            your own servers

          └───────── CLI ─────────┘             └─────── API ───────┘
```

The relay never sees your work in the clear. It moves ciphertext between the device and your
machines; the keys live on the endpoints.

## Get started

You need **Node.js 20 or newer** and **tmux**. Create a machine in the web app, copy its token, then
run this on any computer you want your agents driven from:

```bash
curl -fsSL https://harness.autonomous.ai/install.sh | bash -s -- <token>
harness join          # connect this computer
harness status        # running? shows the chat link
```

Now start `claude`, `codex`, `cursor` or any supported agent in a tmux pane. It shows up as an agent
you can talk to from the browser and the device. Every `harness` command is documented in
[`cli/README.md`](cli/README.md).

## Integrate your agent

**There are two ways in: as a CLI, or over your own API.** Which one you want comes down to a single
question — does your agent run on the user's computer, or on yours?

|  | **CLI** | **API** |
|---|---|---|
| **Your agent runs** | on the user's own computer | on your servers |
| **Harness reaches it by** | reading the transcript your CLI already writes to disk | calling your HTTP API over the network |
| **You write** | a normalizer, in TypeScript, in this repo | an HTTP endpoint, in any language |
| **You ship it by** | opening a pull request here | deploying your own service |
| **The user connects it by** | installing your CLI | pasting a URL and a credential |
| **Working today** | Claude Code, Codex, Cursor, OpenCode, Pi, Hermes, Command Code, Devin, Muse Code | your platform |
| **Start here** | [`cli/src/engines/`](cli/src/engines/README.md) | [`provider/`](provider/README.md) |

If the user types your agent's name in a terminal, you want the **CLI** path. If they log into your
service, you want the **API** path.

> In the code and the spec these are named **`engine`** (CLI) and **`provider`** (API). Those are the
> folder names in this repo, so you will see both words once you start reading.

```bash
# CLI path — typecheck and replay the recorded-session fixtures
cd cli && npm install && npm run typecheck && npm test

# API path — run the reference implementation, then check your endpoint against it
cd provider/reference-provider && npm install && npm run dev
npm run conformance -- --url https://your-endpoint --key <credential>
```

The provider protocol is a profile of [A2A](https://github.com/a2aagent/A2A) v1.0.1, with a reference
implementation and a conformance runner you can point at your own endpoint.

## What's in here

| | |
|---|---|
| [`cli/`](cli/README.md) | The `harness` CLI — bridges the agent CLIs on your machine to the web app and the device |
| [`cli/src/engines/`](cli/src/engines/README.md) | One folder per agent Harness can drive. Adding the tenth is a pull request |
| [`provider/`](provider/README.md) | The provider protocol — spec, reference implementation, conformance runner |

## Contributing, security, licence

- Adding an agent framework, or a gap in the spec — [CONTRIBUTING.md](CONTRIBUTING.md).
- Security reports: **not the issue tracker** — [SECURITY.md](SECURITY.md).
- [Apache-2.0](LICENSE).
