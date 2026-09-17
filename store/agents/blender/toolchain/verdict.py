#!/usr/bin/env python
"""Judge the workspace's model and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py

Phases: Model (a script under scenes/ and a report with geometry), Export (out/model.glb exists),
Render (a preview or turntable exists). Ready = modelled and rendered. The glTF is the artifact —
the pane is a 3D viewer you can orbit; the turntable and the still are deliverables.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()


def judge(has_script: bool, report: dict | None, glb: bool, preview: bool, turntable: bool) -> dict:
    findings: list[dict] = []
    modelled = bool(report and report.get("faces", 0) > 0)
    if report is not None and not modelled:
        findings.append({"severity": "error", "kind": "model", "message": "the scene has no geometry"})
    if modelled and report and report.get("faces", 0) > 2_000_000:
        findings.append({"severity": "warning", "kind": "model", "message": f"{report['faces']:,} faces — heavy for a glTF; lower the subdivision"})
    rendered = modelled and (preview or turntable)
    phases = [
        {"id": "model", "name": "Model", "state": ("done" if modelled else ("failed" if report else "active")) if has_script else "active"},
        {"id": "export", "name": "Export", "state": ("done" if glb else "active") if modelled else "pending"},
        {"id": "render", "name": "Render", "state": ("done" if rendered else "active") if modelled else "pending"},
    ]
    bits = []
    if modelled and report:
        n = len(report.get("objects", []))
        bits.append(f"{n} object{'s' if n != 1 else ''} · {report.get('faces', 0):,} faces")
        size = report.get("size_mm")
        if size:
            bits.append("×".join(f"{v:g}" for v in size) + " mm")
        bits.append("glb" if glb else "no glb")
    else:
        bits.append("no model yet")
    # The pane is a 3D viewer: the glTF is what it shows; the turntable and still are deliverables.
    artifact = "out/model.glb" if glb else None
    return {"spec": 1, "ready": bool(rendered), "summary": " · ".join(bits), "findings": findings, "artifact": artifact,
            "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def main(argv: list[str]) -> int:
    has_script = any((WS / "scenes").glob("*.py"))
    rp = WS / "out" / "report.json"
    report = None
    if rp.exists():
        try:
            report = json.loads(rp.read_text())
        except ValueError:
            report = None
    ok = lambda p: (WS / p).exists() and (WS / p).stat().st_size > 500
    verdict = judge(bool(has_script), report, ok("out/model.glb"), ok("out/preview.png"), ok("out/turntable.mp4"))
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
