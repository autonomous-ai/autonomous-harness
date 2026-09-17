import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from verdict import judge

class Judge(unittest.TestCase):
    def test_bundles_with_a_render(self):
        v = judge(True, ["Main", "Intro"], None, "out/main.mp4", False)
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "2 compositions: Main, Intro · main.mp4")
    def test_bundle_error(self):
        v = judge(True, [], "src/Main.tsx(12,5): error TS2304: Cannot find name 'foo'.", None, False)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
    def test_stale_render_is_a_warning(self):
        v = judge(True, ["Main"], None, "out/main.mp4", True)
        self.assertTrue(v["ready"]); self.assertEqual(v["phases"][2]["state"], "active"); self.assertEqual(v["findings"][0]["severity"], "warning")

if __name__ == "__main__": unittest.main()
