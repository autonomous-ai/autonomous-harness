from manim import *


class Intro(Scene):
    """The starter: a title, a circle that becomes a square, an equation. Replace it."""

    def setup(self):
        self.camera.background_color = "#0b0b0c"

    def construct(self):
        self.next_section("Title")  # every beat is a section: the pane shows them as chapters
        title = Text("Say it with motion", font="Helvetica Neue", weight=BOLD).scale(1.1)
        sub = Text("a Manim scene, rendered as you write", font="Helvetica Neue", color=GREY_B).scale(0.5)
        sub.next_to(title, DOWN, buff=0.35)
        self.play(FadeIn(title, shift=UP * 0.3), run_time=0.8)
        self.play(FadeIn(sub), run_time=0.5)
        self.wait(0.6)
        self.play(FadeOut(title), FadeOut(sub), run_time=0.4)

        self.next_section("A circle becomes a square")
        circle = Circle(radius=1.4, color=BLUE_C, fill_opacity=0.15)
        square = Square(side_length=2.6, color=GREEN_C, fill_opacity=0.15)
        self.play(Create(circle), run_time=1.0)
        self.play(Transform(circle, square), run_time=1.2)
        self.wait(0.4)
        self.play(FadeOut(circle), run_time=0.4)

        self.next_section("An equation")
        eq = MathTex(r"e^{i\pi} + 1 = 0").scale(1.6) if _has_latex() else Text("e^(iπ) + 1 = 0", font="Helvetica Neue").scale(1.2)
        self.play(Write(eq), run_time=1.4)
        self.wait(1.0)


def _has_latex() -> bool:
    import shutil
    return shutil.which("latex") is not None
