# Autonomous Harness

**The way we use computers changed. The hardware didn't.**

Mouse and keyboard assume your hands are on the work — you type the character, you drag the file, you
click the button. That held for forty years. It stopped about two years ago: most of what you ship
now, you described and an agent wrote. Your input became intent, target and judgment.

Your desk never caught up. So your agents live in two tmux panes, a browser tab, and a server you
keep forgetting about, and you alt-tab around to find the one that finished.

**[Harness](https://www.autonomous.ai/harness) is the device for that.** Keyboard in the middle,
mouse on the right, Harness on the left. Say one sentence and the work goes to whichever machine that
agent lives on. The screen shows all of them at once.

It drives the agents you already use. Nine of them today — and
[adding the tenth](#add-your-agent-to-harness) is a pull request:

<p align="center">
  <img src=".github/assets/engines/claude.png"      height="56" alt="Claude Code"  title="Claude Code">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/codex.png"       height="56" alt="Codex"        title="Codex">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/cursor.png"      height="56" alt="Cursor"       title="Cursor">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/opencode.png"    height="56" alt="OpenCode"     title="OpenCode">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/pi.png"          height="56" alt="Pi"           title="Pi">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/hermes.png"      height="56" alt="Hermes"       title="Hermes">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/commandcode.png" height="56" alt="Command Code" title="Command Code">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/devin.png"       height="56" alt="Devin"        title="Devin">
  &nbsp;&nbsp;&nbsp;
  <img src=".github/assets/engines/muse.png"        height="56" alt="Muse Code"    title="Muse Code">
</p>

https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

## How it works

Your agents stay your processes, on your hardware, with your credentials. Harness watches them and
gives you one place to steer from.

```
                        Harness (the device)
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
X25519 per connection, ChaCha20-Poly1305 per frame. The relay moves ciphertext and holds no key
material. Read it yourself: [`cli/src/lib/e2ee/`](cli/src/lib/e2ee/).

## Get started

You need **Node.js 20 or newer** and **tmux**. Make a machine in the web app, copy its token, then run
this on any computer you want your agents driven from — laptop, server, cloud VM:

```bash
curl -fsSL https://harness.autonomous.ai/install.sh | bash -s -- <token>
harness join          # connect this computer
harness status        # running? shows the chat link
```

Start `claude`, `codex`, `cursor` or any of the nine in a tmux pane and it shows up as something you
can talk to from the browser and from the device. Every command: [`cli/README.md`](cli/README.md).

## Add your agent to Harness

Yours not in that list? Put it there. Two ways in, and one question tells you which: **is your agent a
command someone runs, or a service they call?**

|  | **CLI** | **API** |
|---|---|---|
| **Your agent is** | a command you run — laptop, server, anywhere | a service on your own infrastructure |
| **You write** | a normalizer, in TypeScript, here | an HTTP endpoint, in any language |
| **You ship it** | as a pull request to this repo | by deploying it yourself |
| **Start at** | [`cli/src/engines/`](cli/src/engines/README.md) | [`provider/`](provider/README.md) |

Run `harness join` on any machine you can reach and its agents show up next to your laptop's. In the
code these are named `engine` (CLI) and `provider` (API) — the folder names you'll see.

```bash
# CLI — typecheck and replay the recorded-session fixtures
cd cli && npm install && npm run typecheck && npm test

# API — run the reference implementation, then check your endpoint against it
cd provider/reference-provider && npm install && npm run dev
npm run conformance -- --url https://your-endpoint --key <credential>
```

Nine engines are in there now. The tenth is a pull request, and both guides are written so you can do
it without talking to us first. If you get stuck, that's a bug in the guide — tell us.

## Contributing, security, licence

- Adding an agent, or a gap in the spec — [CONTRIBUTING.md](CONTRIBUTING.md).
- Security reports: **not the issue tracker** — [SECURITY.md](SECURITY.md).
- [Apache-2.0](LICENSE).
