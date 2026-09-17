import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from verdict import judge

STABLE = {"video": "out/rollout.mp4", "seconds": 4.0, "model": {"nbody": 18, "nu": 12}, "nan": False, "max_qvel": 12.0}

class Judge(unittest.TestCase):
    def test_stable_rendered_rollout_is_ready(self):
        v = judge(True, STABLE, True)
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "rollout.mp4 · 4.0 s · 18 bodies · 12 actuators · stable")
    def test_the_trajectory_is_the_artifact_and_the_video_stays_a_deliverable(self):
        v = judge(True, {**STABLE, "trajectory": "out/rollout.qpos.json"}, True, "out/rollout.qpos.json")
        self.assertTrue(v["ready"]); self.assertEqual(v["artifact"], "out/rollout.qpos.json")
        self.assertIn("rollout.mp4", v["summary"]); self.assertEqual(v["findings"], [])
    def test_without_a_trajectory_the_video_is_the_artifact_and_the_pane_says_so(self):
        v = judge(True, STABLE, True)
        self.assertEqual(v["artifact"], "out/rollout.mp4")
        self.assertEqual([f["kind"] for f in v["findings"]], ["replay"])
        self.assertEqual(v["findings"][0]["severity"], "info")
    def test_divergence_fails_simulate(self):
        v = judge(True, {"video": "out/rollout.mp4", "seconds": 1.0, "model": {}, "nan": True}, True)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed"); self.assertEqual(v["findings"][0]["severity"], "error")
    def test_nothing_yet(self):
        v = judge(False, None, False); self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertIsNone(v["artifact"])

if __name__ == "__main__": unittest.main()
