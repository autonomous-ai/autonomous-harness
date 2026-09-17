#!/usr/bin/env python
"""Judge the workspace's notebook and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py                 # notebook.py
    python toolchain/verdict.py analysis.py

Phases: Write (cells exist), Check (`marimo check` finds no errors — unused names, cycles, multiple
definitions), Run (the notebook runs top to bottom as a script without an exception). Ready = it
runs. The notebook is the artifact; the pane is marimo's editor on it.
"""
from __future__ import annotations
import ast, json, os, subprocess, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
PY = sys.executable
MARIMO = os.environ.get("MARIMO") or str(Path(PY).parent / "marimo")


def count_cells(source: str) -> int:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return -1
    n = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            for d in node.decorator_list:
                name = d.func if isinstance(d, ast.Call) else d
                if isinstance(name, ast.Attribute) and name.attr in ("cell", "function", "class_definition"):
                    n += 1
    return n


def judge(cells: int, check_out: str, check_code: int | None, run_err: str | None, run_code: int | None, rel: str) -> dict:
    findings: list[dict] = []
    if cells < 0:
        findings.append({"severity": "error", "kind": "syntax", "message": f"{rel} does not parse"})
    for line in check_out.splitlines():
        line = line.strip()
        if not line or line.startswith(("Checking", "✓", "All checks")):
            continue
        sev = "error" if ("error" in line.lower() or "✗" in line or "MB" in line.split(":")[0]) else "warning"
        findings.append({"severity": sev, "kind": "check", "message": line[:300]})
    if run_code not in (None, 0):
        tail = (run_err or "").strip().splitlines()
        findings.append({"severity": "error", "kind": "run", "message": (tail[-1] if tail else f"the notebook exited {run_code}")[:300]})
    written = cells > 0
    errors = [f for f in findings if f["severity"] == "error"]
    checked = written and check_code == 0 and not any(f["kind"] in ("check", "syntax") for f in errors)
    ran = checked and run_code == 0
    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active"},
        {"id": "check", "name": "Check", "state": ("done" if checked else "failed") if written else "pending"},
        {"id": "run", "name": "Run", "state": ("done" if ran else "failed") if checked else "pending"},
    ]
    bits = [Path(rel).name]
    if written:
        bits.append(f"{cells} cell{'s' if cells != 1 else ''}")
    bits.append("runs" if ran else (f"{len(errors)} error{'s' if len(errors) != 1 else ''}" if errors else ("no cells yet" if not written else "not run")))
    return {"spec": 1, "ready": bool(ran), "summary": " · ".join(bits), "findings": findings, "artifact": rel if written else None,
            "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def main(argv: list[str]) -> int:
    target = Path(argv[1]) if len(argv) > 1 else WS / "notebook.py"
    target = target if target.is_absolute() else WS / target
    rel = os.path.relpath(target, WS)
    source = target.read_text() if target.exists() else ""
    cells = count_cells(source) if source else 0
    check_out, check_code, run_err, run_code = "", None, None, None
    if cells > 0:
        try:
            r = subprocess.run([MARIMO, "check", str(target)], capture_output=True, text=True, cwd=WS, timeout=120)
            check_out, check_code = (r.stdout + r.stderr), r.returncode
        except (OSError, subprocess.TimeoutExpired) as error:
            check_out, check_code = f"error: marimo check could not run ({error})", 1
        if check_code == 0:
            try:
                r = subprocess.run([PY, str(target)], capture_output=True, text=True, cwd=WS, timeout=300)
                run_err, run_code = r.stderr, r.returncode
            except subprocess.TimeoutExpired:
                run_err, run_code = "the notebook did not finish within 5 minutes", 1
    verdict = judge(cells, check_out, check_code, run_err, run_code, rel)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
