# Harness Store: projects worth wrapping

Research date: September 16, 2026 (America/New_York).

**Status: Deferred — documented for a future build session.** All ten candidates below are research-backed backlog items. The user has asked to save them and return to implementation later. No implementation is scheduled; the ordering below is a recommendation to revisit when work resumes.

To resume: refresh the chosen upstream's maintenance status, license, and dependencies; pin a commit; reproduce its proposed demonstration in isolation; then package the verified workflow for Harness. The experience names below describe product ideas. Package names and upstream credit should follow the [Store conventions](../../store/README.md).

## Recommendation

Prototype **Game Studio with Godogen** and **Film Director with OpenMontage** first. Both already organize a coding agent around a complete creative workflow. For a more unusual flagship, explore **Instrument Maker** or a **Wind Tunnel** that accepts a CAD design. Keep **Robot Missions** as the ambitious hardware demonstration.

The benchmark is text-to-cad: an existing open-source project that gives Claude Code or Codex domain knowledge, executable tools, a useful output, and a way to inspect that output. A repository merely written with Claude does not meet that benchmark.

The current Store already has Blender, MuJoCo, Phaser, Remotion, Strudel, RDKit, Yosys, and other tool packages. The candidates below add workflows such as generating and checking a playable game, directing a complete film, or comparing measured simulation results. They should be presented through the result someone wants to achieve.

## Scope and evidence

I examined the current Store manifests, searched public projects and maker demonstrations, then retrieved metadata, READMEs, licenses, and selected implementation files directly from 13 relevant GitHub repositories. I also inspected Godogen's demo briefs and OpenMontage's Backlot screenshot and viewer documentation.

This is a source and product assessment. I did **not** install these packages, generate a game or film, run their benchmarks, or operate hardware. Public examples are upstream demonstrations, not independently reproduced results. Every proposed demo below is a Harness product idea; it is not a claim that the exact prompt already succeeds upstream.

## Ranked shortlist

| Priority | Harness | Foundation | Agent relationship | Integration assessment |
| --- | --- | --- | --- | --- |
| 1 | Game Studio | Godogen | Explicit Claude Code and Codex workflows | Best first prototype; browser game path fits a pane |
| 2 | Film Director | OpenMontage | Existing file-based workflow for Claude Code and Codex | Strong product fit; existing live board; AGPL packaging review |
| 3 | Instrument Maker | JUCE Dev + JUCE Agent Toolkit | Claude plugin; portable Codex skills/scripts | Distinctive output; audio validation and native preview need work |
| 4 | Wind Tunnel | Foam-Agent | Claude skill + MCP; internal model calls | Strong engineering demonstration; larger runtime and verification work |
| 5 | AI Research Lab | autoresearch / autoresearch-mlx | Agent runs an existing experiment protocol | Small integration surface; Mac path available; narrow scientific promise |
| 6 | Music Studio | Ableton AI | Claude Code skill + MCP | Useful to Ableton owners; native application remains required |
| 7 | Robot Missions | DimOS | Agent CLI/MCP and Claude Code guidance | Highest physical impact; substantial platform/hardware work |
| 8 | City Lab | SimSkill | Runs inside Claude Code | Interesting research foundation; curated scenario and viewer needed |
| 9 | Architect | Bonsai MCP / IFC-Copilot | Claude Code and Codex MCP clients | Real building data; thinner workflow layer than text-to-cad |
| 10 | Generative Studio | Official Comfy MCP | Claude Code and other MCP clients, including Codex | Strong maintained tools; needs a focused workflow and GPU plan |

These are product priorities, not benchmark scores or implementation estimates.

## 1. Game Studio — Godogen

**Proposed demo:** Describe a tiny snowboarding world, watch the terrain and character appear, then play it and ask the agent to change the physics.

