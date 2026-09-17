# How it works

```
                                ( ◉ )   Harness device (USB)
                                  │
   ┌─────────── this computer ───────────┐
   │  Harness app ── loopback ──▶ harness daemon ──▶ tmux ──▶ claude · codex · …   │
   └──────────────────────────────┬──────┘
                                  │ WebSocket (E2EE)
                        ╔═════════╧═════════╗
                        ║   Harness Relay   ║   store and forward, no keys
                        ╚═════════╤═════════╝
          ┌───────────────────────┼───────────────────────┐
     your server             your platform            harness.autonomous.ai
   harness daemon            your HTTP API             the web client
   tmux · hermes · muse      (provider)                (paired browser)
          ▲
          └── terminal traffic goes direct over WebRTC when ICE succeeds
```

**The daemon** runs detached under your account. Every five seconds it reconciles the `harness-*`
tmux sessions with its registry; a pane has to be missing on two scans before its agent is marked
gone. It tails each agent's transcript with a byte offset (JSONL for most engines, SQLite for
OpenCode, Kilo, Hermes and Devin) and turns lines into a normalized event stream: turn started,
tool call, sub-agent, question, turn ended. Hooks it installs into the vendor CLI tell it about
session start, prompt submit and stop. Every five minutes it re-reads engine configs and pane
footers to keep model and effort right. On start it restores panes that died with the tmux server,
and it self-updates from a signed manifest, swapping the bundle atomically.

**The session model.** The registry (`~/.harness/cli/data/registry.json`, mode 0600) is the source of
truth for agents: engine, working directory, tmux pane, bound transcript, process identity. Layouts
belong to the app. The relay stores machine records, agent names and daily counters, never a
transcript, a recap or a keystroke.

**Transport.** Each daemon holds one WebSocket to the relay, authenticated with its SSO token.
Terminal bytes ride a binary channel on that socket until a WebRTC data channel negotiates, then move
to it. Encryption is on for every path and has no switch:

- **Ed25519** identity keys, pinned at first pairing and signing every ephemeral after it.
- A **CPace-style PAKE** over ristretto255 — the six-character pairing code bootstraps a shared secret
  across the untrusted relay, and an attacker gets one online guess.
- **X25519** ephemeral Diffie–Hellman per connection, through HKDF to pairwise session keys.
- A **per-process group key** so one event encrypts once for many readers.
- **ChaCha20-Poly1305** on every frame, with the associated data binding frame type and session.

The crypto core lives in [`cli/src/lib/e2ee/`](cli/src/lib/e2ee/) and is a byte-identical twin of the
browser's copy, with a drift-guard test and committed self-vectors.

## Providers, relay, web

- **`provider/`** — the spec ([`spec/README.md`](provider/spec/README.md)), the deterministic
  [`reference-provider`](provider/reference-provider/) with the conformance runner on port 4319, and
  [`example-provider`](provider/example-provider/), a real one backed by the local `claude` CLI on
  port 4502 (read its README before running it; it skips permissions). `provider/e2e` runs both.
- **`backend/`** — the relay: Node, MongoDB via Prisma, Redis. It terminates four WebSocket paths
  (`/api/adapter-ws` for daemons, `/api/web-ws`, `/api/device-ws`, `/api/manager-ws`), signals WebRTC
  and hands out STUN/TURN, and persists machines, agent names and counters. `npm install && npm run
  dev` on `:8085`; [`backend/README.md`](backend/README.md) and `.env.example` for the rest.
  `harness-api.autonomous.ai` is the hosted instance.
- **The web client** at [harness.autonomous.ai](https://harness.autonomous.ai) reaches the same
  machines from a browser after `harness pair <code>` or a `harness browser-link`. It is not in this
  repository; it also hosts the CLI installer and the desktop downloads.

## The Harness device

A round 466×466 AMOLED with touch and a far-field microphone, USB-C on the bottom edge. It has no
WiFi and holds no credential. It is served entirely over the cable by the daemon on the computer it is
plugged into; plugging it in is the authorization. The wire is one USB serial device (`303a:1001`),
framed as `A5 5A | ver | type | len | payload | crc16` with a JSON vocabulary, a five-second ping,
and a hard 8 KiB frame ceiling.

What it shows: your agents as tiles in the order of the window's panes, with what each is doing and
for how long; a wheel of your machines; the agent's own question when it asks one, answerable with a
tap; the recap when a turn finishes, with one quiet tone. Scroll the face to scroll the terminal.
Double-tap and speak to send a task: the audio goes to the daemon as PCM, comes back as a transcript,
and Boss mode routes it. A voice turn can carry a mode — `/goal` runs an instruction to done,
`/loop` on a schedule — adapted per engine; `/loop` is Claude Code only today.

Firmware updates travel over the same cable in 16 KB credit windows, offered from the published
metadata and never for a dev build. `harness flash` re-flashes a device from a USB port. The firmware
is ESP-IDF ≥ 5.5 under [`device/harness/`](device/harness/) (`idf.py set-target esp32s3 &&
idf.py build`); `make device-test` runs the host-side tests with no board attached.
