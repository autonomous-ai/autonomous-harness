---
name: manim
description: Animate explanations with Manim Community — proofs, transforms, algorithms, graphs, data — as Python scenes rendered to MP4, and keep the pane playing the latest render. Use for any request that ends in an animation or an explainer video.
---

# manim

Manim (Manim Community edition) renders animations from Python: a `Scene` subclass whose
`construct()` plays animations on mobjects. The render lands as MP4 under `out/`. Tools: `$MANIM`
(the pinned CLI), `$MANIM_PYTHON` (its interpreter). Never install another.

## Render (the verdict comes with it)

```bash
"$MANIM_PYTHON" "$MANIM_TOOLCHAIN/render.py" scenes/intro.py Intro            # quick: 480p15, the default
"$MANIM_PYTHON" "$MANIM_TOOLCHAIN/render.py" -qm scenes/intro.py Intro        # medium: 720p30
"$MANIM_PYTHON" "$MANIM_TOOLCHAIN/render.py" -qh scenes/intro.py Intro        # final: 1080p60
"$MANIM_PYTHON" "$MANIM_TOOLCHAIN/render.py" --format gif scenes/x.py Name    # a gif instead
```

`render.py` is `manim render` with the same flags, output and tracebacks, plus what the pane needs:
`--media_dir out --save_sections`, a live progress file (the pane plays each animation as it is
written and shows a failure with its line), a record of the render's animations and chapters, and
the verdict at the end. Use it for every render; plain `$MANIM render` still works but the pane sees
less. Renders go to `out/videos/<file>/<quality>/<Scene>.mp4`. Render at `-ql` while iterating
(fast), `-qh` once at the end.

## Chapters

The pane shows a scene's sections as chapters — on the timeline, in a list, as `1`…`9` keys. Mark
every beat of the storyboard with a section, named the way a chapter title reads:

```python
def construct(self):
    self.next_section("The question")
    ...
    self.next_section("Squares on the sides")
    ...
    self.next_section("9 + 16 = 25")
```

Three to eight sections for a 20–60 s scene; a name is two to five words; the first call comes before
the first `play`. A section with no animation is dropped. Keep names stable between renders: the pane
marks a chapter "changed" or "new" by its name.

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
- Every beat is a section (see Chapters): a proof or an explainer arrives chaptered.
- Every request that says "explain" is a sequence: what it is, why it matters, the mechanism, the
  result. One scene, or one scene per section for long ones.
- Assets (images, data) live under `assets/`; reference them relatively.
- A render that fails prints a Python traceback (and the pane shows the error and its line); fix
  the line it names, render again. The pane keeps playing the last good render meanwhile.
