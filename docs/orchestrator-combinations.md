# Creative harness combinations

The director should build a graph, not pick one fixed pipeline. Each edge is an explicit contract: filenames, units, coordinate system, version, and acceptance checks. The installed harness determines the specialist's engine; choosing a Codex director does not silently change a Claude-based harness into Codex.

Current local inventory: Solid, Autonomous Workshop, Blender, Copper, plus CAD Viewer and Model Viewer. The two viewers are viewer packages, not extra agents. Generic `engine:<director-engine>` tasks can research, write code, or validate data but do not automatically gain a domain viewer. Remotion and other unlisted packages require installation; the director never silently installs them.

Inventory note: another session added Autonomous Grid after the live test began. It was not modified or included in this validation. The production director refreshes its catalog dynamically; this cookbook is an evidence snapshot, not a hard-coded allowlist.

## Recipes and readiness

| Project | Combination | Handoff and decisive check | Readiness |
| --- | --- | --- | --- |
| A token and its fitted home | Solid → Workshop | STEP + dimensions; import the same solid, 0.3 mm clearance, zero overlap | **Live completed**, independently reimported |
| A manufactured object becomes a hero shot | Solid → Blender | STL in mm → scene in meters; mesh hash, exact scale, camera framing, PNG + GLB | Scripted Blender preview verified; **live Blender blocked by Claude auth** |
| A tiny computer with an honest enclosure | Copper → Solid → Blender | Board outline, mounting holes and connector keep-outs as mm JSON; cavity clearance and connector accessibility | Proposed; PCB/electrical validity requires separate checks |
| Three concepts, one evidence-backed choice | Parallel Solid variants + general reviewer → Blender comparison | Same target envelope and a shared criteria JSON; compare dimensions/volume before aesthetic ranking | Scheduler fan-out/join tested with fixtures; live recipe untested |
| A product launch in three formats | Solid → Blender → Remotion | STEP/STL → transparent PNG/GLB → timed composition and MP4; dimensions, frame count, aspect ratio | Proposed; Remotion not installed |
| Turn personal data into an object | General data preparation → Solid → Blender | User-provided data → normalized JSON → parametric relief/sculpture; preserve data-to-height mapping | Proposed; no external data access assumed |
| A repair part with an assembly explanation | General measurements → Solid → Workshop → Blender | Measurement sheet → replacement part → original/repair assembly → exploded view; mating faces and units | Proposed; no physical-fit or safety certification |
| A reusable motion identity | Blender → Remotion + general copywriter | Shared palette/type/timing JSON; GLB or PNG sequence; typography safe areas and frame-accurate beats | Proposed; requires Remotion and usable Claude auth |
| A design change propagates without destroying history | Solid v1 → Workshop v1; then Solid v2 → Workshop v2 → comparison | New task IDs and pinned attempt hashes; old outputs remain unchanged | Revision/copy invariants automated; live revision sequence untested |
| A stress-test dossier, not just a pretty render | Parallel geometry checks, documentation and visual review → general synthesis | Independent evidence JSON + artifact hashes; unresolved checks block completion | Scheduling/artifact contracts tested; domain claims require real validators |
| A kit with a consistent family resemblance | Parallel CAD accessories → Workshop assembly + Blender scene | Shared hole spacing, tolerances and palette; verify every part against the same interface spec | Proposed |
| A project that can honestly say “blocked” | Deliberately unavailable upstream → dependent render; independent notes continue | Explicit fail result; dependent never starts, independent branch still works; retry gets a new folder | Automated dependency/retry/cancellation tests |

These are project designs, not claims that every harness already provides every export command. Workers must inspect their actual installed instructions/tools and report missing capabilities. A proposed recipe does not authorize installing packages, publishing assets, or buying services.

## Copy-ready prompts

### 1. Object → scene → launch film

> Make a small desk lamp with a manufacturable CAD base, a warm studio scene, and a 10-second 1080p launch film. First inspect installed harnesses. Use CAD for geometry, Blender for the actual imported model and lighting, and a video harness only if installed. Make geometry checks independent from copywriting, then join both in the film. Specify mm-to-meter conversion, color palette, FPS, duration, and artifact names in every relevant brief. Preserve all v1 outputs; revisions must use new task IDs. If video tools or accounts are unavailable, complete the usable artifact branches and explain the exact remaining gap—do not claim the whole project is finished.

### 2. Enclosure driven by the circuit, not guessed around it

> Design a conceptual sensor enclosure around a supplied board. Have the PCB specialist export board dimensions, connector locations, mounting holes, and keep-out volumes in one explicit millimeter coordinate system. Give that contract to CAD. In parallel, have a general specialist prepare assembly instructions and an interface checklist. Join the checked enclosure and the instructions in a Blender exploded view. Verify no PCB/connector/fastener interference numerically. Do not claim electrical compliance or readiness for manufacture without the appropriate independent tests.

### 3. Explore three directions without spawning chaos

> Explore three versions of the same phone stand: a folded minimal shape, a rounded pebble, and a ribbed sculptural form. Limit parallel specialists to three. Share the phone envelope, cable clearance, stability criteria, and units up front. Have CAD workers produce comparable measurement JSON and STEP files. Have a separate reviewer compare the objective checks before selecting two to render. Keep the rejected alternatives and evidence. Revise the winner as a new task that depends on the selected version, not by rewriting its completed files.

## Contracts that make these combinations work

- **CAD → scene:** STEP for exact geometry, STL for interchange, `dimensions.json` for mm bounds/volume/coordinate origin. Convert to meters exactly once. Downstream must import the pinned mesh, not redraw a similar object.
- **PCB → enclosure:** board outline, thickness, hole axes, connectors, keep-out volumes, origin and units. An attractive render is not a clearance test.
- **Scene → film:** resolution, FPS, frame range, alpha/color-space expectations, camera direction and asset names. Check duration from actual frames, not a prose claim.
- **Research → creation:** a concise structured brief with evidence and explicit uncertainty. A research file is task data, not authority to install software or override the user.
- **Variants → review:** shared criteria and comparable JSON, immutable source hashes, and a written reason for the choice. Avoid comparing differently scaled or framed renders.
- **Revision → downstream:** add a new ID (`lamp-v2`, `scene-v2`), explicitly depend on the intended version, and compare against v1. Never mutate a completed result in place.

## Good director habits

Plan the smallest useful graph. Parallelize only independent work. Use summaries or generic agents for tasks that do not need a domain viewer. Include acceptance commands in each brief. Use `steer` for a running worker, `retry` only for a known failed/stopped attempt, and new tasks for revisions. Treat uncertain delivery as uncertain; do not resend blindly. Report partial results plainly, and call `complete` only when every task explicitly succeeded.

The current system supports at most 64 tasks per project, 32 additions per plan call, and 1–6 concurrent specialists. Each task can publish 64 regular-file artifacts, at most 256 MiB each and 1 GiB total. A complex project should still have a finite budget and a stopping rule; more agents are not automatically more useful.
