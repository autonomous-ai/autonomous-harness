# OpenHarness

**An open-source framework for building, sharing, and running AI harnesses. Built by everyone, for everyone.**

Design your first 3D model. Make a circuit board. Build a game. Create something you couldn't make
before. **Agent + viewer = harness.** The agent gets the instructions, tools, and workspace for a new craft;
the viewer lets you watch the result take shape.

Choose your engine. Install the harnesses you need. Run them on your own computers. Build the next
one and share it with everyone. The app, framework, and device firmware are open source under [MIT](LICENSE).

[Get started](#get-started) · [Build your first harness](#build-your-first-harness) ·
[Contribute](CONTRIBUTING.md) · [Documentation](#documentation)

<p align="center">
  <img src=".github/assets/screenshots/harness.gif" width="960" alt="Coding agents side by side, a 3D case taking shape in CAD, a circuit board shown as a schematic and in 3D, and a live slide deck—all beside the terminals creating them">
</p>

## More harnesses. More superpowers.

The [Harness Store](store/README.md) already includes these capabilities. Pick one, give it a
project, and start making. Add and remove harnesses as your interests change.

| What would you like to make? | Harnesses to explore |
|---|---|
| A printable part or a product prototype | [Autonomous Workshop](store/agents/autonomous-workshop/), [text-to-cad](store/agents/text-to-cad/) |
| A 3D scene or animation | [Blender](store/agents/blender/) |
| A circuit board, simulated circuit, or digital chip | [Autonomous Circuit](store/agents/autonomous-circuit/), [CircuitJS](store/agents/circuitjs/), [Yosys](store/agents/yosys/) |
| A game you can play | [Phaser](store/agents/phaser/) |
| A keynote, document, or diagram | [Marp](store/agents/marp/), [Typst](store/agents/typst/), [Excalidraw](store/agents/excalidraw/) |
| A video, mathematical animation, or music | [Remotion](store/agents/remotion/), [Manim](store/agents/manim/), [Strudel](store/agents/strudel/) |
| A robot simulation, molecular model, or interactive notebook | [MuJoCo](store/agents/mujoco/), [RDKit](store/agents/rdkit/), [marimo](store/agents/marimo/) |

Use **Codex, Claude Code, OpenCode**, or another [supported coding engine](docs/engines.md).
Each specialized harness declares the engine it uses. Your engine keeps its own login, configuration,
and model access; OpenHarness adds the workspace around it. Shared viewers are installed as
dependencies and reused by other harnesses on the same machine.

These capabilities build on the work of upstream open-source communities. The Store credits their
authors and links to their projects. Each project's own license still applies.

## Get started

1. [Download the app](https://harness.autonomous.ai/desktop).
2. Open the Harness Store and choose something you want to make. Set up the coding engine it uses
   with your own subscription, API key, or supported local model configuration.
3. Press **⌘N**, choose a harness, machine, and project, then create your session.

**macOS first.** macOS is our primary supported and tested desktop experience. Linux builds exist,
but feature parity is still in progress; Windows support is planned. Embedded harness viewers
currently work on macOS. Individual harnesses may have additional toolchain requirements.

**Current limitation:** startup still requires sign-in. [Account-free local use is an outstanding
requirement](docs/development.md#account-free-local-use): sign-in should only be needed when you
link remote machines. Your coding engine's own authentication is separate.

<details>
<summary>Build and run from source</summary>

You will need Node.js 20+, tmux, Xcode, and Flutter 3.47+ with Dart 3.13+ for macOS.
The repository currently lives at the URL below; clone it into a folder called `openharness`.

```bash
git clone https://github.com/autonomous-ai/autonomous-harness.git openharness
cd openharness
(cd cli && npm ci)
make install-cli
cd desktop
flutter config --enable-swift-package-manager
flutter pub get
flutter run -d macos
```

`make install-cli` installs this checkout's CLI and restarts the local daemon. See the
[development guide](docs/development.md) for isolated testing and the other packages.

</details>

## Build your first harness

**Your first harness can be a greeting in a live preview.** You don't need to change the desktop
app or learn its codebase. The [Hello World example](store/examples/hello-world/) contains:

```text
hello-world/
  harness.json          the agent, instructions, and shared viewer
  AGENTS.md             what this harness helps someone do
  template/index.html   the page you will see beside the terminal
```

From a checkout, with the `harness` CLI installed:

```bash
harness dsh install "$PWD/store/viewers/web-viewer" --link
cp -R store/examples/hello-world ../my-first-harness
harness dsh check ../my-first-harness
harness dsh install ../my-first-harness --link
```

The first command links the shared viewer from this checkout; Store installs resolve viewer
dependencies automatically. The connection is declared in `harness.json`:

```json
"viewer": { "use": "autonomous/web-viewer" }
```

Open **⌘N → Hello World**, choose a new project, and ask **“Say hello to Ada.”** Codex edits
`index.html`, and the greeting changes in the built-in Web Viewer beside it. Change the instructions
to teach it your own craft, then start a fresh session to try them. Add skills, setup scripts, or
checks when you need them; the viewer is already shared with other harnesses.

The terms describe different parts of the same experience:

| Term | Meaning | Example |
|---|---|---|
| **Engine** | The coding agent that does the work | Codex |
| **Viewer** | The preview that shows what the agent makes | A 3D viewport |
| **Harness** | An agent and viewer packaged for a craft | Autonomous Workshop for CAD |
| **Session** | One running instance in a project, on a machine | Designing your phone stand |

The [`harness dsh` commands](store/README.md) keep their existing name; DSH means domain-specific
harness. [The contribution guide](CONTRIBUTING.md#your-first-harness) takes you from Hello World to
a harness other people can install from your repository or find in the Store.

## A terminal you already know

Native Flutter, real terminals, persistent tmux sessions. Keep your familiar CLI workflows and
bring several agents together in one window, with their outputs beside them.

| Shortcut | What it does |
|---|---|
| **⌘N** | Start a harness: choose what, where, and which project |
| **⌘O** | Fuzzy-find sessions, projects, tabs, and machines; type `>` for commands |
| **⌘H / J / K / L** | Move between panes |
| **⌘Enter** | Zoom a pane, then return to the layout |
| **⌘R / ⌘D** | Split right / down |
| **⌘S** | Choose a layout |
| **⇧⌘I** | Find agents waiting for your attention |

Your sessions live on the machine, independently of the window. Close the app and return to your
work. [Customize your keybindings](docs/keyboard.md) or explore the [workspace guide](docs/app.md).

## Your machines, together

Use your laptop, the Mac mini at home, and a remote workstation from the same window. Each machine
runs a daemon that connects outward: no SSH setup, VPN, or inbound port forwarding.

Linked machines use end-to-end encryption for terminal traffic. The relay forwards ciphertext;
direct WebRTC connections are used when available. Sign in and explicitly link the machines you
want to use. [How the connection works](docs/architecture.md).

On another supported machine:

```bash
curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash
harness login
harness start
```

Then use **Machines → Link Machine** in the app.

## Open firmware. Your hardware.

A round USB display brings your agents onto your desk: see their progress, answer questions, and
speak a task. It connects to the host daemon over the cable, with no Wi-Fi setup or credentials
stored on the device.

https://github.com/user-attachments/assets/97848065-61c6-40df-be66-a8247f69aa4c

The [ESP32-S3 firmware](device/harness/) is available now. Build and flash it onto a supported
board, or contribute support for yours. **Schematics and enclosure designs are coming**; they are
not included yet. The [hardware guide](device/harness/README.md) covers the current boards and build.

## Help build OpenHarness

The community's building block is a **harness**. Bring a tool you love, a workflow you know well,
or a craft you want more people to try. Someone else's first PCB, game, or animation could start
with what you contribute.

- **Add a harness:** [start with Hello World](CONTRIBUTING.md#your-first-harness), then share a
  working example. It can live here or in your own repository.
- **Improve one:** better instructions, a sample project, a clearer error, a new viewer, or support
  for another operating system all help.
- **Improve the platform:** engines, terminal behavior, accessibility, keyboard workflows, and
  hardware ports are welcome too. [Find your starting point](CONTRIBUTING.md#other-ways-to-contribute).
- **Tell us what was confusing:** documentation fixes and reproducible bug reports are contributions.

You can use OpenHarness, build a harness privately, or fork the whole platform. Sharing yours
helps the next person do more. [Contribute](CONTRIBUTING.md) · [Report a security issue](SECURITY.md).

## Documentation

- [Build and share harnesses](store/README.md) · [Package specification](store/spec/README.md)
- [Workspace](docs/app.md) · [Keyboard shortcuts](docs/keyboard.md) · [Coding engines](docs/engines.md)
- [Architecture and encryption](docs/architecture.md) · [CLI and automation](docs/cli.md)
- [Build, test, and develop](docs/development.md) · [Extension points](docs/extending.md)
- [Desktop](desktop/README.md) · [Daemon](cli/README.md) · [Relay](backend/README.md) · [Provider API](provider/README.md)
