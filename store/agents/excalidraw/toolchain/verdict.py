#!/usr/bin/env python3
"""Judge the workspace's diagram and write .harness/verdict.json (spec 1).

    python3 toolchain/verdict.py                     # diagram.excalidraw
    python3 toolchain/verdict.py flows/checkout.excalidraw

Phases: Draw (the file has elements), Validate (it is a well-formed Excalidraw scene: every element
has an id and a type, bindings point at elements that exist), Review (no unbound arrows, no empty
labels). Ready = valid. The file is the artifact; the pane shows it.
"""
from __future__ import annotations
import json, os, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
SHAPES = {"rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "image", "frame", "magicframe", "embeddable", "iframe"}


def judge(data: object, rel: str) -> dict:
    findings: list[dict] = []
    elements: list[dict] = []
    valid = isinstance(data, dict) and data.get("type") == "excalidraw" and isinstance(data.get("elements"), list)
    if not valid:
        findings.append({"severity": "error", "kind": "schema", "message": f"{rel} is not an Excalidraw scene (type 'excalidraw' with an elements list)"})
    else:
        elements = [e for e in data["elements"] if isinstance(e, dict) and not e.get("isDeleted")]
        ids = {e.get("id") for e in elements}
        for e in elements:
            if not isinstance(e.get("id"), str) or e.get("type") not in SHAPES:
                findings.append({"severity": "error", "kind": "schema", "message": f"element {e.get('id')!r} has no id or an unknown type {e.get('type')!r}"})
            for key in ("startBinding", "endBinding"):
                b = e.get(key)
                if isinstance(b, dict) and b.get("elementId") not in ids:
                    findings.append({"severity": "error", "kind": "binding", "message": f"arrow {e.get('id')} is bound to a missing element {b.get('elementId')}"})
            if e.get("type") == "text" and e.get("containerId") and e["containerId"] not in ids:
                findings.append({"severity": "error", "kind": "binding", "message": f"text {e.get('id')} belongs to a missing container {e['containerId']}"})
        for e in elements:
            if e.get("type") == "arrow" and not (e.get("startBinding") and e.get("endBinding")):
                findings.append({"severity": "warning", "kind": "review", "message": f"arrow {e.get('id')} is not attached at both ends"})
            if e.get("type") == "text" and not str(e.get("text", "")).strip():
                findings.append({"severity": "warning", "kind": "review", "message": f"text {e.get('id')} is empty"})
    errors = [f for f in findings if f["severity"] == "error"]
    drawn = bool(elements)
    ok = valid and not errors and drawn
    counts: dict[str, int] = {}
    for e in elements:
        counts[e.get("type", "?")] = counts.get(e.get("type", "?"), 0) + 1
    shapes = sum(counts.get(k, 0) for k in ("rectangle", "ellipse", "diamond"))
    bits = [Path(rel).name]
    if drawn:
        bits.append(f"{shapes} shape{'s' if shapes != 1 else ''} · {counts.get('arrow', 0)} arrow{'s' if counts.get('arrow', 0) != 1 else ''}")
    bits.append("valid" if ok else (f"{len(errors)} error{'s' if len(errors) != 1 else ''}" if errors else "empty"))
    phases = [
        {"id": "draw", "name": "Draw", "state": "done" if drawn else "active"},
        {"id": "validate", "name": "Validate", "state": ("done" if ok else "failed") if drawn else "pending"},
        {"id": "review", "name": "Review", "state": "pending" if not ok else ("active" if findings else "done")},
    ]
    return {"spec": 1, "ready": ok, "summary": " · ".join(bits), "findings": findings, "artifact": rel if valid else None,
            "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def main(argv: list[str]) -> int:
    target = Path(argv[1]) if len(argv) > 1 else WS / "diagram.excalidraw"
    target = target if target.is_absolute() else WS / target
    rel = os.path.relpath(target, WS)
    try:
        data = json.loads(target.read_text())
    except (OSError, ValueError) as error:
        data = None
        verdict = judge(None, rel)
        verdict["findings"] = [{"severity": "error", "kind": "file", "message": f"{rel}: {error}"}]
        verdict["summary"] = f"{Path(rel).name} · unreadable"
    else:
        verdict = judge(data, rel)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
