https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

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

It drives the agents you already use:

<p align="center">
  <img src=".github/assets/engines/claude.png"      height="72" alt="Claude Code"  title="Claude Code">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/codex.png"       height="72" alt="Codex"        title="Codex">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/cursor.png"      height="72" alt="Cursor"       title="Cursor">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/opencode.png"    height="72" alt="OpenCode"     title="OpenCode">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/pi.png"          height="72" alt="Pi"           title="Pi">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/hermes.png"      height="72" alt="Hermes"       title="Hermes">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/commandcode.png" height="72" alt="Command Code" title="Command Code">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/devin.png"       height="72" alt="Devin"        title="Devin">
  &nbsp;&nbsp;
  <img src=".github/assets/engines/muse.png"        height="72" alt="Muse Code"    title="Muse Code">
</p>

## Add your agent to Harness

Two ways to integrate. We support both **CLI** and **API**.

|  | **CLI** | **API** |
|---|---|---|
| **Your agent is** | a command you run — laptop, server, anywhere | a service on your own infrastructure |
| **You write** | a normalizer, in TypeScript, here | an HTTP endpoint, in any language |
| **You ship it** | as a pull request to this repo | by deploying it yourself |
| **Start at** | [`cli/src/engines/`](cli/src/engines/README.md) | [`provider/`](provider/README.md) |

To get started, run this:

```bash
curl -fsSL https://harness.autonomous.ai/install.sh | bash -s -- <token>
harness join
```

In the code these are named `engine` (CLI) and `provider` (API) — the folder names you'll see:

```bash
# CLI — typecheck and replay the recorded-session fixtures
cd cli && npm install && npm run typecheck && npm test

# API — run the reference implementation, then check your endpoint against it
cd provider/reference-provider && npm install && npm run dev
npm run conformance -- --url https://your-endpoint --key <credential>
```

## Harness architecture

Your agents stay your processes, on your hardware, with your credentials.

```
                                ( ◉ )   Harness
                                  │
                        ╔═════════╧═════════╗
                        ║   Harness Relay   ║   ciphertext only · we hold no keys
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

## End-to-end encryption

On the CLI path this is not a setting and cannot be turned off. Everything between your machines and
the device is ciphertext by the time it reaches us.

- **Ed25519** identity keys, pinned at first pairing and signing every ephemeral after it.
- A **CPace-style PAKE** over ristretto255 — the six-character pairing code bootstraps a shared
  secret across the untrusted relay, and an attacker gets **one online guess**. There is no offline
  attack on the code.
- **X25519** ephemeral Diffie–Hellman per connection, through HKDF to pairwise session keys.
- A **per-process group key** so one event encrypts once for many readers, carrying its own epoch id.
- **ChaCha20-Poly1305** on every frame, with the associated data binding the frame's type and
  session, so a frame cannot be replayed into a context it was not written for.

Harness Relay stores and forwards. It holds no key material, so it cannot read a prompt, a diff, a
result, or the name of what you are working on — not because of a policy, because it has no keys.

The crypto core is a byte-identical twin of the browser's copy, with a drift-guard test that fails if
the two ever diverge, and committed self-vectors that catch a crypto library changing underneath it.
Read it yourself: [`cli/src/lib/e2ee/`](cli/src/lib/e2ee/).

## Contributing, security, licence

- Adding an agent, or a gap in the spec — [CONTRIBUTING.md](CONTRIBUTING.md).
- Security reports: **not the issue tracker** — [SECURITY.md](SECURITY.md).
- [Apache-2.0](LICENSE).
