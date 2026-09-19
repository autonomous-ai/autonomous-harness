# Windows 11 support

The Flutter desktop runs natively on Windows 11 x64. Its local CLI, managed Linux
Node runtime, and tmux run in a named WSL2 development distribution. Windows is a
full peer with local discovery and loopback transport; an explicitly requested
`HARNESS_VIEWER_MODE=true` build retains relay-only viewer behavior.

## Scope

- Setup discovers WSL development distributions and excludes Docker Desktop's
  internal distributions. Installing WSL and creating its Linux user remain
  attended steps. Recheck does not install software.
- CLI commands use explicit distribution selection and argument-preserving WSL
  invocation. Probe output supports UTF-16LE, and owned subprocess waits are bounded.
- Local projects are resolved against the backend filesystem. Drive conversion
  assumes the default `/mnt/<drive>` mounts; the folder browser handles other
  layouts. WSL UNC paths must name the selected distribution.
- Process discovery repairs Windows-interoperated agent rows from Linux `/proc`,
  preserving argument boundaries and executable identity. The broader fork-only
  resume/permission evidence gates are excluded to retain upstream's non-Linux
  behavior.
- Terminal input supplies Flutter's owning view ID, required by the Windows text
  input plugin. Claude installation can use the managed Linux Node/npm pair;
  broken Copilot launchers are rejected and its native installer used instead.
- Packaging includes a matching CLI and hook, MSVC runtime files, source revision,
  checksum and licenses. Windows desktop and bundled CLI updates are manual.

## Verification and limits

See [agent verification](WINDOWS_AGENT_VERIFICATION.md) for the September 18
installation and executable-startup checks. Those results do not establish
provider authentication or successful model turns for every engine.

The fork's attended Windows session exercised setup, browser sign-in, project and
agent creation, terminal input and reconnect. The user also confirmed physical
keyboard input after the view-ID repair. These are historical host-specific
checks, not a fresh-machine qualification of this upstream submission.

The upstream submission's current checks are reported in its pull request.
The newer upstream desktop suite has Windows-specific baseline failures; test
counts from older preview releases must not be treated as current full-suite
success. macOS/Linux desktop builds have not been run on their native hosts.

Windows signing, automatic updates, alternative WSL networking arrangements and
clean-machine qualification remain open. Many shortcuts still use Meta/Windows;
Ctrl+Tab and Ctrl+Shift+Tab switch panes. Embedded harness viewers remain macOS-only.
