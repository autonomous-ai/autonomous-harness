# OpenHarness for Windows 11 — community preview

The native Windows interface uses a Linux CLI and tmux inside WSL2. Agent
accounts remain separate. Build a matching desktop/CLI bundle from this revision
using the instructions in the desktop README. Historical community builds are
available from the contributor's fork; their release notes identify their source
revision and do not imply that every change in this branch is included.

## Download and start

1. Download the Windows x64 ZIP and its `.sha256` file from
   [community preview releases](https://github.com/mcs-eng/autonomous-harness/releases).
2. Extract the entire ZIP to a permanent local folder. Keep `Release/harness.exe`,
   `data`, the DLLs, and `harness-cli` together. Do not run it inside the ZIP.
3. Open `Release/harness.exe`. The preview is unsigned; Windows may warn about an
   unknown publisher. Review the source and checksum before deciding to run it.
4. Follow the setup screen, then select **Sign in** and finish in your browser.
5. Create a project and agent. Install and authenticate the coding agent in the
   selected development distribution if its engine is missing. Prefer native Linux
   agent installations; WSL interop discovery is also supported.

To compare the downloaded archive with its checksum in Windows PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 .\harness-desktop-windows-x64-1.0.0-windows.1.zip
Get-Content .\harness-desktop-windows-x64-1.0.0-windows.1.zip.sha256
```

## Prerequisites

Windows 11 x64, virtualization enabled, internet access, and a WSL2 Ubuntu
development distribution are required. If WSL is absent, run this in an elevated
Windows PowerShell and finish Ubuntu's user setup after any requested restart:

```powershell
wsl --install -d Ubuntu
```

Docker Desktop's internal distributions are excluded. Setup installs tmux and the
managed Linux Node runtime through the upstream installer. The app runs the
**matching CLI included in this ZIP**, with its automatic updates disabled; it
does not replace your standalone `harness` launcher. Keep this folder in place
while the app or its agents are running.

## Replacing an older preview

The source includes repairs for terminal typing, Claude installation when WSL
inherits Windows npm without Linux Node, and broken Copilot npm launchers.
Use a bundle built from the corresponding source revision to receive those fixes.

Close the old Harness window. If a previous Harness daemon is running, stop that
daemon from its WSL distribution (`harness stop`) before opening the new preview.
This stops the connection service; do not kill your tmux sessions or delete
`~/.harness`. Existing authentication and session data stay in the distribution.
Then open the new extracted `Release/harness.exe`, not an old shortcut or an
executable under a build scratch directory.

The September 15 prototype loses WSL command arguments and can show **Bad state:
Sign-in did not complete**. Retrying sign-in in that old executable cannot fix it.

## Preview limitations and recovery

- Windows desktop and bundled CLI updates are manual: download a new complete ZIP.
- WSL2 Ubuntu with normal Windows localhost forwarding is the supported setup.
  Other distributions, custom networking and clean-machine configurations require
  further validation. This preview is not a broad Windows compatibility guarantee.
- Keep the terminal focused when typing. If another client owns input, choose
  **Take control**. Some shortcuts still use the Windows/Meta key; Ctrl+Tab and
  Ctrl+Shift+Tab switch panes.
- Use the backend folder browser for Linux projects. Drive conversion assumes
  WSL's normal `/mnt/<drive>` mounts.
- See [agent verification](WINDOWS_AGENT_VERIFICATION.md) for tested versions and
  the distinction between executable startup and authenticated model turns.
- Roll back by closing this preview, stopping its daemon, and opening your previous
  complete bundle. Do not delete authentication, projects, or tmux sessions.

Report a problem at the fork's issue tracker with the preview version,
`source-commit.txt`, Windows/WSL versions, and redacted error text. Do not upload
credentials, authentication files, or unredacted logs.
