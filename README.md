# OpenHarness

**The open-source software and hardware platform for domain-specific harnesses.**

Run Claude Code, Codex, and every other coding agent in persistent terminals on all your machines. Give
them a **domain-specific harness (DSH)** and they design circuit boards, model 3D parts, simulate
robots, and build games in a live viewer. Keep them on your desk with the open-hardware
**Harness device**.

[Run it](#run-it) · [Domain-specific harnesses](#domain-specific-harnesses-dsh) ·
[Harness device](#harness-device) · [Architecture](docs/architecture.md) · [Contribute](#contributing)

<p align="center">
  <img src=".github/assets/hardware/desk-agents.jpg" width="960" alt="The Harness device on a desk beside a keyboard, with the coding agents it runs: Claude Code, Codex, Cursor, OpenCode, Pi, Hermes, Command Code, Devin, Muse Code, Amp, Antigravity, GitHub Copilot, Grok Build and Kilo Code">
</p>

## Coding agents, on every machine

The coding agent is still the heart of the work, and OpenHarness is built around it.

- **Real terminals that outlive the window.** Every agent runs in a persistent tmux session. Close the
  app and the agents keep working; if tmux goes down with a reboot, the daemon brings the panes back and
  resumes the sessions.
- **Every engine, no wrappers.** Claude Code, Codex, Cursor, OpenCode, Pi, Hermes, Command Code, Devin,
  Muse Code, Amp, Kilo, Grok Build, Antigravity and GitHub Copilot. OpenHarness reads the transcript each
  agent already writes and installs the vendor's own hooks. Your credentials stay in `~/.claude`, `~/.codex` and
  so on. See the [engine list](docs/engines.md).
- **All your machines in one window.** The laptop, the Mac mini at home, the server in the rack. Each
  runs a daemon with outbound connections only. Terminal traffic is end-to-end encrypted, the relay only
  forwards ciphertext, and it goes peer to peer over WebRTC when it can. No SSH server, VPN, or open
  port.
- **Built for many agents at once.** Split panes, a keyboard-driven layout, fuzzy search across
  sessions and machines (**⌘O**), and one shortcut to the agents waiting on you (**⇧⌘I**). The
  [workspace guide](docs/app.md) and [keybindings](docs/keyboard.md) cover the rest.

<p align="center">

<img width="1280" height="716" alt="ezgif-3355e1eae4366c76" src="https://github.com/user-attachments/assets/e3401aae-9402-4710-a46d-1da150ff96bf" />


</p>


### Run it

1. [Download the desktop app](https://harness.autonomous.ai/desktop) for macOS or Linux.
2. Sign in to a coding agent you already use, with your own subscription, API key, or local model.
3. Press **⌘N**, pick an agent or a harness, a machine and a project, and start.

On another machine:

```bash
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness login
harness start
```

Then **Machines → Link Machine** in the app.

macOS is the primary tested platform. Linux builds exist and feature parity is in progress; Windows is
work in progress. The app and daemon still need a Harness account to start;
[account-free local use is tracked](docs/development.md#account-free-local-use).

<details>
<summary><b>Build from source</b></summary>

For macOS, install Node.js 20+, tmux, Xcode, and Flutter 3.47+ / Dart 3.13+:

```bash
git clone https://github.com/autonomous-ai/openharness.git
cd openharness
(cd cli && npm ci)
make install-cli
cd desktop
flutter config --enable-swift-package-manager
flutter pub get
flutter run -d macos
```

`make install-cli` installs this checkout's CLI and restarts the local daemon. The
[development guide](docs/development.md) covers tests and isolated environments.

</details>

### How it fits together

```mermaid
flowchart LR
  device["Harness device"] -- USB --> daemon
  app["Harness app<br/>(Flutter)"] -- loopback --> daemon["harness daemon<br/>(TypeScript)"]
  daemon --> tmux["tmux"] --> agents["Claude Code · Codex · OpenCode · …"]
  daemon --> dsh["DSH toolchain<br/>+ live viewer"]
  daemon <-- "E2EE · WebRTC" --> relay["Harness relay"]
  relay <--> remote["daemons on your<br/>other machines"]
```

The [architecture guide](docs/architecture.md) covers the daemon, the session model, transport and
encryption.

## Domain-specific harnesses (DSH)

<img width="1000" height="563" alt="harness" src="https://github.com/user-attachments/assets/25c63335-279a-4f9a-b702-2ffaec2b096f" />


A **domain-specific harness** turns a coding agent into a specialist. It brings the domain's
instructions and skills, a pinned toolchain, a project template, a verdict the app can read, and a
**live viewer** for what the agent makes. You chat on one side; the board, the part, the robot or the
game takes shape on the other, and stays interactive after the agent is done.

A DSH is a folder with a `harness.json`. The agent does the reasoning; the harness brings the tools
and the view. Adding a domain never needs a change to the app or the daemon.

### 18 harnesses today


| Domain | Harnesses |
|---|---|
| CAD | [Autonomous Workshop](store/agents/autonomous-workshop/), [text-to-cad](store/agents/text-to-cad/) |
| 3D | [Blender](store/agents/blender/) |
| Electronics | [Autonomous Circuit](store/agents/autonomous-circuit/), [CircuitJS](store/agents/circuitjs/), [Yosys](store/agents/yosys/) |
| Games | [Godogen](store/agents/godogen/), [Phaser](store/agents/phaser/) |
| Documents and diagrams | [Marp](store/agents/marp/), [Typst](store/agents/typst/), [Excalidraw](store/agents/excalidraw/) |
| Video and music | [OpenMontage](store/agents/openmontage/), [Remotion](store/agents/remotion/), [Manim](store/agents/manim/), [Strudel](store/agents/strudel/) |
| Simulation and analysis | [MuJoCo](store/agents/mujoco/), [RDKit](store/agents/rdkit/), [marimo](store/agents/marimo/) |

Each one wraps an open-source project under its own name, credits it, pins its toolchain, and installs
on a fresh machine from the Harness Store. Eight [shared viewers](store/viewers/) (CAD, 3D models,
documents, games, film, video, MuJoCo, web) mean a new harness rarely needs to write its own.

**The harness we'd love to see next is the one for the tool you use.** KiCad, FreeCAD, OpenSCAD, Godot,
Jupyter, QGIS, Home Assistant, LilyPond, Inkscape — or your own company's toolchain. A harness can live
in this repository or in yours.

<table>
  <tr>
    <td width="33%" valign="top">
      <a href="store/agents/autonomous-circuit/"><img src="store/showcase/autonomous-circuit/six-key-macropad.jpg" alt="A six-key USB macropad PCB in 3D"></a>
      <b>Autonomous Circuit</b><br/><sub><i>“Design a six-key USB macropad. Start with the schematic.”</i> A fab-ready board: RP2040, 43 parts.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="store/agents/text-to-cad/"><img src="store/showcase/text-to-cad/planetary-gear-set.jpg" alt="A planetary gear set in the CAD viewer"></a>
      <b>text-to-cad</b><br/><sub><i>“Design a 3D-printable planetary gear set: a 12-tooth sun, three 18-tooth planets…”</i> Nine parts, zero interference.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="store/agents/mujoco/"><img src="store/showcase/mujoco/g1-humanoid-hello.jpg" alt="A Unitree G1 humanoid waving in MuJoCo"></a>
      <b>MuJoCo</b><br/><sub><i>“Make the Unitree G1 humanoid say hello: stand, raise its right hand and wave…”</i> A 29-servo rollout.</sub>
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <a href="store/agents/blender/"><img src="store/showcase/blender/cozy-reading-nook.jpg" alt="An isometric reading nook rendered in Blender"></a>
      <b>Blender</b><br/><sub><i>“Make a cozy isometric reading nook: a cut-away corner of a room with an armchair…”</i> 122 named objects.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="store/agents/godogen/"><img src="store/showcase/godogen/neon-drift.jpg" alt="A synthwave hoverbike racing game"></a>
      <b>Godogen</b><br/><sub><i>“Make a synthwave hoverbike racer: ride down a neon grid canyon toward a striped setting sun…”</i> Playable in the pane.</sub>
    </td>
    <td width="33%" valign="top">
      <a href="store/agents/manim/"><img src="store/showcase/manim/fourier-knight.jpg" alt="A chess knight traced by Fourier epicycles"></a>
      <b>Manim</b><br/><sub><i>“Draw a chess knight using nothing but spinning circles…”</i> 120 epicycles in gold.</sub>
    </td>
  </tr>
</table>

Every picture is real output from the harness's own toolchain, and the prompt is the one that made it.

### Your first DSH in ten minutes

The [Hello World example](store/examples/hello-world/) is a Codex session that edits an HTML page
shown in the shared Web Viewer:

```text
hello-world/
  harness.json
  AGENTS.md             # instructions for the agent
  template/index.html   # copied into a new project
```

Its manifest connects the pieces:

```json
{
  "spec": 1,
  "id": "examples/hello-world",
  "name": "Hello World",
  "engine": "codex",
  "workspace": {
    "template": "template",
    "marker": "index.html"
  },
  "agent": { "instructions": "AGENTS.md" },
  "viewer": { "use": "autonomous/web-viewer" }
}
```

The CLI and the package protocol call a harness a DSH, so the commands are `harness dsh …`. From this
checkout, with the `harness` CLI installed:

```bash
harness dsh install "$PWD/store/viewers/web-viewer" --link
cp -R store/examples/hello-world ../my-first-harness
harness dsh check ../my-first-harness
harness dsh install ../my-first-harness --link
```

Press **⌘N → Hello World**, choose a new project, and ask it to “Say hello to Ada.” The agent edits
`index.html`; the viewer reloads. Change `AGENTS.md` to try another workflow, then start a new session.
`--link` keeps the package connected to your source directory; Store installs resolve viewer
dependencies on their own.

The [authoring guide](store/README.md) covers the full manifest, toolchains, live progress, verdicts,
store pages, and publishing; the [package specification](store/spec/README.md) is the contract.

| Piece | Responsibility |
|---|---|
| Engine | Runs the coding agent: Claude Code, Codex, OpenCode, and the rest |
| Harness (DSH) | Packages a domain: engine, instructions, toolchain, workspace, and viewer |
| Viewer | Shows and interacts with what the agent makes; shared across harnesses |
| Session | One running agent, in one project, on one machine |

## Harness device

<p align="center">
  <img src=".github/assets/hardware/answer.jpg" width="960" alt="A finger taps the round Harness device to answer an agent that redesigned the billing controls">
</p>

No other agent stack ships this layer. The **Harness device** is a round, always-on display that sits beside
your keyboard and shows your agents at a glance: what each one is doing, which one has finished, and
which one is waiting on you. Read a question and answer it on the screen, or tap and speak a new task,
without switching windows.

It is open hardware, all the way down. This repository has everything it takes to build one:

| Layer | What's here |
|---|---|
| [Firmware](devices/harness-device/firmware/) | ESP32-S3, ESP-IDF, a 466 × 466 round AMOLED with touch, microphones and audio. Connects to the host's daemon over USB — no Wi-Fi setup, no account on the device. |
| [PCB](devices/harness-device/hardware/pcb/) | The EasyEDA Pro project, the schematic, Gerbers, the bill of materials, and pick-and-place data for assembly. |
| [Enclosure](devices/harness-device/hardware/3d/) | STEP for editing and STL for printing: the housing, an iron counterweight base, the USB clamp, and the button. |

[**Get a Harness device**](https://www.autonomous.ai/harness), or build your own from these files. The
[firmware guide](devices/harness-device/firmware/README.md) lists the supported boards and build
commands, and the [hardware guide](devices/harness-device/hardware/README.md) covers the design files.

https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

## Contributing

There are three ways in, one for each layer of the stack.

- **Make a DSH for a tool you use.** Start from Hello World, make one workflow work end to end, pin the
  toolchain, credit the upstream project, and show something worth looking at in the viewer.
- **Improve the coding workspace.** Terminal behavior, engine support, the daemon, the relay, Linux and
  Windows.
- **Hack the hardware.** Port the firmware to another board, remix the enclosure, add a feature to the
  device.

Small fixes and notes about something that didn't work are welcome too. The
[contribution guide](CONTRIBUTING.md) walks through each path.

## Repository map

```text
desktop/    Flutter app and terminal workspace
cli/        TypeScript CLI, daemon, engine adapters, and package runtime
backend/    Relay and control plane
store/      Domain-specific harnesses, shared viewers, registry, examples, and package spec
provider/   Provider API contract, implementations, and conformance tests
devices/    Harness device firmware, PCB, and enclosure
```

- [Development and testing](docs/development.md) · [Extension points](docs/extending.md) · [CLI and automation](docs/cli.md)
- [Desktop](desktop/README.md) · [Daemon](cli/README.md) · [Relay](backend/README.md) · [Provider API](provider/README.md)
- [Security policy](SECURITY.md) · [License](LICENSE)

The repository is MIT licensed unless a folder says otherwise. Upstream tools, models, and assets keep
their own licenses.