**Existing foundation:** Godogen supports Godot, Bevy, and Babylon.js, with output tailored for Claude Code or Codex. It includes asset-generation tooling and directs the agent to inspect the running game. Its public materials include racing, cycling, and snowboarding briefs and a linked gameplay demonstration. [Repository and demo](https://github.com/htdt/godogen), [demo briefs](https://github.com/htdt/godogen/blob/master/docs/demo_prompts.md).

**What we would wrap:** Its project-generation workflow, asset tools, and engine guide. Start with Babylon.js so the actual game can occupy the Harness pane. Add a workspace-specific server, explicit runtime checks, and a proof recording. Its engine guide already describes browser capture and readiness checks. [Runtime instructions](https://github.com/htdt/godogen/blob/master/prompts/runtime.md), [Babylon guide](https://github.com/htdt/godogen/blob/master/engines/babylon.md).

**Limits:** A polished generation can take hours. The documented asset pipeline uses external image/video/3D services; those costs are separate from the coding-agent subscription. A successful compile is insufficient, and visual checking is not comprehensive gameplay testing. MIT license.

## 2. Film Director — OpenMontage

**Proposed demo:** Give it Harness device photographs and ask for a 30-second launch film. Review the script and shot choices as they form, then watch the finished edit.

**Existing foundation:** The original project, **calesthio/OpenMontage**, contains production pipelines, tools, agent instructions, and published films. Examples include a science-fiction trailer and a product film in which objects separate into components and reassemble. It supports both coding agents and uses generated or sourced media. [Original repository and films](https://github.com/calesthio/OpenMontage).

**What we would wrap:** The production workflow plus Backlot, its local board. Backlot reads project files and updates via filesystem notifications; it exposes screenplay, shots, stage progress, decisions, spend, and renders. Its documented server accepts a port. This is a particularly close fit for Harness's viewer model. It is a read-only production board, not a full timeline editor. [Backlot implementation contract](https://github.com/calesthio/OpenMontage/blob/main/backlot/README.md).

**Limits:** We need to map a Harness workspace into its project layout and reproduce one bounded production. Premium generated motion requires provider credentials/budget; local models require compute. Current upstream is AGPL-3.0. Search surfaced another similarly named repository with different contents and licensing; use the original author repository above.

## 3. Instrument Maker — JUCE Dev / JUCE Agent Toolkit

**Proposed demo:** Ask for a playable granular instrument with a freeze control, drag in a recording, audition it, and export a plugin for a DAW.

**Existing foundation:** Daniel Raffel's JUCE Dev automates project creation, builds, and optional GPU interface setup through Claude Code. His separate MIT-licensed toolkit provides portable project and build workflows for Codex and other coding agents. These are development workflows; they do not establish that arbitrary DSP designs already sound good. [JUCE Dev](https://github.com/danielraffel/generous-corp-marketplace/tree/master/plugins/juce-dev), [portable toolkit](https://github.com/danielraffel/juce-agent-toolkit), [author's walkthrough](https://danielraffel.me/2026/03/06/a-claude-code-plugin-for-building-juce-audio-plugins/).

**What we would wrap:** Project scaffolding, build commands, a small instrument/effect template, and repeatable audio fixtures. The important added work is a reliable audition loop: render known input, check clipping/non-finite samples and CPU behavior, then let the user listen. Native plugin hosting will require more integration than displaying a web page.

**Limits:** Prototype one constrained instrument or effect first. Toolkit MIT terms do not replace JUCE's separate AGPL/commercial licensing. [JUCE license](https://github.com/juce-framework/JUCE/blob/master/LICENSE.md).

## 4. Wind Tunnel — Foam-Agent

**Proposed demo:** Import a CAD enclosure, compare airflow around two shapes, and show pressure, streamlines, and measured drag side by side. A later version could ask the CAD agent to propose another shape.

**Existing foundation:** Foam-Agent handles case planning, file generation, simulation, error correction, and visualization. It ships a Claude Code skill and executable MCP tools, with a Docker distribution. This is a substantial workflow rather than a generic OpenFOAM prompt. [Repository](https://github.com/csml-rpi/Foam-Agent), [Claude workflow](https://github.com/csml-rpi/Foam-Agent/blob/main/.claude/skills/foam.md).

**What we would wrap:** A pinned OpenFOAM environment, the workflow, a small set of known geometries, and a result viewer. Start by reproducing a benchmark case, then compare two variants under identical conditions. The CAD-to-CFD handoff and optimization loop are our proposed integration, not an existing end-to-end guarantee.

**Limits:** The documented validated path targets Foundation OpenFOAM v10; ESI support is best-effort, with stricter wording in its skill. Planning/review include internal model calls, so it is not necessarily covered entirely by the user's outer agent subscription. Physical credibility needs mesh, convergence, and reference-case checks. MIT wrapper. [MCP code](https://github.com/csml-rpi/Foam-Agent/blob/main/src/mcp/fastmcp_server.py).

An alternative, [openfoam-claude-suite](https://github.com/swtbkim/openfoam-claude-suite), is directly organized as Claude skills and has explicit simulation-quality gates. It is much smaller, targets a different OpenFOAM version, and needs separate reproduction before adoption.

## 5. AI Research Lab — autoresearch / autoresearch-mlx

**Proposed demo:** Let an agent run experiments on a small language model overnight. Show proposed changes, accepted/rejected trials, and independently re-evaluated progress.

**Existing foundation:** Karpathy's autoresearch gives Claude/Codex an editable training file, a fixed-duration experiment, and a validation metric. The MLX port brings the pattern to Apple Silicon and includes a public result log. This is one of the cleanest examples of a domain workflow layered directly over coding agents. [Original](https://github.com/karpathy/autoresearch), [Mac port](https://github.com/trevin-creator/autoresearch-mlx).

**What we would wrap:** The existing protocol, a pinned starter dataset, bounded run controls, and a chart built from the experiment ledger. This is a useful fit for Harness's multiple machines: local MLX experiments or a separate NVIDIA worker for the original.

**Limits:** Promise a small-model experiment lab, not autonomous scientific discovery or training a frontier model. Single-run improvements can be noise. The port includes an optional repeated-run comparison helper; it still needs an independent holdout/re-evaluation policy before we market improvements. [Comparison helper](https://github.com/trevin-creator/autoresearch-mlx/blob/main/rigor.py). Original README declares MIT; the MLX fork includes an MIT license file.

## 6. Music Studio — Ableton AI

**Proposed demo:** Build an evolving ambient piece, then ask for a darker bass, a slower filter movement, and a new rhythmic layer while listening.

**Existing foundation:** Ableton AI exposes tracks, instruments, effects, MIDI, automation, and mixing through an MCP server and a Live remote script. It includes a Claude Code skill and detailed example compositions. [Repository](https://github.com/freekmurze/ableton-ai).

**What we would wrap:** The bridge and skill, a starter Live set, and a workspace view of track/clip state. The output is an editable music session; the user can continue working in the DAW. Codex support through MCP is plausible, but this project's documented skill path is Claude Code.

**Limits:** Ableton Live 11+ is a separate required application. The author explicitly says the assistant cannot hear its work; the user judges the music. Some Live operations remain outside its API. MIT bridge, separately licensed DAW. This is more accessible as an optional harness for existing Ableton users than as a universal install.

## 7. Robot Missions — DimOS

**Proposed demo:** Ask a simulated robot to explore an office and locate a room, watch its map and camera view, then later demonstrate a supervised mission on supported hardware.

**Existing foundation:** DimOS combines robot control, perception, mapping, spatial memory, and agent interfaces. It provides replay and MuJoCo modes alongside physical robot paths. Its documentation directs Claude Code and other agents to its CLI/MCP interface. Public materials show navigation and room-finding. [Repository and demonstrations](https://github.com/dimensionalOS/dimos).

**What we would wrap:** A single known robot blueprint, a simulation environment, camera/map visualization, and mission results. This adds task-level behavior to the existing MuJoCo capability. A mission succeeding in simulation must not be represented as successful physical execution.

**Limits:** Upstream is prerelease; hardware support varies. Linux is the stronger target and macOS is listed as alpha. Basic control can run without a GPU, while the documented perception stack expects one. Apache-2.0 notice in LICENSE. [Requirements](https://github.com/dimensionalOS/dimos/blob/main/docs/requirements.md), [license](https://github.com/dimensionalOS/dimos/blob/main/LICENSE).

## 8. City Lab — SimSkill

**Proposed demo:** Show buses bunching along a route, let the agent test a holding controller, and compare waiting time and vehicle spacing against the original simulation.

**Existing foundation:** SimSkill runs in Claude Code and accumulates SUMO traffic-simulation skills, knowledge, and experiment history. Its repository contains evaluation materials and specific operational skills. This is an agent-native simulation foundation with runnable examples, though still a research project. [Repository](https://github.com/qiliuchn/SimSkill-V1).

**What we would wrap:** Begin with one shipped procedure rather than unbounded learning. The bus-bunching skill describes how to establish an uncontrolled baseline, apply a controller, and recompute results from raw simulation output. Add a traffic playback pane and comparison plots. [Bus-bunching workflow](https://github.com/qiliuchn/SimSkill-V1/tree/main/.claude/skills/procedural-memory/demonstrate-and-control-bus-bunching).

**Limits:** A full city digital twin would require additional data and calibration. Upstream benchmark gains vary by model; these are not evidence that arbitrary real-world traffic forecasts are accurate. Apache-2.0. Higher integration effort than the first two candidates.

## 9. Architect — Bonsai MCP / IFC-Copilot

**Proposed demo:** Modify the rooms and openings in a small building, then inspect the updated model, floor-plan view, and quantities.

**Existing foundation:** Bonsai MCP connects Claude Code/Codex to Blender, Bonsai, and IfcOpenShell. It can query actual building elements and quantities, capture views, and execute IFC edits. IFC-Copilot documents the associated building-design work. [Repository](https://github.com/Show2Instruct/bonsai-mcp), [research project](https://show2instruct.github.io/ifc-copilot/).

**What we would wrap:** The MIT bridge, a minimal IFC project, a constrained editing workflow, and a building viewer. Its examples already include per-storey views, quantity queries, and edit/read-back verification. [Examples](https://github.com/Show2Instruct/bonsai-mcp/blob/main/docs/examples.md).

**Limits:** This foundation is closer to a tool bridge than a finished design workflow. We would need to supply more domain guidance than for Godogen. It requires a running Blender/Bonsai session. A valid IFC file is not evidence of structural adequacy or building-code compliance.

## 10. Generative Studio — official Comfy MCP

**Proposed demo:** Create a coordinated product-image set, approve a direction, then generate motion variants using saved, inspectable workflows.

**Existing foundation:** Comfy-Org's local MCP server gives coding agents tools to discover an installed ComfyUI environment, assemble/validate workflows, run jobs, and retrieve outputs. The official product materials cover image, video, audio, and 3D workflows. [Official repository](https://github.com/Comfy-Org/comfy-mcp), [official overview](https://comfy.org/mcp).

**What we would wrap:** Choose one use case, such as product photography or character assets, and ship a small set of known model/workflow combinations with a gallery and queue. The full ComfyUI ecosystem is too broad to be a reliable first-run promise.

**Limits:** The local server is beta, and runtime/model requirements vary substantially. It is dual licensed under AGPL-3.0-or-later or commercial terms. Model and custom-node licenses are separate. The older artokun bridge now points to the official tooling; do not base a new integration on the unmaintained bridge. [License](https://github.com/Comfy-Org/comfy-mcp/blob/main/LICENSE), [community-project notice](https://github.com/artokun/comfyui-mcp).

## Other candidates and exclusions

- **OpenKlip:** A strong alternative for editing existing recordings: CLI/MCP, an editable browser surface, and plain project files. MIT, with explicit Claude Code/Codex support. Less spectacular than generated films, but potentially easier to make consistently useful. Consider a separate Editor harness after Film Director. [Project](https://github.com/craftled/openklip).
- **Kinewright:** An explicit agent-driven editor supporting Claude Code/Codex, but early and currently Windows/Linux. Less suitable for the current Mac-first prototype. GPL-3.0. [Project](https://github.com/CanadaApollo6/Kinewright).
- Generic agent managers, coding frameworks, skill collections without a concrete output, and ordinary apps merely built with Claude were not shortlisted.
- I did not find enough verified workflow evidence in this pass to recommend a protein-design, textile, or satellite harness ahead of the candidates above. Those remain research directions, not promises.

## How to turn the shortlist into a decision

Run three isolated prototype demonstrations:

1. **Godogen:** One small original browser game, with generated assets, user input, restart, and a recorded run. Verify it in Harness's actual webview as well as the upstream browser path.
2. **OpenMontage:** One short product film from supplied images; show the real production in Backlot and verify the exported video/audio. Record generation spend and retries.
3. **One specialist:** Pick Instrument Maker for a creative developer audience, Wind Tunnel for engineers, or Robot Missions for a physical flagship. Keep the first task narrow enough to verify independently.

For each, record time to first visible result, completion time, extra credentials/compute, retries, final artifact quality, and what the user can edit afterward. Set the target budget before each paid run. The storefront should show the actual resulting artifact and its source project credit.

The licensing labels above identify integration work; they are not a conclusion that every packaging or distribution arrangement is covered. In particular, MIT wrappers can still depend on separately licensed applications, libraries, and model weights.

## Research record

Directly retrieved upstream metadata and selected source files are cached outside the application repository at /private/tmp/harness-store-research-20260916. No upstream installation scripts were executed and no Harness application code was changed for this research.

Source trees inspected include Godogen, OpenMontage, JUCE Dev, Foam-Agent, Comfy MCP, SimSkill, Bonsai MCP, and autoresearch-mlx. GitHub metadata and license files were also checked for Ableton AI, DimOS, JUCE Agent Toolkit, openfoam-claude-suite, and the original autoresearch. The linked default branches may change; a prototype should pin its own tested upstream commit.
