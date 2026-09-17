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

if __name__ == "__main__": unittest.main()
