# The unimaginable, turned into harnesses

Deep research (2026-09-18) into the most creative things people have built on top of Claude and
Codex — by prompting, by writing skills, and by harnessing Fable, Opus, Mythos, Astra (computer
use), and Sol/Terra/Luna — and which of them belong on the Harness Store shelf as new
domain-specific harnesses.

The existing shelf already covers the obvious domains (Circuit, Workshop/3D, Blender, Grid,
text-to-cad, Manim, Strudel, Phaser, MuJoCo, KiCad, Typst, Marp, marimo, Remotion, Excalidraw,
RDKit, Yosys, CircuitJS, comfy-mcp, ableton, etc.). So this doc deliberately hunts the **other
end** — the builds that were "unimaginable" and needed real agent persistence, real hardware, a
live viewer, or a model generation that just arrived — and maps them to harnesses that fill gaps
and push the shelf past "a pane next to a terminal."

## TLDR — the wave to build next

| # | Harness (working name) | Category | You say → you watch | Engine | Viewer | Why now |
|---|---|---|---|---|---|---|
| 1 | **Voxel Worlds / One-shot Browser Worlds** | Games | "a procedural village with a river" → a walkable, playable voxel world in the pane | claude (Fable edge) | **web-viewer** | One-shot worlds went from demo novelty to a reproducible benchmark in 2026; Fable 5 currently holds gold |
| 2 | **Generative Art & Shaders** | Original art | "a seeded kinetic series" → hash-seeded prints + WebGPU shaders, onchain-ready | claude | **web-viewer** | A whole ecosystem of genart skills exists; the shelf has no original-art tile |
| 3 | **Music Studio** | Music | "a chill lo-fi track" → a full local song, editable, exported | claude | **web-viewer** + audio | ACE-Step runs the whole pipeline locally on a GPU; Strudel covers live-coding but not finished songs |
| 4 | **Drone / FPV Pilot** | Robotics | "chirp the quad, tune it" → a blackbox-log tuning report; or fly a PX4 sim | claude | **web-viewer** | Project Pilot / Drone-Bench now ranks Fable best; tuning + sim skills are mature |
| 5 | **Lab Bench / Microscopy** | Science hardware | "run a tilt series" → the stage, the stack, the tomogram | claude | **video-viewer / web-viewer** | TEM-Agent and Microscope-Toolset made instrument control from natural language real, with schema-bound safety |
| 6 | **Creative Direction (Distinctive Web)** | Design | "make our landing unmistakably ours" → a rendered, critiqued site | claude or codex | **web-viewer** | Whole skills exist whose whole job is beating generic "AI slop"; nothing on the shelf does this |
| 7 | **Game Master / AI-vs-AI Arena** | Games | "two agents build a dungeon, then fight" → a live arena the agent balance-patches | claude (multi-model routing) | **web-viewer** | forge-arena proves a harness can *dynamically re-write the rules* of what it built |
| 8 | **Robot Arm / Physical Companion** | Robotics-hardware | "pick up the cup" → a real arm (or a HITL gate) on a live camera | claude | **web-viewer** (camera feed) | Panda-MCP + Octopus turned MCP into physical embodiment; the store has zero physical-hardware tiles |

Below: the reported builds behind each, what their authors did that was "unimaginable," the model
ladder (Fable/Mythos/Opus/Sonnet; Astra; Sol/Terra/Luna) and how it shapes harness design, and a
"watch, don't build yet" list. Every entry cites the upstream so a build can wrap it under its
own name the way Marp and text-to-cad do.

---

## 1. Voxel Worlds — from one prompt to a playable world

**The build that broke people's brains:** in June 2026 a Reddit user had **Claude Fable 5 generate a
playable HTML recreation of Minecraft in a single prompt for ~$30** — terrain navigation, block
placement with sound, inventory, TNT, background music. The same user then started on a GTA-scale
city with moving vehicles. Around the same time, **Simon Willison one-shot a mobile-friendly 3D
browser game from concept art he'd tweeted in 2022** — a self-contained `index.html`, one prompt.

