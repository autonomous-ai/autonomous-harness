# Autonomous Harness

**[Harness](https://www.autonomous.ai/harness) is a device for working with AI agents.** It sits on
your desk like any other input device — keyboard in the middle, mouse on the right, Harness on the
left. Speak one sentence to it and the work goes to the agents already running on your laptop, your
servers, and in the cloud. The screen shows you what all of them are doing.

Keyboard = type. Mouse = point. **Harness = delegate.**

https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

## How it works

One device, every machine you own. The agents stay your processes, on your hardware, with your
credentials.

```
          Harness (the device)              web app
                     └────────────┬────────────┘
                                  │
                        ╔═════════╧═════════╗
                        ║  Autonomous relay ║  end-to-end encrypted · we hold no keys
                        ╚═════════╤═════════╝
          ┌───────────────────────┼───────────────────────┐
          │                       │                       │
     your laptop             your server            your platform
    `harness join`          `harness join`          your HTTP API
          │                       │                       │
     claude · codex          hermes · muse           agents running on
     cursor · …              opencode · …            your own servers

          └───────── CLI ─────────┘             └─────── API ───────┘
```

Everything is encrypted on your machine before it reaches us — Ed25519 identities pinned at pairing,
X25519 per connection, ChaCha20-Poly1305 per frame. The relay routes ciphertext and holds no key
material. Implementation: [`cli/src/lib/e2ee/`](cli/src/lib/e2ee/).

## Get started

You need **Node.js 20 or newer** and **tmux**. Create a machine in the web app, copy its token, then
run this on any computer you want your agents driven from — your laptop, a server, a cloud VM:

```bash
curl -fsSL https://harness.autonomous.ai/install.sh | bash -s -- <token>
harness join          # connect this computer
harness status        # running? shows the chat link
```

Start `claude`, `codex`, `cursor` or any supported agent in a tmux pane and it shows up as an agent
you can talk to from the browser and the device. Works today with Claude Code, Codex, Cursor,
OpenCode, Pi, Hermes, Command Code, Devin and Muse Code. Commands: [`cli/README.md`](cli/README.md).

## Integrate your agent

**Two ways in, and one question picks it: is your agent a command someone runs, or a service they
call?**

|  | **CLI** | **API** |
|---|---|---|
| **Your agent is** | a command you run — laptop, server, anywhere | a service on your own infrastructure |
| **You write** | a normalizer, in TypeScript, here | an HTTP endpoint, in any language |
| **You ship it** | as a pull request to this repo | by deploying it yourself |
| **Start at** | [`cli/src/engines/`](cli/src/engines/README.md) | [`provider/`](provider/README.md) |

Run `harness join` on any machine you can reach and its agents appear next to your laptop's. In the
code these are named `engine` (CLI) and `provider` (API) — the folder names you will see.

```bash
# CLI — typecheck and replay the recorded-session fixtures
cd cli && npm install && npm run typecheck && npm test

# API — run the reference implementation, then check your endpoint against it
cd provider/reference-provider && npm install && npm run dev
npm run conformance -- --url https://your-endpoint --key <credential>
```

## Contributing, security, licence

- Adding an agent, or a gap in the spec — [CONTRIBUTING.md](CONTRIBUTING.md).
- Security reports: **not the issue tracker** — [SECURITY.md](SECURITY.md).
- [Apache-2.0](LICENSE).
