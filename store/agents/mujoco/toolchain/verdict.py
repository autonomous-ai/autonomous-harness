#!/usr/bin/env python
"""Judge the workspace's latest rollout and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py            # out/rollout.json + out/rollout.qpos.json

Phases: Model (a simulation script under sim/ or an MJCF under scenes/), Simulate (a rollout ran and
did not diverge; active while `record` is still writing it), Record (the trajectory the pane runs is
there, with its controls, so the pane can re-simulate it). Ready = simulated and recorded.

The artifact — what the pane opens — is the trajectory, `out/rollout.qpos.json`, and the pane opens
it as a live simulation. Before there is one it is the report, which still names the model. It is
never the video: the mp4 is a deliverable to share, not what the pane shows.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
TRAJECTORY = "out/rollout.qpos.json"
REPORT = "out/rollout.json"


def model_name(path: str | None) -> str | None:
    """`menagerie/unitree_go2/scene.xml` → `unitree_go2`; `scenes/arm.xml` → `arm.xml`."""
    if not path:
        return None
    parts = path.split("/")
    if parts[0] == "menagerie" and len(parts) >= 3:
        return parts[1]
    return parts[-1]


def judge(has_model: bool, report: dict | None, video_ok: bool, trajectory: str | None = None,
          recording: dict | None = None, ctrl_recorded: bool = True) -> dict:
    findings: list[dict] = []
    if recording is not None:
        done = max(0, int(recording.get("frames", 0)) - 1) * float(recording.get("dt") or 0)
        name = model_name(recording.get("model")) or "rollout"
        phases = [
            {"id": "model", "name": "Model", "state": "done"},
            {"id": "simulate", "name": "Simulate", "state": "active"},
            {"id": "record", "name": "Record", "state": "pending"},
        ]
        return {"spec": 1, "ready": False, "summary": f"recording {name} · {done:.1f} / {float(recording.get('seconds') or 0):.1f} s",
                "findings": [], "artifact": TRAJECTORY, "phases": phases,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}

    simulated = report is not None and not report.get("nan")
    if report is not None and report.get("nan"):
        findings.append({"severity": "error", "kind": "simulate", "message": "the simulation diverged (NaN in qpos) — smaller timestep, gentler gains, or check the model"})
    if report is not None and (report.get("max_qvel") or 0) > 200:
        findings.append({"severity": "warning", "kind": "simulate", "message": f"joint velocities reached {report['max_qvel']:.0f} rad/s — the rollout is probably exploding"})
    if simulated and not trajectory:
        findings.append({"severity": "warning", "kind": "replay", "message": "no out/rollout.qpos.json, so the pane cannot run this rollout — record() writes one when it knows the model's MJCF (pass model_path=... if it does not)"})
    elif simulated and not ctrl_recorded:
        findings.append({"severity": "info", "kind": "replay", "message": "the trajectory has no controls, so the pane replays it but cannot re-simulate it — record it again with the current toolchain"})
    recorded = simulated and bool(trajectory)
    phases = [
        {"id": "model", "name": "Model", "state": "done" if has_model or report else "active"},
        {"id": "simulate", "name": "Simulate", "state": ("done" if simulated else ("failed" if report else "active")) if has_model or report else "pending"},
        {"id": "record", "name": "Record", "state": ("done" if recorded else "active") if simulated else "pending"},
    ]
    bits = []
    if report:
        m = report.get("model", {})
        name = model_name(report.get("model_path"))
        bits.append(f"{name + ' · ' if name else ''}{float(report.get('seconds', 0)):.1f} s")
        bits.append(f"{m.get('nbody', '?')} bodies · {m.get('nu', '?')} actuators")
        bits.append("diverged" if report.get("nan") else "stable")
    else:
        bits.append("no rollout yet" if has_model else "no simulation yet")
    artifact = trajectory or (REPORT if report else None)
    return {"spec": 1, "ready": bool(recorded), "summary": " · ".join(bits),
            "findings": findings, "artifact": artifact, "phases": phases,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def _read_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def main(argv: list[str]) -> int:
    has_model = any((WS / "sim").glob("*.py")) or any((WS / "scenes").glob("*.xml"))
    report = _read_json(WS / REPORT)
    trajectory_body = _read_json(WS / TRAJECTORY)
    recording = None
    trajectory = None
    ctrl_recorded = True
    if trajectory_body and isinstance(trajectory_body.get("qpos"), list):
        if trajectory_body.get("status") == "recording":
            recording = {"frames": len(trajectory_body["qpos"]), "dt": trajectory_body.get("dt"),
                         "seconds": trajectory_body.get("seconds"), "model": trajectory_body.get("model")}
        else:
            trajectory = TRAJECTORY
            ctrl_recorded = bool(trajectory_body.get("ctrl")) or not trajectory_body.get("nu", 1)
    video = WS / report["video"] if report and report.get("video") else None
    video_ok = bool(video and video.exists() and video.stat().st_size > 1000)
    verdict = judge(bool(has_model), report, video_ok, trajectory, recording, ctrl_recorded)
    (WS / ".harness").mkdir(exist_ok=True)
    tmp = WS / ".harness" / "verdict.json.tmp"
    tmp.write_text(json.dumps(verdict, indent=2) + "\n")
    os.replace(tmp, WS / ".harness" / "verdict.json")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