What made this a *field* rather than a stunt is that people started benchmarking it. The
**Goldie Bench "Voxelcraft" task** gives 24 frontier models (Claude Fable 5, Opus 5, Sonnet 5,
GPT-5.6 Sol, Gemini 3.6 Flash, Kimi K3, DeepSeek V4, etc.) the exact same prompt — *"Minecraft-style
sandbox, place + break blocks, day/night cycle"* — and asks for a single HTML file on the first run,
no iteration. **Claude Fable 5 took gold at 9.0/10**: procedurally-textured blocks (not flat
colors), a first-person hand with a placement crosshair, a day clock, a full HUD with heart row,
hunger row and a textured hotbar. That model-to-model ladder is *exactly* the kind of thing a
harness should encode as a skill and a doctor check.

**Dedicated engine:** Jason Kneen's **tiny-world-builder** — a single ~16,000-line HTML file that
takes a prompt and returns a **walkable 3D voxel world** (terrain, roads, buildings, rivers) with
collision, pathfinding and traffic/Bot AI baked in. Adjacency-aware rendering makes roads form
clean junctions and shorelines blend into sand; drop an obstacle and the bots re-route. No API key,
no asset pack, Three.js bundled in the file. Works client-side in seconds. Fixing a bug is pure
prompting ("I can't climb out of the ocean onto land" → it diagnosed the classic 1-block shore-wall
and added auto step-up — see the **CRAFT** writer's account).

**Harness shape** (`autonomous/voxel-worlds`, claude, **web-viewer**):
- `SKILL.md`: the "lean on asset-palette terms" lesson (vague prompts → generic mush), the
  one-shot HTML contract, how to layer touch controls + keyboard, and the Fable-style HUD checklist
  (textured blocks, hotbar, day cycle) that separates gold from silver on Voxelcraft.
- `template/` seeds one prompt; `verdict.json` reports the world's proven features (walkable,
  collision, day/night) and phases (world → interaction → polish).
- The pane is a **web-viewer** serving the generated `index.html`; the agent renders it in a browser
  and screenshots to close the loop (the camera-as-referee rule — see §7).

---

## 2. Generative Art & Shaders — "design a series, not a single frame"

A whole culture built around deterministic, hash-seeded generative art where the *edition* is the
product. The standout skills:

- **skinnye/generative-art-pack** — 6 agents + 4 skills (p5.js, GLSL, flow fields, attractors,
  seeded series) that take a piece from concept → sketch → algorithm → shader → color → **export**
  (print, video loop, or a hash-seeded edition). Ships a live browser gallery.
- **camilleroux/genart-skill** — teaches the field's *working knowledge*: seeding a PRNG from a
  token hash, rendering the same piece at 400px and 4000px, designing trait/rarity tables that
  survive an edition, and — crucially — **what a verification script can and cannot prove** about
  cross-machine determinism (WebGL shader compilers and JS `Math` differ between GPUs/engines; only
  same-machine reproducibility and perceptual stability are checkable). That honesty is a perfect
  verdict feed.
- **0xjitsu/claude-shaders** — 12 production-ready **WebGPU** presets with graceful poster
  fallback, plus the "shader as baseline, not polish" doctrine.
- **minimax-ai/shader-dev** — 36 GLSL techniques (SDF raymarching, fluid sim, path tracing) as a
  routing table + per-technique reference files.

**Harness shape** (`autonomous/generative-art`, claude, **web-viewer**):
- The skill's real value is *determinism discipline* — the agent must render-to-N-file and verify
  an edition holds, which is a genuine deterministic verdict the pane can read.
- `verdict.json` surface: seed reproducibility (same-machine), feature-stability across sizes,
  edition rarity stats, "ready to mint" vs "still churning."
- Pane = the **web-viewer** rendering the current seed; a "re-seed/re-roll" affordance is natural
  (a viewer can just regenerate the tile, as the pack's own gallery does).
- This is the shelf's first **original-art** tile — every existing tile makes a *thing* (deck,
  board, video); this makes an *edition*.

---

## 3. Music Studio — a finished song from a sentence, on your GPU

- **AgriciDaniel/claude-music** — powers Claude Code with **ACE-Step 1.5** to generate full songs
  *locally*: "make me a chill lo-fi beat" → a finished track in ~15s on an 8GB GPU; vocals,
  covers, section edits, and Spotify-loudness export. 11 sub-skills behind an orchestrator, a
  web dashboard with a real waveform player and generative album art.
- **jeremyruppel/claude-collider** — an MCP server that lets Claude write and execute **SuperCollider**
  live: 27 synths, 18 effects, a "tape" session format (`.md` + `.scd`) that persists a musical idea
  across sessions, and a `/songwriting` music-theory skill (register separation, complementary
  rhythms, repetition-with-variation).
