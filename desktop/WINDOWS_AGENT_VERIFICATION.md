# Windows agent verification — 2026-09-18

These checks use the native Windows desktop with its Linux CLI in WSL2 Ubuntu.
A successful `--version` check proves installation and executable startup, not
provider authentication, a completed model turn, or every terminal interaction.
Additional engines used temporary installation directories and fresh test homes.
No model requests were made by these checks.

## Confirmed repairs

- Terminal typing: Windows rejected the native input client because its Flutter
  view ID was missing. A regression failed before the fix; the user confirmed
  physical typing in the rebuilt native widget. Preview 2 includes that repair.
- Claude installation: WSL found a Windows npm shim without Linux Node. The pane
  now selects a complete managed Linux Node/npm pair. Production launch installed
  Claude and returned its version; a repeat launch did not reinstall. The user's
  outer PATH remained unchanged.
- The same repair allows an already-installed Node-shebang engine to start when
  Node is missing from the inherited shell PATH. Native engines remain usable
  without a Node/npm pair.
- Copilot discovery: the inherited Windows npm launcher resolved in WSL but could
  not run with the managed Linux runtime. Copilot candidates now have a bounded
  `--version` health check; missing or broken installations use GitHub's standalone
  native installer under `~/.local`.

## Executable checks

| Agent | Version | Evidence |
|---|---|---|
| Claude Code | 2.1.277 | Production install and repeated startup passed |
| Codex | 0.154.0 / 0.155.1 | Existing Windows interop and isolated Linux startup passed |
| Cursor | 2026.09.15-d2fe57e | Existing Linux startup passed |
| OpenCode | 1.18.31 | Isolated Linux install/startup passed |
| Pi | 0.85.1 | Isolated Linux install/startup passed |
| Command Code | 1.56.2 | Isolated Linux install/startup passed |
| Kilo | 7.7.5 | Isolated Linux install/startup passed |
| Copilot | 1.0.86 | Production native install and repeated startup passed |
| Devin | 3000.10.31 | Isolated Linux install/startup passed |
| Muse | 1.3.0 | Isolated Linux install/startup passed |
| Amp | 0.0.1789764455-g07cced | Isolated Linux install/startup passed |
| Grok | 1.0.34 | Isolated Linux binary startup passed; installer caveat below |
| AGY | 1.2.6 | Isolated Linux install/startup passed |
| Hermes | — | Blocked: installer attempted to install system compiler packages |

Credential-free terminal startup probes displayed live interfaces or onboarding
for Claude, Codex, Cursor, OpenCode, Pi, Command Code, and Kilo. OpenCode and Kilo
needed longer than the initial ten-second observation window; a 45-second window
displayed their prompts. These were disposable tmux sessions, not user sessions.

Vendor installer behavior matters: Devin immediately opens interactive setup;
the test stopped before authentication. Hermes tried to install `build-essential`
on this minimal WSL distribution, so its qualification stopped. Grok created two
global symlinks when run as WSL root despite an isolated install directory; their
exact targets were verified and both links removed. Use vendor setup instructions
and a normal development user; do not assume every installer stays inside HOME.

## Automated checks

The keyboard release passed 1,723 Flutter tests with 15 platform/fixture skips.
The targeted keyboard/focus/IME checks passed 30 tests. Claude's launch regressions
failed before the repair and passed afterward, including the native-engine control.

The engine adapter, lookup, installation, launch, and hook checks exercised 464
unique passing cases across three focused batches. This includes 23 SQLite cases
that originally skipped: a temporary extracted SQLite tool enabled them without a
system package installation. The remaining two skips are the explicitly gated
Cursor authenticated E2E test and a retired Herdr case.

Five real tmux transport tests passed on an isolated server: snapshots and output,
typing, ordered multi-chunk paste, resizing, and catalog-wide stream-manager
coverage. The catalog-wide test uses fixture processes; it does not prove model
responses from all vendors.

Earlier whole-CLI baseline limitations are recorded in `WINDOWS_PORT.md` and the
preview 1 release. This report does not claim the full CLI suite is green, fresh
browser sign-in in the final GUI, a clean-machine installation, or macOS/Linux
desktop qualification.
