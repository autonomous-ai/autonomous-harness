# Harness Desktop

Harness Desktop is the native Flutter client for browsing Harness machines and
interacting with their terminal-backed agents. It runs natively on **macOS
and Linux (Ubuntu)** and includes an unexercised Windows runner.

## Development

Install a compatible Flutter SDK, then run the project from this repository
root:

```bash
flutter pub get
flutter test
flutter run -d macos   # or: flutter run -d linux
```

Useful validation commands:

```bash
dart analyze
flutter build macos --debug
flutter build macos --release
flutter build linux --release   # must run on an Ubuntu host — no cross-compiling
```

The terminal core is vendored at `third_party/xterm`. Do not replace it with an
upstream package upgrade without preserving the local rendering and IME fixes.

## Open media from agent output

Hold **⌘ and click** on macOS, or **Ctrl and click** on Linux, to open an
image/video path in the OS default app. HTTP(S) links open in the default browser.
Hover over a recognized path to see the shortcut and full target. Normal clicks,
text selection, copy/paste and terminal mouse input keep their existing behavior.

Local previews support absolute paths, `~/...` and `file://...` URLs, including
spaces, Unicode, visible Markdown links and terminal soft wraps. The file must
already exist. Relative paths need a full path because CLI agent frames do not
currently include the working directory.

For a remote agent, the same shortcut downloads the file over the existing E2EE
connection and opens the completed local copy in the OS viewer. The remote
machine must run a CLI advertising `mediaPreview`; older CLIs show update guidance.
Remote relative paths resolve inside that agent's working folder; absolute paths,
`~/...`, and `file://...` resolve on the remote machine, including artifacts in `/tmp`.
The pane shows download progress and Cancel. Closing/changing panes cancels the
download. An interrupted transfer or a file changed during transfer is never opened.

Previews are limited to 512 MiB per file and downloaded in bounded chunks. Copies
live in `~/.harness/desktop-app/media-previews`; before each download, inactive
copies older than 24 hours or over the 1 GiB cache budget are pruned. Cache names
are unique, so matching paths on different machines cannot overwrite one another.
This reads visible terminal text, not hidden OSC 8 hyperlink targets.

The optional A/B smoke test uses isolated identities, two loopback WebSockets,
the CLI's real E2EE handshake/media reader and ffmpeg-generated PNG/MP4 fixtures:

```bash
REMOTE_MEDIA_CLI_ROOT=../autonomous-harness/cli flutter test test/remote_media_smoke_test.dart
```

Install the companion CLI's npm dependencies first; ffmpeg must be on PATH.
The smoke test does not use a real account or remote machine. It verifies the OS
launch URI; playback in the native viewer is a separate manual check.

## Local Codex profiles

New Agent → Codex discovers local profiles when the Harness CLI advertises
`supportsCodexHome`. The picker appears only when there are at least two distinct
profile folders; **Default** does not count as another profile. A single profile
is selected automatically, while no profiles keeps the normal launch. Linking
and refreshing remain available in both cases.

Discovery combines `CODEX_HOME` from the app environment, homes
observed on this computer's Codex agents, Codex-named folders in home/XDG config
with an existing `auth.json` or `config.toml` (including `.codex2` and
`.codex_work`), and directories explicitly linked before. An empty default
directory does not create a second profile.
It also reads literal `CODEX_HOME` declarations in bash/zsh/fish startup files,
aliases, functions, sourced files, and executable shell wrappers in local bin/PATH
directories. Shortcut names do not have to contain "codex". `$HOME`, `${HOME}`,
tilde and simple directory variables are supported; symlinks are deduplicated.

Discovery never executes shell configuration or shortcuts and never reads Codex
credentials. Shell scanning stops after 3 seconds, 256 small scripts, or four
levels of script references. Computed paths, unsupported shell syntax and profiles outside
these sources can be added with **Link a profile folder…**. Choose the actual
`CODEX_HOME` directory, not the shortcut executable or a named configuration
preset. Only linked paths are saved. **Refresh profiles** rescans without changing
the current choice; new local agent homes also update an open picker.