- **p-poss/dj-claude** — a first "music MCP where multiple agents jam together in real time" over
  HTTP, layering drums/bass/melody and composing them; a context-aware DJ that scores the mix for
  frequency balance. Zero dependencies, Strudel-based.

**Harness shape** (`autonomous/music-studio`, claude, **web-viewer** + audio):
- Distinct from the existing **Strudel** tile (live-coding in the pane): this one produces
  *finished, exportable songs*. Pane serves the dashboard (waveform player, library, loudness
  check); `verdict.json` reports BPM/key/loudness + "export-ready for Spotify" vs "still cooking."
- `doctor.sh` must gate on GPU/VRAM tiers (Turbo ~8GB, XL ~16GB) and fail fast on OOM — a textbook
  toolchain check.
- Strudel could stay the live-jam harness; this is the production harness. Two music tiles, clearly
  split by "jams" vs "songs."

---

## 4. Drone / FPV Pilot — tune a real quad from its blackbox log

Two genres converged in 2026: **Agents that make a drone fly better**, and **agents that judge
whether a model can fly at all**.

- **SebGalina/betaflight-claude-skill** — turns a Betaflight **chirp log** into a complete tuning
  report (bilingual, self-contained HTML): closed-loop Bode gain/phase/coherence + step response
  per axis, a gyro noise spectrum with **motor harmonics located from eRPM** and the current filter
  cut-offs drawn on it, before/after overlays, plain-language tuning observations. It can also read
  and write a live flight controller over the `betaflight-mcp` server (PIDs, filters, rates) and
  runs a guided setup wizard. Default target: Betaflight 2025.12.
- **twaldin/hone-a-drone** — *evolves* a drone-racing controller with a genetic loop (GEPA mutation
  + Claude Code as mutator) against the utiasDSL `lsy_drone_racing` sim: +33% aggregate, +270% on
  one level from a single budget-100 run.
- **Project Pilot (Anthropic + Andon Labs)** — a real benchmark, **Drone-Bench**: can a model take
  a drone, map a room, find and follow a person? **Claude Fable 5 was the best performer**,
  exceeding the human baseline on detect & follow and even recovering camera extrinsics by counting
  floor grout lines to find the vanishing point. The honest caveat: it flew into a wall it thought
  was a doorway — reconstruction was its weak link. That *failure mode* is a great verdict feed.

