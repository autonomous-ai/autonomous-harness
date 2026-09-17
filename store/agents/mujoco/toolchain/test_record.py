"""record() writes what the MuJoCo Viewer pane needs to run a rollout live. Needs mujoco (the venv):

    "$MUJOCO_PYTHON" -m unittest toolchain/test_record.py
"""
import importlib, json, os, sys, tempfile, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
try:
    import mujoco  # noqa: F401
except ImportError:  # the verdict tests run without mujoco; these cannot
    mujoco = None

SCENE = """<mujoco model="cart">
  <option timestep="0.002"/>
  <worldbody>
    <geom type="plane" size="2 2 .1"/>
    <body name="cart" pos="0 0 .1">
      <joint name="slide" type="slide" axis="1 0 0"/>
      <geom type="box" size=".1 .1 .05" mass="1"/>
    </body>
  </worldbody>
  <actuator><motor name="push" joint="slide" gear="1" ctrlrange="-5 5"/></actuator>
  <keyframe><key name="rest" qpos="0" ctrl="0"/></keyframe>
</mujoco>
"""


@unittest.skipIf(mujoco is None, "mujoco is not installed in this interpreter")
class Record(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self.tmp.name)
        (self.ws / "scenes").mkdir()
        (self.ws / "scenes" / "cart.xml").write_text(SCENE)
        self.cwd = os.getcwd()
        os.chdir(self.ws)
        os.environ["HARNESS_WORKSPACE"] = str(self.ws)
        for name in ("harness_mujoco", "verdict"):
            sys.modules.pop(name, None)
        self.hm = importlib.import_module("harness_mujoco")

    def tearDown(self):
        os.chdir(self.cwd)
        os.environ.pop("HARNESS_WORKSPACE", None)
        self.tmp.cleanup()

    def rollout(self):
        return json.loads((self.ws / "out" / "rollout.qpos.json").read_text())

    def test_the_trajectory_carries_state_and_controls_frame_by_frame(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        report = self.hm.record(model, data, lambda m, d, t: d.ctrl.__setitem__(0, 2.0 if t < 0.5 else -2.0), seconds=1.0, fps=25, video=False)
        t = self.rollout()
        self.assertEqual(t["status"], "done")
        self.assertEqual(t["model"], "scenes/cart.xml")
        self.assertIsNone(t["model_xml"], "loaded from a file: the file is the model")
        self.assertEqual(len(t["qpos"]), 26, "the first state, then one row per frame")
        self.assertEqual(len(t["qvel"]), 26)
        self.assertEqual(len(t["ctrl"]), 26)
        self.assertEqual(t["ctrl"][0], [2.0])
        self.assertEqual(t["ctrl"][-2], [-2.0])
        self.assertAlmostEqual(t["dt"], 20 * 0.002, msg="the frame period is whole steps, not 1/fps")
        self.assertAlmostEqual(t["time"][1] - t["time"][0], t["dt"], places=6)
        self.assertIsNone(t["video"])
        self.assertEqual(report["trajectory"], "out/rollout.qpos.json")
        verdict = json.loads((self.ws / ".harness" / "verdict.json").read_text())
        self.assertTrue(verdict["ready"], "record() refreshes the verdict")
        self.assertEqual(verdict["artifact"], "out/rollout.qpos.json")

    def test_a_spec_edited_model_is_saved_as_compiled(self):
        spec = mujoco.MjSpec.from_file("scenes/cart.xml")
        spec.actuators[0].set_to_position(kp=50, kv=5)
        model = spec.compile()
        data = mujoco.MjData(model)
        del spec  # a spec built in a helper is gone by the time record() runs
        self.hm.record(model, data, None, seconds=0.2, video=False)
        t = self.rollout()
        self.assertEqual(t["model"], "scenes/cart.xml")
        self.assertEqual(t["model_xml"], "out/rollout.model.xml")
        snapshot = mujoco.MjModel.from_xml_path(str(self.ws / "out" / "rollout.model.xml"))
        self.assertEqual(snapshot.actuator_biastype[0], mujoco.mjtBias.mjBIAS_AFFINE, "the snapshot has the servo, not the motor")
        self.assertEqual(t["model_patch"], {})
        stamp = (self.ws / "out" / "rollout.model.xml").stat().st_mtime_ns
        spec2 = mujoco.MjSpec.from_file("scenes/cart.xml")
        spec2.actuators[0].set_to_position(kp=50, kv=5)
        model2 = spec2.compile()
        self.hm.record(model2, mujoco.MjData(model2), None, seconds=0.1, video=False)
        self.assertEqual((self.ws / "out" / "rollout.model.xml").stat().st_mtime_ns, stamp, "an unchanged model is not rewritten")

    def test_runtime_edits_ride_along_as_a_patch(self):
        model, data = self.hm.load_xml("scenes/cart.xml")
        model.opt.timestep = 0.001
        model.dof_damping[0] = 3.0
        self.hm.record(model, data, None, seconds=0.1, video=False)
        patch = self.rollout()["model_patch"]
        self.assertEqual(patch["opt.timestep"], 0.001)
        self.assertEqual(patch["dof_damping"], [3.0])

    def test_servos_and_pd_hold_keep_a_pose(self):
        xml = SCENE.replace('<key name="rest" qpos="0" ctrl="0"/>', '<key name="rest" qpos="0.3" ctrl="0.3"/>')
        (self.ws / "scenes" / "cart.xml").write_text(xml)
        model, data = self.hm.load_xml("scenes/cart.xml")
        data.qpos[0] = 0.0
        self.hm.record(model, data, self.hm.pd_hold(kp=80, kd=10), seconds=2.0, video=False)
        self.assertAlmostEqual(self.rollout()["qpos"][-1][0], 0.3, delta=0.02, msg="PD torque on a motor reaches the keyframe pose")

    def test_an_unknown_model_cannot_be_replayed_and_says_so(self):
        model = mujoco.MjModel.from_xml_string(SCENE)
        data = mujoco.MjData(model)
        report = self.hm.record(model, data, None, seconds=0.1, video=False)
        self.assertIsNone(report["trajectory"])
        self.assertFalse((self.ws / "out" / "rollout.qpos.json").exists())


if __name__ == "__main__":
    unittest.main()
