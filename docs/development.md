# Development

## Repository layout

```
desktop/    the app (Flutter; macOS first). third_party/xterm is the patched terminal core
cli/        the harness daemon and CLI (TypeScript, one bundle). src/engines/ is one folder per engine
backend/    the relay (Node, Prisma/MongoDB, Redis)
provider/   the API-provider spec, reference and example providers, conformance runner
device/     firmware for the Harness device (ESP-IDF, device/harness)
store/      harnesses, shared viewers, the registry, Hello World, starter, schemas, and author tools
```

For your first contribution, [build a harness](../CONTRIBUTING.md#your-first-harness). You can
check and install a package with the released CLI without building the platform.

## Platform support

macOS is the primary supported and tested desktop experience. Linux builds and a Windows runner
exist, but full Linux and Windows support remains work in progress. Embedded harness webviews
currently run only on macOS; platform code being present does not imply feature parity.
Harness authors should list the operating systems and tool versions they actually tested.

## Account-free local use

**Outstanding requirement:** someone should be able to open the desktop app, start local sessions,
and use locally installed harnesses without an OpenHarness account. Sign-in should be needed only
when they choose to link remote machines. The engine may still require its own account or API key.

The current source does not meet that requirement: desktop bootstrap checks
`cliLogin.checkStatus()` in `desktop/lib/state/app_state.dart`, and `startCommand` in
`cli/src/cli.ts` refuses to start without a saved sign-in session. Removing one screen alone
will not provide a working local mode.

Completion should be verified with a clean local profile: start the daemon and app without saved
account credentials, create and resume a local session, then sign in and link a remote machine
without losing that work. Cancelling remote sign-in or signing out must leave local work usable.
This is tracked work, not a claim that account-free startup is already available.

## Build and test

```bash
# cli
cd cli && npm install && npm run typecheck && npm test
make install-cli          # bundle this tree into ~/.harness/cli and restart the daemon on it

# desktop (Flutter ≥ 3.47 / Dart ≥ 3.13; SPM on for macOS)
cd desktop && flutter pub get && flutter analyze && flutter test
flutter run -d macos      # or -d linux

# backend
cd backend && npm install && npm run typecheck && npm test

# provider
cd provider/e2e && npm install && npm test

# device
make device-test
```

Each product releases on its own tag and the suffix routes the workflow: `vX.Y.Z_cli` bundles and
publishes the daemon (running daemons pick it up within a minute), `vX.Y.Z_backend` builds the image,
`vX.Y.Z_desktop` builds, signs and publishes both macOS bundles and both Linux architectures.
`make release-cli|release-backend|release-desktop` cut them; `make upload-circle` publishes device
firmware for USB delivery through the host. `ci.yml` runs the CLI suite on demand (Actions -> CI -> Run workflow) and holds
no secrets, which is what lets it run on a fork's branch.
`make remote-machine`
brings up a second machine in Docker so the remote path can be exercised from one laptop.

## Isolated end-to-end testing

With Node, tmux, Flutter and a running Docker engine, run from the repository root:

```bash
(cd cli && npm ci)
(cd backend && npm ci)
(cd desktop && flutter pub get && bash scripts/test-terminal-local-e2e.sh)
```

The runner creates disposable MongoDB and Redis containers, a backend, a daemon, identities,
projects and a dedicated tmux server. It exercises both local and encrypted backend connections,
including creation retries, terminal input and resize, reconnect, agent/daemon restart, deletion,
and domain harness workspace/viewer/verdict recovery. The identity service and model CLI are
fixtures; it needs no real account and does not replace the running Harness daemon or engine hooks.
It cleans up its processes and containers when finished.

Set `HARNESS_E2E_DOCKER_CONTEXT` to use a separate Docker context. Set `HARNESS_STACK_KEEP=1` to
retain fixture logs and files for debugging; services and containers still stop. The test is
explicitly skipped in a plain `flutter test` run and exercised by the script above.

For the backend-to-provider chain, install dependencies in `provider/reference-provider`, then
run `PROVIDER_E2E=1 npm test` in `backend`. The cross-implementation provider suite in `provider/e2e`
also needs dependencies installed in `provider/example-provider`.

See [the reliability run](reliability-2026-09-16.md) for verified coverage and remaining limits.
