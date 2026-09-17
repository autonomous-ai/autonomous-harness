import json, os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import verdict
from verdict import judge

STABLE = {"video": "out/rollout.mp4", "seconds": 4.0, "model": {"nbody": 18, "nu": 12}, "nan": False, "max_qvel": 12.0,
          "model_path": "menagerie/unitree_go2/scene.xml", "trajectory": "out/rollout.qpos.json"}


class Judge(unittest.TestCase):
    def test_a_recorded_rollout_is_ready_and_the_pane_opens_the_trajectory(self):
        v = judge(True, STABLE, True, "out/rollout.qpos.json")
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual([p["id"] for p in v["phases"]], ["model", "simulate", "record"])
        self.assertEqual(v["artifact"], "out/rollout.qpos.json")
        self.assertEqual(v["findings"], [])

    def test_the_header_names_the_robot_not_the_video(self):
        v = judge(True, STABLE, True, "out/rollout.qpos.json")
        self.assertEqual(v["summary"], "unitree_go2 · 4.0 s · 18 bodies · 12 actuators · stable")
        self.assertNotIn("mp4", v["summary"])
        own = judge(True, {**STABLE, "model_path": "scenes/arm.xml"}, True, "out/rollout.qpos.json")
        self.assertTrue(own["summary"].startswith("arm.xml · "))

    def test_the_video_is_never_the_artifact(self):
        without_trajectory = judge(True, STABLE, True, None)
        self.assertEqual(without_trajectory["artifact"], "out/rollout.json", "the report still names the model")
        self.assertFalse(without_trajectory["ready"], "the pane cannot run it, so it is not done")
        self.assertEqual([f["kind"] for f in without_trajectory["findings"]], ["replay"])
        self.assertEqual(without_trajectory["findings"][0]["severity"], "warning")
        for v in (without_trajectory, judge(True, STABLE, True, "out/rollout.qpos.json"), judge(True, None, True)):
            self.assertFalse(str(v["artifact"]).endswith(".mp4"))

    def test_a_rollout_needs_no_video(self):
        v = judge(True, {**STABLE, "video": None}, False, "out/rollout.qpos.json")
        self.assertTrue(v["ready"])

    def test_an_old_trajectory_without_controls_replays_but_says_so(self):
        v = judge(True, STABLE, True, "out/rollout.qpos.json", ctrl_recorded=False)
        self.assertTrue(v["ready"])
        self.assertEqual([(f["severity"], f["kind"]) for f in v["findings"]], [("info", "replay")])

    def test_recording_moves_the_header_while_the_rollout_runs(self):
        v = judge(True, None, False, None, recording={"frames": 61, "dt": 0.034, "seconds": 5.0, "model": "menagerie/unitree_go2/scene.xml"})
        self.assertFalse(v["ready"])
        self.assertEqual(v["artifact"], "out/rollout.qpos.json")
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["summary"], "recording unitree_go2 · 2.0 / 5.0 s")

    def test_divergence_fails_simulate(self):
        v = judge(True, {"video": "out/rollout.mp4", "seconds": 1.0, "model": {}, "nan": True}, True)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed"); self.assertEqual(v["findings"][0]["severity"], "error")

    def test_nothing_yet(self):
        v = judge(False, None, False)
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertIsNone(v["artifact"])


class Main(unittest.TestCase):
    """verdict.py on a workspace: what it reads, what it writes."""

    def run_in(self, files: dict) -> dict:
        with tempfile.TemporaryDirectory() as ws:
            for rel, body in files.items():
                path = Path(ws) / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body if isinstance(body, str) else json.dumps(body))
            verdict.WS = Path(ws)
            try:
                verdict.main([])
            finally:
                verdict.WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
            return json.loads((Path(ws) / ".harness" / "verdict.json").read_text())

    def test_a_trajectory_mid_write_is_a_recording(self):
        v = self.run_in({"sim/hello.py": "", "out/rollout.qpos.json": {"status": "recording", "model": "menagerie/unitree_go2/scene.xml", "dt": 0.034, "seconds": 4, "qpos": [[0]] * 30}})
        self.assertEqual(v["phases"][1]["state"], "active")
        self.assertTrue(v["summary"].startswith("recording unitree_go2"))

    def test_a_finished_rollout(self):
        v = self.run_in({"sim/hello.py": "", "out/rollout.json": STABLE,
                         "out/rollout.qpos.json": {"status": "done", "model": "menagerie/unitree_go2/scene.xml", "nu": 12, "qpos": [[0]], "ctrl": [[0] * 12]}})
        self.assertTrue(v["ready"])
        self.assertEqual(v["artifact"], "out/rollout.qpos.json")


if __name__ == "__main__": unittest.main()
