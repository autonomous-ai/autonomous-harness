# The harness store: candidates

> **Built (2026-09-16), on branch `viewer-packages`, local repos under `/Users/ab/code/autonomous-*`:**
> Typst (+ Doc Viewer), Manim (+ Video Viewer), Excalidraw, marimo, Remotion, Blender (+ 3D Viewer), MuJoCo
> (+ MuJoCo Viewer, live WebAssembly physics), Phaser, Strudel, RDKit, Yosys, CircuitJS — each
> registered in `dsh/registry/autonomous/`, installed with `harness dsh install --link`, and proven
> through the daemon (`dsh/tools/dsh-e2e.mjs`): the starter renders, the verdict reads ready, the
> pane answers. The store in the app lists them beside the built-in engines.

What the picker could offer next, ranked. The rule from Marp and text-to-cad: wrap the open-source
project under its own name, credit its author, run on Claude Code or Codex, produce files in a
folder, show them in a pane. Numbers are GitHub stars on 2026-09-16.

## First wave — a pane we can build in a day each

| Harness (upstream) | Category | You say → you watch | Attaches as | Viewer package | Traction | Licence |
|---|---|---|---|---|---|---|
| **Remotion** (remotion-dev/skills) | Video | "a 30-second launch video with captions" → the composition playing, then the MP4 | official skills, `npx skills add remotion-dev/skills` | **video-viewer** (Remotion Studio is a local web app; the render is an MP4) | 59k on Remotion, 4.6k on the skills, the most-installed video skill on skills.sh | Remotion: free for individuals and small companies, company licence above that — must be said on the tile |
| **Manim** (ManimCommunity/manim) | Math animation | "animate the proof of Pythagoras" → the scene rendered | our SKILL.md over `manim` (MIT); no official skills yet | video-viewer | 41k | MIT |
| **Excalidraw** (excalidraw/excalidraw-mcp) | Diagrams | "an architecture diagram of this repo" → the drawing, live | official MCP, or a skill that writes `.excalidraw` | **web-viewer** serving the Excalidraw app on the file | 132k on Excalidraw, 5.3k on the MCP | MIT |
| **Typst** (apcamargo/typst-skills) | Documents | "a two-page spec sheet with a table and a plot" → the PDF as it compiles | skills | **doc-viewer** (PDF in the pane, `typst watch`) | 56k on Typst | Apache-2.0 |
| **marimo** (marimo-team/skills) | Notebooks | "explore this CSV, plot the outliers" → the reactive notebook running | official skills, `npx skills add marimo-team/skills` | marimo's own server is the pane (`marimo edit`) | 23k | Apache-2.0 |
| **Blender** (bpy, headless) | 3D art | "a low-poly fox, textured" → the model in the CAD Viewer | our SKILL.md over `blender -b` + bpy; export GLB | **cad-viewer** (already built) | 28.7k on the Blender MCP shows the demand | Blender GPL, our scripts MIT |

## Second wave — bigger toolchains or a viewer with more in it

| Harness (upstream) | Category | Notes |
|---|---|---|
| **Godot** (Coding-Solo/godot-mcp, 5.7k; Godot 117k) | Games | agent writes GDScript, `godot --headless --export-release Web` → the game **playable in the pane** through web-viewer. Export templates are ~1 GB. |
| **Office** (anthropics/skills: docx, pptx, xlsx, pdf) | Documents | Anthropic's own skills, 177k stars on the repo; the pane needs LibreOffice-to-PDF in doc-viewer. |
| **Science** (K-Dense-AI/scientific-agent-skills, 45k) | Science | 190k scientists on it; outputs are plots, notebooks and reports — doc-viewer + marimo cover it. Broad; pick one sub-domain per tile. |
| **Strudel** (tidalcycles/strudel, 3k) | Music | live-coded music playing in the pane. AGPL-3.0: fine to run, worth a licence line. |
| **Unity** (CoplayDev/unity-mcp, 14k) | Games | needs the Unity editor open; not headless. Later. |
| **Security audit** (trailofbits/skills, 7.1k) | Security | a report, not an artifact; CC-BY-SA. A doc-viewer harness if wanted. |
| **KiCad** (mixelpixx/KiCAD-MCP-Server, 2.3k) | PCB | overlaps Autonomous Circuit; only if users ask for KiCad files. |
| **img2obj** (vinhhien112/img2obj, 1.7k, Codex plugin) | 3D art | image → procedural Three.js; web-viewer. Small, fun. |

## Viewer packages this implies

| Package | Draws | Used by |
|---|---|---|
| `autonomous/cad-viewer` (built) | STEP, GLB, STL, 3MF, DXF, URDF | Autonomous Workshop, text-to-cad |
| `autonomous/video-viewer` | MP4, WebM, a frame strip while rendering | Remotion, Manim |
| `autonomous/web-viewer` | a folder served as a page, or a named local app | Excalidraw, Godot web export, img2obj, Strudel |
| `autonomous/doc-viewer` | PDF, and docx/pptx/xlsx through LibreOffice | Typst, Office, Science, Security |

## Not harnesses, however starred

Skill packs for coding itself (alirezarezvani/claude-skills 26k, book-to-skill 31k, prompt-master 13k),
Playwright MCP (37k, a tool the agent uses, not a thing it makes), Figma and Onshape (cloud editors),
openai/codex-plugin-cc (33k, Codex inside Claude Code). Good for the agents, not tiles.
