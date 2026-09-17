import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from verdict import judge

class Judge(unittest.TestCase):
    def test_a_render_that_plays_is_ready(self):
        v = judge(["scenes/intro.py"], "out/videos/intro/480p15/Intro.mp4", {"duration": 6.2, "frames": 93, "width": 854, "height": 480})
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "Intro.mp4 · 6.2 s · 854×480")
    def test_no_render_yet(self):
        v = judge(["scenes/intro.py"], None, {})
        self.assertFalse(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
    def test_a_still_is_not_a_video(self):
        v = judge(["scenes/a.py"], "out/a.mp4", {"duration": 0.07, "frames": 1})
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][2]["state"], "active"); self.assertEqual(v["findings"][0]["severity"], "warning")

    def test_chapters_are_counted(self):
        v = judge(["scenes/proof.py"], "out/videos/proof/480p15/Proof.mp4", {"duration": 12.0, "frames": 180, "width": 854, "height": 480, "chapters": 4})
        self.assertTrue(v["ready"]); self.assertEqual(v["summary"], "Proof.mp4 · 12.0 s · 854×480 · 4 chapters")
    def test_a_failed_render_after_the_video_is_an_error(self):
        failure = {"type": "NameError", "message": "name 'Sqaure' is not defined", "file": "scenes/proof.py", "line": 42, "scene": "Proof"}
        v = judge(["scenes/proof.py"], "out/videos/proof/480p15/Proof.mp4", {"duration": 12.0, "frames": 180}, failure)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0]["severity"], "error"); self.assertEqual(v["findings"][0]["ref"], "scenes/proof.py:42")
        self.assertIn("NameError", v["findings"][0]["message"])

class Newest(unittest.TestCase):
    def test_section_cuts_are_never_the_render(self):
        import tempfile, os, time
        from verdict import newest_render
        with tempfile.TemporaryDirectory() as d:
            q = Path(d) / "videos" / "proof" / "480p15"; (q / "sections").mkdir(parents=True)
            (q / "Proof.mp4").write_bytes(b"x"); time.sleep(0.01)
            (q / "sections" / "Proof_0001_Setup.mp4").write_bytes(b"x")
            self.assertEqual(newest_render(Path(d)).name, "Proof.mp4")

if __name__ == "__main__": unittest.main()