**Harness shape** (`autonomous/fpv-pilot` or `autonomous/drone-racing`, claude, **web-viewer**):
- Two halves, one tile: (a) **tuning-as-a-skill** over real Betaflight blackbox logs (pure
  analysis, no flying, cheap and safe to ship first), and (b) **sim-racing controller evolution**
  against the `lsy_drone_racing` / PX4 SITL simulators (headless, a true "you watch the lap get
  faster" artifact).
- `verdict.json` from the sim: lap time, per-gate success, reward delta vs baseline — deterministic
  numbers the header can show.
- Flying *real* hardware stays a doctor-checked "you must approve" step, mirroring the HITL pattern
  in §8 — the model's documented wall-flying bug is why.

---

## 5. Lab Bench / Microscopy — natural-language control of a real instrument

The most "this shouldn't be possible" research of the year is instruments:

- **TEM Agent (Lawrence Berkeley National Lab)** — Claude Sonnet controlling a **transmission
  electron microscope** through four MCP servers (microscope params + auto-aberration via BEACON,
  historical data via Crucible, the 4D camera detector, and 4D-STEM metadata via Distiller).
  "Take a tomography tilt series from 0 to 20° in 5° steps" becomes a full automated run; it
  optimizes ptychography from historical metadata.
- **dario-bassi/microscope-toolset** — Claude Code controlling a real *or virtual* microscope
  through an MCP server embedded in a **napari** GUI: image acquisition, analysis code with
  AST+runtime guardrails (blocks `CMMCorePlus` re-instantiation, blocks direct `napari` access),
  a self-learn loop, and a simulation-based **benchmark harness** with experiment tracking that
  replays every turn.
- **arXiv 2607.17012 (schema-bound instrumentation via MCP)** — the safety blueprint: a
  **schema-bound validation layer** that rejects physically unreasonable arguments *before*
  dispatch ("tilt of 95° on a stage that allows 80°" is refused with a structured error), a
  vendor-neutral `MicroscopeAdapter` capability vocabulary, and 6 registered **skills** (like an
  `eels_survey` that unrolls into a sequence of typed calls). 120 hardware-independent tests pass
  deterministically; they proved even small local open-weight models can drive the surface.
- **Anthropic's "Model Hardware Standard"** is the industry push behind all of this — a driver
  dialect so any programmable device can describe itself to an agent.

**Harness shape** (`autonomous/lab-bench` — start **simulation-first**, claude, **web-viewer
or video-viewer**):
- Absolutely lead with the **virtual microscope simulator** + the schema-bound adapter as the
  `doctor`-gated toolchain — physical instruments cost too much and are too dangerous to be the
  default target. The simulator implements the same capability surface, so the skill and verdict
  are identical whether the machine has the hardware or not.
- `verdict.json` = an experiment's phases (plan → handoff → acquire → analyze → reproduce) plus
  the finding/micrograph artifact named. This is the shelf's first real **scientific-instrument**
  tile and the natural complement to simskill/autoresearch (simulation/analysis without *hardware*).

---

## 6. Creative Direction — beating "AI slop" on purpose

A class of skills whose entire job is *distinctiveness* — the anti-template:

- **mbanderas/maestro-vinci** — "a creative partner for websites, apps, brands, decks, reports":
  it classifies task mode + change scope, reads the target repo's tokens/components/content, states
  a *point of view in observable terms before styling*, builds semantic structure → layout → type →
  surfaces → states → motion, then **renders, inspects the pixels, fixes confirmed defects,
  re-renders** — and refuses to copy another brand's identity. Explicitly: "Vinci finds what
  weakens the finished work and keeps refining."
- **OpaceDigitalAgency/ai-ui-ux-motion-engine** — a rigorous workflow for designing/redesigning/
  auditing/validating production sites across ~15 agents/editors, with a semantic validator that
  refuses to let a "cinematic" brief silently degrade into a five-second rotation, and
  `prefers-reduced-motion` equivalents for every essential experience.
- **iamtouchskyer/opc** ("One Person Company") — 16 specialist agents in one skill, but with the
  most transferable idea: **mechanical gates** — verdicts computed from code, not "is this
  important enough" LLM judgment (any red = FAIL). Six different design languages from one pipeline,
  each a real clickable site.
- **Krushi Raj's Content Generation Harness** is the *video* analogue (`techniches` plugin: 33
  sub-agents, 23 slash commands; `eduvid` deterministic TS engine): one topic → long-form video +
  native-vertical shorts + carousel + copy, ~10x faster.

**Harness shape** (`autonomous/creative-direction`, claude or codex, **web-viewer**):
- The transferable core is the **observe-then-refine loop with a pixel referee** (render to a
  browser, screenshot, *look*, repair, re-render) — which is exactly what Harness's pane + a
  browser screenshot loop is built for. The camera-as-referee rule (§7) is the same principle.
- `verdict.json` = the creative direction statement (so the header shows the *idea*, not just a
  tile is green), phases (direction → build → render-audit → polish → a11y), and findings that
  survived the mechanical gate.
- Distinct from any existing tile because the *artifact is a design system / point of view*, not a
  deck (Marp) or a board (Circuit). There's no "make it not look like a template" tile today.

---

## 7. Game Master / AI-vs-AI Arena — the harness that rewrites its own rules

**sparsh-555/forge-arena** — a Claude Code multi-agent harness that (1) **builds a souls-like
dungeon RPG from a locked `SPEC.md`** via a Planner → Workers → Reconciler → Evaluator loop that
converges when headless tests grade A/B twice, then (2) **becomes the game master**: it tails live
game events, issues balance patches (write-to-tmp-then-rename so the game loop never reads a
partial config), and watches four AI agents with distinct personalities (Aggressive / Cautious /
Hoarder / Speedrunner) compete. **Dungeon phase runs Haiku for speed; the arena final escalates to
Sonnet** — cost-optimized model routing that a harness can encode.

Its most portable rules, all of which map onto a harness contract:
- **The in-game camera is the unit test.** "Screenshots are the referee. Render from the actual
  game camera; nothing counts until you've looked at it." Pin a short shot list and reject any
  "looks good" that isn't from those cameras.
- **Scored critics, criteria written first.** Write a rubric before the pass, score things out of
  10, ship only at 8+, and blind version labels (A vs B, no "new"/"old").
