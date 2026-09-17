"""The starter: a Unitree Go2 standing in its home pose, held by the model's own position actuators,
recorded for four seconds. Replace it — a different robot, your own MJCF under scenes/, a controller,
a policy."""
from harness_mujoco import load_menagerie, pd_hold, record

model, data = load_menagerie("unitree_go2")
record(model, data, pd_hold(), seconds=4, out="out/rollout.mp4", track="base")
