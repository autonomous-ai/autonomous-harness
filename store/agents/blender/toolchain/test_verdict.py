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

    def test_artifact_is_the_named_export_never_the_video(self):
        v = judge(True, {"objects": ["a"], "faces": 12, "size_mm": [1, 1, 1]}, True, True, True, "out/lamp.glb")
        self.assertEqual(v["artifact"], "out/lamp.glb")
    def test_modelled_without_export_warns(self):
        v = judge(True, {"objects": ["a"], "faces": 12, "size_mm": [1, 1, 1]}, False, True, True)
        self.assertIsNone(v["artifact"]); self.assertEqual([f["kind"] for f in v["findings"]], ["export"])

class Artifact(unittest.TestCase):
    def test_report_then_model_then_newest(self):
        import tempfile, os, time, verdict
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d); (ws / "out").mkdir()
            verdict.WS = ws
            ok = lambda p: bool(p) and (ws / p).is_file() and (ws / p).stat().st_size > 500
            self.assertIsNone(verdict.glb_path(None, ok))
            (ws / "out/a.glb").write_bytes(b"x" * 600); time.sleep(0.02); (ws / "out/b.glb").write_bytes(b"x" * 600)
            self.assertEqual(verdict.glb_path(None, ok), "out/b.glb")
            (ws / "out/model.glb").write_bytes(b"x" * 600)
            self.assertEqual(verdict.glb_path(None, ok), "out/model.glb")
            self.assertEqual(verdict.glb_path({"files": {"glb": "out/a.glb"}}, ok), "out/a.glb")

if __name__ == "__main__": unittest.main()
