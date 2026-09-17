# Reliability run — 2026-09-16

This run used an isolated checkout on macOS with Node 22, Flutter 3.47 and tmux 3.5a. It integrated
upstream through `4dd0705`, including daily machine-presence tracking, the P2P promotion relay fix
and the domain harness doctor timeout change. Later documentation-only updates were also pulled.
The user's existing daemon, agents, account files, engine hooks and Docker contexts were preserved.

## Fixes found by testing

- Serialize pane theme updates so concurrent inventory scans cannot duplicate writes or apply an
  older theme after a new one.
- Recover the New Agent form after an unsupported domain harness probe; restore keyboard focus
  when a local folder dialog is cancelled; preserve an explicit engine choice and Codex profile
  when a delayed probe finishes.
- Reattach agents in their existing tabs after reconnect. Previously the first recovered agent
  could also be inserted into the active tab, changing its layout and focus.
- Handle asynchronous errors from the tmux control client's input pipe. A shutdown or failed write
  previously reached the daemon's uncaught-exception guard.
- Repair stale UI assertions, the obsolete local end-to-end runner, provider integration paths,
  test routing mocks and provider process cleanup. Bound CLI test workers to avoid starving the
  child processes whose correctness those tests verify.

## Results

| Suite | Result |
| --- | --- |
| CLI type check and default suite (`make cli-test`) | 2,325 passed; 51 conditional tests skipped |
| Backend type check and suite, with `PROVIDER_E2E=1` | 370 passed |
| Desktop suite, with `REMOTE_MEDIA_CLI_ROOT` | 1,686 passed; isolated stack entry skipped here and run separately |
| Native macOS terminal integration | 2 passed |
| Isolated desktop/backend/daemon stack | 5 passed |
| Reference provider | 53 passed; type check passed |
| Example provider | 80 passed; type check passed |
| Cross-provider conformance and flow integration | 74 passed; type check passed |
| Installed-engine discovery with a private real tmux server | 9 passed; 8 engine rows unavailable |
| Real tmux streaming, snapshots, paste and resize | 5 passed |
| Device host-side tests | 44 frame checks, 34 machine checks, carousel and board suites passed |

Desktop analysis reports 12 existing informational lint messages in vendored xterm code, with no
errors or warnings. The stack fixture also passes its standalone TypeScript check and the shell
runner passes syntax validation.

## What the end-to-end run verifies

The desktop's real connection and terminal session code communicates with a real daemon and tmux.
The remote route also crosses the backend, MongoDB and Redis, using a signed E2EE handshake and
encrypted terminal frames through the production relay crypto implementation.

Both routes verify create, retry without duplication, Unicode input/echo, a server-produced resize
keyframe, reconnect, agent restart, daemon restart with identity retained, and deletion. The domain
harness case installs a fixture, materializes its template/instructions/skills, serves its viewer,
propagates a verdict, and restores that state after daemon and agent restarts. Daemon logs are
checked for uncaught exceptions.

The desktop suite also exercises image/video download across encrypted WebSocket hops, byte
integrity, cancellation cleanup and interrupted transfers. Native terminal tests cover keyframe
replacement and input/scroll behavior. Real installed-engine discovery covers Claude Code, Codex,
OpenCode, Pi, Hermes and Grok, plus process deletion and literal input handling.

## Limits and remaining verification

These results do not establish 100% coverage of every deployed environment.

- Full-stack sign-in and model responses use deterministic fixtures. Real OAuth, paid model
  completions and public internet outages were not exercised. The remote stack is local and
  isolated; it is not a test between the user's physical machines.
- The live Cloudflare TURN test needs credentials. Production TURN-to-direct handoff was covered
  by protocol tests, not a live relay session.
- The installed-engine matrix could not verify Cursor, Command Code, Devin, Muse, Amp, Kilo,
  Antigravity or Copilot executables. Herdr was unavailable. The account-dependent Cursor suite,
  which rewrites real hooks, was left unrun. Conditional platform-specific tests remain skipped.
- Physical device controls, OTA updates, Linux native rendering and actual domain-specific model
  workflows were not rerun. Device coverage here is host-side; domain harness coverage uses a
  deterministic example.
- Remote domain harness viewer tunneling and Linux domain harness webview support are existing
  implementation gaps documented in `store/PLAN.md`, outside this reliability fix.

Repeat the isolated stack using [the development instructions](development.md#isolated-end-to-end-testing).
