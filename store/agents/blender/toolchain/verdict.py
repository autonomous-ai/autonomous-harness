#!/usr/bin/env python
"""Judge the workspace's model and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py

Phases: Model (a script under scenes/ and a report with geometry), Export (a glTF exists), Render (a
preview or turntable exists). Ready = modelled and rendered. The glTF is the artifact — the pane is a
live 3D viewport (outliner, measure, section, the scene camera) and the turntable and the still are
its secondary views — so the artifact is the export the report names, else out/model.glb, else the
newest .glb under out/. A verdict never names the turntable: that would open the pane on a video.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()


def judge(has_script: bool, report: dict | None, glb: bool, preview: bool, turntable: bool, glb_path: str = "out/model.glb") -> dict:
    findings: list[dict] = []
    modelled = bool(report and report.get("faces", 0) > 0)
    if report is not None and not modelled:
        findings.append({"severity": "error", "kind": "model", "message": "the scene has no geometry"})
    if modelled and report and report.get("faces", 0) > 2_000_000:
        findings.append({"severity": "warning", "kind": "model", "message": f"{report['faces']:,} faces — heavy for a glTF; lower the subdivision"})
    if modelled and not glb:
        findings.append({"severity": "warning", "kind": "export", "message": "no glTF export — the 3D pane has nothing to show; call export_glb(\"out/model.glb\")"})
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
    artifact = glb_path if glb else None
    return {"spec": 1, "ready": bool(rendered), "summary": " · ".join(bits), "findings": findings, "artifact": artifact,
            "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def glb_path(report: dict | None, ok) -> str | None:
    """The export to show: the one the report names, out/model.glb, or the newest glTF under out/."""
    named = ((report or {}).get("files") or {}).get("glb")
    if isinstance(named, str) and ok(named):
        return named
    if ok("out/model.glb"):
        return "out/model.glb"
    found = [p for p in (WS / "out").rglob("*") if p.suffix.lower() in (".glb", ".gltf") and not p.name.startswith(".")] if (WS / "out").is_dir() else []
    found = [p for p in found if ok(p.relative_to(WS).as_posix())]
    return max(found, key=lambda p: p.stat().st_mtime).relative_to(WS).as_posix() if found else None


def main(argv: list[str]) -> int:
    has_script = any((WS / "scenes").glob("*.py"))
    rp = WS / "out" / "report.json"
    report = None
    if rp.exists():
        try:
            report = json.loads(rp.read_text())
        except ValueError:
            report = None
    ok = lambda p: bool(p) and (WS / p).is_file() and (WS / p).stat().st_size > 500
    verdict = judge(bool(has_script), report, bool(glb_path(report, ok)), ok("out/preview.png"), ok("out/turntable.mp4"), glb_path(report, ok) or "out/model.glb")
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
