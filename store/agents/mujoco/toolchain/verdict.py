#!/usr/bin/env python
"""Judge the workspace's latest rollout and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py            # out/rollout.json + its video

Phases: Model (a simulation script exists under sim/ or an MJCF under scenes/), Simulate (a rollout
report exists and did not diverge), Render (its video exists). Ready = simulated and rendered.

The artifact — what the pane opens — is the trajectory, `out/rollout.qpos.json`, so the pane can
replay the rollout in 3D. The mp4 stays a deliverable, and is the artifact when there is no
trajectory to replay.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()


def judge(has_model: bool, report: dict | None, video_ok: bool, trajectory: str | None = None) -> dict:
    findings: list[dict] = []
    simulated = report is not None and not report.get("nan")
    if report is not None and report.get("nan"):
        findings.append({"severity": "error", "kind": "simulate", "message": "the simulation diverged (NaN in qpos) — smaller timestep, gentler gains, or check the model"})
    if report is not None and (report.get("max_qvel") or 0) > 200:
        findings.append({"severity": "warning", "kind": "simulate", "message": f"joint velocities reached {report['max_qvel']:.0f} rad/s — the rollout is probably exploding"})
    if simulated and video_ok and not trajectory:
        findings.append({"severity": "info", "kind": "replay", "message": "no out/rollout.qpos.json, so the pane cannot replay this rollout in 3D — record() writes one when it knows the model's MJCF (pass model_path=... if it does not)"})
    rendered = simulated and video_ok
    phases = [
        {"id": "model", "name": "Model", "state": "done" if has_model else "active"},
        {"id": "simulate", "name": "Simulate", "state": ("done" if simulated else ("failed" if report else "active")) if has_model else "pending"},
        {"id": "render", "name": "Render", "state": ("done" if rendered else "active") if simulated else "pending"},
    ]
    bits = []
    if report:
        m = report.get("model", {})
        bits.append(f"{Path(report.get('video', 'rollout.mp4')).name} · {report.get('seconds', 0):.1f} s")
        bits.append(f"{m.get('nbody', '?')} bodies · {m.get('nu', '?')} actuators")
        bits.append("diverged" if report.get("nan") else "stable")
    else:
        bits.append("no rollout yet" if has_model else "no simulation yet")
    return {"spec": 1, "ready": bool(rendered), "summary": " · ".join(bits), "findings": findings,
            "artifact": trajectory or (os.path.relpath(WS / report["video"], WS) if report and video_ok else None),
            "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def main(argv: list[str]) -> int:
    has_model = any((WS / "sim").glob("*.py")) or any((WS / "scenes").glob("*.xml"))
    report_path = WS / "out" / "rollout.json"
    report = None
    if report_path.exists():
        try:
            report = json.loads(report_path.read_text())
        except ValueError:
            report = None
    video = WS / report["video"] if report and report.get("video") else None
    video_ok = bool(video and video.exists() and video.stat().st_size > 1000)
    trajectory = (report or {}).get("trajectory") or "out/rollout.qpos.json"
    traj_path = WS / trajectory
    verdict = judge(bool(has_model), report, video_ok, trajectory if traj_path.exists() and traj_path.stat().st_size > 2 else None)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
