"""The starter: a Unitree Go2 standing in its home pose. Its torque motors become position servos
(PD in the model, like the real robot's low-level position mode), held at the "home" keyframe and
recorded for four seconds — the pane opens it as a live simulation you can push. Replace it: a
different robot, your own MJCF under scenes/, a controller, a policy."""
from harness_mujoco import load_menagerie, pd_hold, record

model, data = load_menagerie("unitree_go2", servos=(60, 2))
record(model, data, pd_hold(), seconds=4, track="base")