- **USER vs AI decision tags.** Every decision is logged `YYYY-MM-DD | USER|AI | topic | decision |
  still in build?` — the "still in build?" column stops a discarded AI suggestion from resurrecting
  three sessions later.
- **Atomic balance patches** with a read-only baseline still establish the human ground truth.

**Harness shape** (`autonomous/game-master`, claude, **web-viewer**):
- This is a *meta*-harness and maybe the most clearly "unimaginable" on this list: the artifact is
  not just a game but a **self-balancing competition**. The pane shows the live arena (map +
  agent-thought panels + the patch feed — a Phaser/React dashboard, web-viewer).
- `verdict.json`: build-health grade, phase (build → arena → evolution), balance-patch count, and
  live session state.
- Encode the model-routing (fast model for low-stakes ticks, deep model for the final) as
  `agent.env`/skill guidance so a Harness deploy can reproduce the cost-quality tradeoff.

---

## 8. Robot Arm / Physical Companion — MCP as physical embodiment

- **ratsbane/panda-mcp** — Claude Code controlling a **7-DOF Franka Panda arm** to autonomously
  pick up objects: 5 MCP servers (arm, vision, 3D depth, voice), YOLOv8 on a Hailo-10H accelerator
  for real-time detection on a Raspberry Pi 5, analytical IK for 1–4mm grasping, a second SO-ARM100
  arm for bimanual work. Claude sees the workspace, reasons, moves, grasps, and speaks aloud.
- **qsimeon/octopus-hw ("Octopus, universal agentic hardware control")** — the "the agent writes
  its own drivers" model: one install command, five spec stages (scan devices → research what they
  are → design MCP tool signatures → write the Python → install + hand you the snippets), and the
  generated server is what Claude talks to. A camera watches the arm to confirm the hardware did
  what the agent claimed — *self-watching at the hardware layer*. "Most software can't edit its own
  instructions. Ours can." No per-device code in the repo.
- **Elephant Robotics myPalletizer Buddy (Hackster.io)** — a **physical Human-in-the-Loop gate**:
  a 4-DOF arm is mutated into a Tamagotchi-style companion, and when Claude Code wants to run a
  *tool*, it pushes the request over BLE to an M5Stack, and **you press a real hardware button to
  approve or deny**. The arm animates the AI's state (celebrates hard tasks, sleeps when idle). Its
  hook trick — a PreToolUse hook returning the exact `hookSpecificOutput.hookDecision` JSON to
  *bypass the terminal prompt* and send the decision to physical hardware — is directly reusable.
- **Thijs Van Hauwermeiren** — "Claude Opus now controls my humanoid": type "step forward" → agent
  checks a whitelist → LED red "about to move" → robot announces via TTS → walks via NVIDIA SONIC.

**Harness shape** (`autonomous/robot-arm` — start **simulated + camera verified**, claude,
**web-viewer** on the live camera feed):
- Shipping point: a **simulated** arm (Gazebo/SO-ARM sim) so anyone can run it, with a
  **HITL hardware gate** (the myPalletizer/BLE pattern) as the doctor-gated path to real hardware.
- The two non-negotiables to encode as skills: **the LLM never directly drives motors — it emits
  validated JSON through a safety engine** (from FPV-Drone-AI-Agent and the schema-bound paper),
  and **the camera is the referee** to confirm the motion actually happened (Octopus, Project Pilot).
- `verdict.json`: task completion, grasp success rate, and the safety-veto log — hardware honesty
  as a header number.

---

## The model ladder, and how it shapes harness design

The user-facing names map to real tiers, and each tier changes *which harness is worth building and
how to route work inside one*:

**Anthropic — Fable / Mythos / Opus / Sonnet, and Astra (computer use).**
- **Fable 5 / Fable 5.1** is Anthropic's coding flagship (the Minecraft one-shot, the Voxelcraft
  gold, Project Pilot's best flight, the $450 e-ink PCB). When a harness needs "get a big thing
  right on the first pass," Fable is the default.
- **Mythos 5 / Mythos 5.1** is the knowledge-work/scientific tier (Anthropic touts its research
  capability). Best for harnesses where the *artifact is analysis* — Lab Bench, creative-direction
  verdicts, evaluation rubrics.