The selected directory supplies that agent’s Codex login, configuration, hooks,
history and model cache, and stays attached across restarts. The terminal header
shows its folder name and exposes the full path in a tooltip. **Default** keeps
the machine’s normal launch behavior. This picker applies to local agents using
Codex’s own account; remote machines use their existing flow.
The rail’s Codex usage panel still reports the default `~/.codex` profile.

This requires the companion CLI support for `agent_create.codexHome`. Older CLIs
show update guidance and keep default launches available; Desktop refuses an
explicit profile when support is missing rather than silently using another login.

## Local and production terminal E2E

The terminal E2E scripts exercise this desktop client together with source
checkouts of the Harness backend and CLI. The CLI is this repo's own `cli/`;
the backend is a sibling `autonomous-code` checkout. Their default layout is:

```text
.../autonomous-ai/
  autonomous-code/
  autonomous-harness/
    cli/
    backend/
    desktop/        <- this app
```

Set `AUTONOMOUS_CODE_ROOT` when the backend checkout is elsewhere and
`HARNESS_REPO_ROOT` when the Harness CLI checkout is elsewhere (it defaults to
this repo's root, i.e. `desktop/..`).

```bash
bash scripts/start-terminal-local-manual.sh
bash scripts/test-terminal-local-e2e.sh
PROD_TERMINAL_E2E=1 ... bash scripts/test-terminal-prod-e2e.sh
```

The production script deliberately requires release, deployment, machine, and
commit evidence before it sends terminal traffic to production.

## Autonomous device pairing

Settings → Devices discovers Autonomous devices on the same network using the
CLI's `_autonomous._tcp` discovery, reusing the device's existing advertisement. Start pairing on the Autonomous
device to generate its code, select that device in Desktop, and enter the code.
The Mac connects directly to the selected device without backend routing or a
manually entered IP address. The device needs no backend credentials; Harness’s
existing Mac login/start requirements remain unchanged.

The pairing form is one shared settings row: device picker with an adjacent refresh
icon, code field and Pair button. The form aligns with the title at the top; a
visible note explains that closing Desktop leaves the connection running.

Desktop uses `harness autonomous-device discover --json` to populate the picker.
The CLI resolves the selected discovery ID to its host and port. Pairing runs
`harness autonomous-device pair --code-stdin --device <discoveryId> --json` through
`HarnessCliRunner`; the code travels through stdin only, never argv or logs.
Code normalization matches the original Harness pairing implementation, including
Crockford aliases and separators. The original PAKE handshake authenticates the
connection. Changing or losing the selected discovery identity clears entered
code, and a code mismatch remains visible through background refreshes. A mismatch
consumes the device pairing window: generate a new code before retrying. Rate
limits require waiting five minutes before another attempt. Desktop allows the
pair command fifty seconds to finish, beyond the CLI’s bounded handshake deadline.

`status` and `list` report direct connections and saved device identities.
Revocation requires confirmation and targets the complete saved fingerprint.
Closing Desktop leaves the CLI daemon running. Discovery and status refresh every sixty seconds, including when no device is
paired. Use Refresh to discover a newly started device immediately. Pasted codes
may include separators, for example `ABC-123`. Older CLIs show `harness update`
guidance. Widget tests inject a fake CLI, and the `kUnderTest` gate prevents real
processes and background polling.

## Releases

The application self-updates from the Harness desktop metadata manifest in the
public GCS release bucket. Release commands stay in this repository:

```bash
make upload-desktop           # macOS
make upload-desktop-linux     # Linux (ARM64 or x64) — must run on the matching Ubuntu build host
make upload-desktop-linux ARCH=arm64
make upload-desktop-linux ARCH=amd64  # amd64 is the x64 artifact
make upload-node-runtime ARGS="22.23.2"
```

See [RELEASE.md](RELEASE.md) for signing, notarization, versioning, managed
Node runtime publishing, safe test releases, and rollback behavior.

Pairing failures use the original Harness manager's validation and attempt limits.
If the device code expires, start pairing again on the Autonomous device.
