---
name: manim
description: Animate explanations with Manim Community — proofs, transforms, algorithms, graphs, data — as Python scenes rendered to MP4, and keep the pane playing the latest render. Use for any request that ends in an animation or an explainer video.
---

# manim

Manim (Manim Community edition) renders animations from Python: a `Scene` subclass whose
`construct()` plays animations on mobjects. The render lands as MP4 under `out/`. Tools: `$MANIM`
(the pinned CLI), `$MANIM_PYTHON` (its interpreter). Never install another.

## Render, then the verdict

```bash
$MANIM render -ql --media_dir out scenes/intro.py Intro       # quick: 480p15, seconds
$MANIM render -qm --media_dir out scenes/intro.py Intro       # medium: 720p30
$MANIM render -qh --media_dir out scenes/intro.py Intro       # final: 1080p60
$MANIM render -ql --media_dir out --format gif scenes/x.py Name   # a gif instead
"$MANIM_PYTHON" "$MANIM_TOOLCHAIN/verdict.py"                 # judge the newest render → pane header
```

Renders go to `out/videos/<file>/<quality>/<Scene>.mp4`. Render at `-ql` while iterating (fast), `-qh`
once at the end. Run the verdict after every render.

## Writing scenes

- One file per scene under `scenes/`; class name = the scene's name; a docstring says what it shows.
- **Mobjects**: `Text`, `MathTex` (needs LaTeX — check `command -v latex` first; without it, formulas
  are `Text(...)` with Unicode superscripts and the render still lands), `Circle`, `Square`, `Rectangle`, `Line`, `Arrow`, `Dot`, `Axes`, `NumberPlane`, `VGroup`,
  `Table`, `BarChart`, `ImageMobject`.
- **Animations**: `Create`, `Write`, `FadeIn/FadeOut` (with `shift=`), `Transform`, `ReplacementTransform`,
  `MoveToTarget`, `Indicate`, `Circumscribe`, `LaggedStart`, `AnimationGroup`, `.animate` (e.g.
  `self.play(dot.animate.shift(RIGHT * 2))`), `run_time=`, `rate_func=`.
- **Layout**: `.next_to(other, DOWN, buff=0.3)`, `.to_edge(UP)`, `.move_to(ORIGIN)`, `.scale()`,
  `.arrange(RIGHT)` on groups. The frame is 14.2 × 8 units; keep text within ±6 horizontally.
- **Timing**: 0.6–1.2 s per beat, `self.wait(0.5)` between ideas, never more than one new idea on
  screen at a time. A 60-second explainer is 8–12 beats.
- **Look**: dark background (`self.camera.background_color = "#0b0b0c"`), one accent colour, a
  sans-serif via `Text(..., font="Helvetica Neue")`, big type (scale 0.8–1.4).
- **Graphs and data**: `Axes(x_range=[0, 10, 1], y_range=[0, 5, 1])`, `axes.plot(lambda x: ...)`,
  `axes.get_graph_label`, `BarChart(values, bar_names=...)`.
- **Camera moves**: subclass `MovingCameraScene` and animate `self.camera.frame`.

## Rules

- Save early: a first render within the first minute (title + one beat), then add beats.
- Every request that says "explain" is a sequence: what it is, why it matters, the mechanism, the
  result. One scene, or one scene per section for long ones.
- Assets (images, data) live under `assets/`; reference them relatively.
- A render that fails prints a Python traceback; fix the line it names, render again.
