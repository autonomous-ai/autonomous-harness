import json, sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from scene import Scene
from verdict import judge

class SceneAndVerdict(unittest.TestCase):
    def test_a_scene_is_valid_and_bound(self):
        s = Scene()
        a = s.box(0, 0, "API"); b = s.box(320, 0, "DB", shape="ellipse", color="green")
        arrow = s.arrow(a, b, "SQL"); s.frame([a, b], "Backend")
        data = s.to_dict()
        self.assertEqual(data["type"], "excalidraw")
        self.assertEqual(arrow["startBinding"]["elementId"], a["id"]); self.assertEqual(arrow["endBinding"]["elementId"], b["id"])
        self.assertIn({"id": arrow["id"], "type": "arrow"}, a["boundElements"])
        v = judge(json.loads(json.dumps(data)), "diagram.excalidraw")
        self.assertTrue(v["ready"], v); self.assertEqual(v["summary"], "diagram.excalidraw · 2 shapes · 1 arrow · valid")
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(data["elements"][0]["type"], "frame")
    def test_an_arrow_off_the_edge_starts_on_the_box_boundary(self):
        s = Scene(); a = s.box(0, 0, "A", w=100, h=50); b = s.box(300, 0, "B", w=100, h=50)
        arrow = s.arrow(a, b)
        self.assertAlmostEqual(arrow["x"], 100); self.assertAlmostEqual(arrow["y"], 25)
    def test_a_broken_binding_is_an_error(self):
        v = judge({"type": "excalidraw", "elements": [{"id": "x", "type": "arrow", "startBinding": {"elementId": "nope"}, "endBinding": None}]}, "d.excalidraw")
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
    def test_not_a_scene(self):
        v = judge({"hello": 1}, "d.excalidraw"); self.assertFalse(v["ready"]); self.assertIsNone(v["artifact"])

if __name__ == "__main__": unittest.main()
