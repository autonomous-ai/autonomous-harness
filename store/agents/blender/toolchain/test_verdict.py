import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from verdict import judge

class Judge(unittest.TestCase):
    def test_modelled_exported_rendered(self):
        v = judge(True, {"objects": ["Mug", "Handle"], "faces": 12400, "size_mm": [90, 90, 100]}, True, True, True)
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "2 objects · 12,400 faces · 90×90×100 mm · glb"); self.assertEqual(v["artifact"], "out/model.glb")
    def test_empty_scene_fails_model(self):
        v = judge(True, {"objects": [], "faces": 0}, False, False, False)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][0]["state"], "failed")
    def test_preview_only(self):
        v = judge(True, {"objects": ["a"], "faces": 12, "size_mm": [1, 1, 1]}, False, True, False)
        self.assertTrue(v["ready"]); self.assertIsNone(v["artifact"]); self.assertEqual(v["phases"][1]["state"], "active")

if __name__ == "__main__": unittest.main()