- **Opus 5** is the professional-work Opus tier; **Sonnet 5** is the high-speed agentic tier.
- **Astra is not a separate model — it's Anthropic's agent (computer use)**: Claude sees your
  screen and clicks/types for you, in Claude Code/Cowork and the Claude Desktop (matching the 2026
  "Model Hardware Standard" and Dispatch push). For harnesses this is the unlock for **GUI-native
  or app-native targets** — apps with no CLI or API (a design tool, a desktop simulator, a native
  DAW). The store should keep an eye on a **"computer-use" harness family** for anything whose
  tool is a desktop app, not a command line. It's slower than a connector and the model can't run
  headless, so the skill must prefer MCP/connector first, computer use last — the precise-first
  doctrine from the computer-use docs.
- **GPT-5.6 Sol / Terra / Luna (Codex)** is OpenAI's durable tier ladder. **Sol** is the deep
  long-horizon flagship (Terminal-Bench 2.1 SOTA, best at multi-file refactors and architecture);
  **Terra** matches Fable for day-to-day work at ~half price; **Luna** is the cheap/fast lane.
  **`ultra` mode** fans a task to four parallel agents. For the store: Sol validates the "big
  artifact first pass" harnesses (Voxel Worlds, Creative Direction) too, and `ultra` is a good
  reason a few harnesses list Codex as an equal engine rather than only Claude.
- **Open-weight (Mlx / Kimi / Qwen / DeepSeek / local Ollama)** sit at the bottom of several ladders
  but are *equal* for instrument/schema-bound work — the microscopy paper and FPV-Drone-AI-Agent
  both run small local models fine, because the tool surface, not the model size, does the hard
  work. That is precisely the "wrap the tool, not the model" principle the store already stands on.

**Design rule that falls out of all of this:** route the *routine* to a fast/cheap tier and the
*judgment* to the frontier tier (forge-arena's Haiku-dungeon / Sonnet-final; Sol-plans /
Luna-utility in the Codex routing guides). A harness with a per-phase `agent.env` model hint and a
rubric that the *cheap* tier can run is both better and dramatically cheaper — and it's what the
existing store's per-session model selection is already set up for.

---

## Watch, don't build yet

| Candidate | Why it's tempting | Why to wait |
|---|---|---|
| **Office docs** (anthropics/skills) | obvious, high demand | already listed as a second-wave candidate in CANDIDATES.md; doc-viewer + LibreOffice dependency |
| **Unity** (unity-mcp) | games | needs the editor open, not headless — fights the daemon model |
| **Figma / Onshape** | design/CAD in the cloud | cloud editors, no local artifact for the pane |
| **Security audit** (trailofbits/skills) | useful | produces a report, not an artifact — a doc-viewer harness at best; also a license/legal note (CC-BY-SA) |
| **Physical humanoid / drone out of the box** | most impressive | safety + cost; the HITL gate and simulator must come first (fold into §5/§8's sim-first path) |
| **macOS-compat/HP-printer style hacks** | quirky proof of agent capability | one-off, no durable domain to wrap |
| Pure **coding-agent skill packs** (alirezarezvani etc.) | high stars | they make the *agent* better, not a *thing* — explicitly not harnesses (per CANDIDATES.md) |

---

## License lines worth stating on the tile (mirroring CANDIDATES.md)

- Voxel worlds / tiny-world-builder: **AGPL-3.0** — say so; a fork wrapped in a skill is fine, a
  commercial one isn't.
- Generative art: MIT/AGPL variety — the *ecosystem* is fine, but each wrap should state its own.
- Strudel/ACE-Step/SuperCollider: AGPL/GPL families — "fine to run, worth a line."
- Music Studio: ACE-Step model weights are separately licensed — doctor.sh should surface that.
- SuperCollider and Betaflight are GPL — again fine to run, worth a line.
- Blender-friendly rule from the repo: never import a package's code, credit the author, run the
  open-source project under its own name.

---

## Bottom line

The shelf's next wave isn't "another CAD/PCB/docs tile" — it's **worlds, editions, songs, flying,
instruments, direction, arenas, and hardware**, each built from a proven "unimaginable" build.
The two design rules that recur in *all eight* and should become house doctrine for the store:

1. **Scope the tool, not the model.** Every one of these ran on a range of tiers (even local
   models) because the *tool surface* did the hard work. Route routine → cheap tier, judgment →
   frontier tier.
2. **The camera/screen is the referee.** The builds that shipped real things (games that look
   good, boards that fit, arms that grasp, tunes that are loud) all closed the loop by *rendering,
   looking, and fixing* — not by declaring "done." Harness's pane exists to be that referee.
