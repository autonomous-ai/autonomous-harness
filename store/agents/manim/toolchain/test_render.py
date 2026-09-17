import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from render import with_manim_args, guess_target, describe

class Args(unittest.TestCase):
    def test_the_pane_flags_are_added(self):
        self.assertEqual(with_manim_args(["scenes/a.py", "A"]), ["render", "--save_sections", "--media_dir", "out", "-ql", "scenes/a.py", "A"])
    def test_the_agents_own_flags_win(self):
        args = with_manim_args(["render", "-qh", "--media_dir", "media", "--save_sections", "scenes/a.py", "A"])
        self.assertEqual(args, ["render", "-qh", "--media_dir", "media", "--save_sections", "scenes/a.py", "A"])
    def test_a_failure_before_the_scene_still_names_its_video(self):
        t = guess_target(with_manim_args(["-qh", "scenes/proof.py", "Proof"]))
        self.assertEqual(t["output"], "out/videos/proof/1080p60/Proof.mp4"); self.assertEqual(t["scene"], "Proof")

class Labels(unittest.TestCase):
    def test_labels_are_short(self):
        class Text:  # stand-ins: describe() reads class names and text only
            original_text = "The Pythagorean   Theorem, stated for every right triangle"
        class Square: pass
        class FadeIn:
            mobject = Text()
        class _MethodAnimation:
            mobject = Square()
        class Wait:
            mobject = None
        self.assertEqual(describe(FadeIn()), "FadeIn(Text “The Pythagorean Theorem, stated…”)")
        self.assertEqual(describe(_MethodAnimation()), "animate(Square)")
        self.assertEqual(describe(Wait()), "Wait")

if __name__ == "__main__": unittest.main()
