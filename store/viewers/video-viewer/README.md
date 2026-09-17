# Video Viewer, a Harness viewer package

The pane for renders in [Harness](https://github.com/autonomous-ai/autonomous-harness): an editor-grade
player for the videos a harness makes, that follows the agent while it works. A harness points at it
with

```json
"viewer": { "use": "autonomous/video-viewer" }
```

and names the file in its verdict's `artifact` (or lets the newest render under the workspace win).
Manim uses it; any harness that ends in a video can.

## What the pane does

- **Every render, newest first.** Each scene is one row (poster, length, size, chapters, when), its
  qualities as chips (`480p15`, `1080p60`); the newest opens, and the pane follows whatever the agent
  renders next until you pick something older (then a *Follow latest* pill brings you back).
- **Chapters.** Manim's sections (`self.next_section("…")`, rendered with `--save_sections`) are
  chapters on the timeline and in a list: click, `↑`/`↓`, or `1`…`9`. The *Animations* tab lists every
  `play`/`wait` with its label, grouped by chapter; ticks on the filmstrip mark them.
- **A timeline like an editor's.** A filmstrip of the video, a hover preview of the exact frame with
  its chapter and animation, drag to scrub, timecode `MM:SS:FF` and frame number (click for seconds or
  frames).
- **Frame-accurate.** `←`/`→` one frame, `⇧←`/`⇧→` one second, `[`/`]` one animation, `J`/`K`/`L`
  shuttle (reverse included; `K` held with `J`/`L` steps), speed 0.25×–2×, loop the whole video or a
  range set with `I`/`O`.
- **Stills.** `C` copies the frame as PNG; `S` saves it to `.harness/stills/<scene>-<quality>-f<frame>.png`,
  a path you can hand the agent.
- **Live.** While a render runs the pane plays the clips already written, one animation after
  another, on a timeline that grows (a hatched tail shows what is still to come, a spinner waits at
  the live edge), with "Rendering · 7 of ~26 · Create(Square)" in the header. When the movie lands it
  swaps in at the same frame and says what changed: the animations that differ from the last render
  are marked on the timeline and in the lists, new and retimed chapters are tagged, `G` jumps to the
  next change. A failed render shows its error, file and line over the last good video, with the
  animations that did render one click away.
- Fullscreen (`F`, or filling the pane where the webview cannot go fullscreen), a keyboard sheet
  (`?`), light and dark, narrow and wide layouts, a helpful empty state. View state (render, frame,
  paused) survives the pane being reloaded or re-pointed by Harness.

## What it reads

Everything is optional except the video. Manim's own layout gives chapters and animations; a render
wrapper that writes the two `.harness/` files gives labels, live progress and failures.

```
<media>/videos/<module>/<quality>/<Scene>.mp4                         the render
<media>/videos/<module>/<quality>/sections/<Scene>.json               chapters (--save_sections)
<media>/videos/<module>/<quality>/partial_movie_files/<Scene>/*.mp4   one clip per animation
.harness/render.json                                                  the render in progress
.harness/renders/<video path>.json                                    how a render was made
```

`.harness/render.json` (rewritten as the render goes; the Manim harness's `toolchain/render.py`
writes it):

```jsonc
{ "state": "rendering",            // rendering | done | failed | cancelled
  "pid": 4242,                      // a dead pid turns "rendering" into "stopped"
  "scene": "Proof", "quality": "480p15", "output": "out/videos/proof/480p15/Proof.mp4",
  "startedAtMs": 0, "updatedAtMs": 0, "finishedAtMs": 0,
  "animation": 7, "expected": 26,   // n of ~m
  "current": "Create(Square)",
  "sections": [{ "name": "Setup", "animation": 0 }],
  "animations": [{ "index": 0, "label": "Create(Square)", "runTime": 1.0, "clip": "123_456_789.mp4", "section": 0 }],
  "clips": ["out/videos/proof/480p15/partial_movie_files/Proof/123_456_789.mp4"],
  "error": { "type": "NameError", "message": "…", "file": "scenes/proof.py", "line": 42, "code": "…" } }
```

`.harness/renders/<video path>.json` has `clipsDir`, `clips` (`[{ name, size }]`, in order),
`animations`, `sections`, `duration` and `previous` (the same for the render before), from which the
pane works out what changed even if it was not open at the time. Without a wrapper the pane still sees
a render coming: clips newer than their movie are a render in progress, and one that stops writing
for 45 s without a movie is *stalled*.

## How it works

No dependencies. `viewer.mjs` is a loopback server on the port Harness hands it: the page from `ui/`,
the workspace under `/ws/…` with byte ranges, `GET /api/library` and `GET /events` (server-sent
events, pushed when the workspace changes). `lib/library.mjs` walks the workspace and reads MP4
headers itself (`lib/mp4.mjs`: frame count, frame rate, size, sound — no ffprobe), so a movie still
being written is never offered. The page (`ui/app.js`) draws the filmstrip and previews from two
hidden `<video>` elements, and plays a render in progress as a playlist of its clips.

```sh
node --test                          # the MP4 reader and the library, on synthetic files
harness dsh check .                  # conformance
harness dsh install "$PWD" --link    # this checkout as the installed viewer
```

`doctor.sh` checks for Node.

## Credit and stewardship

Written by Autonomous for Harness, MIT. The pane plays video with the web view's own `<video>` and reads
MP4 headers itself (`lib/mp4.mjs`), so no third-party code ships in this folder.
