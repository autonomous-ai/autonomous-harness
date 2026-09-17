#!/usr/bin/env python
"""Judge the workspace's newest STEP and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py            # newest STEP under the workspace (cwd)
    python toolchain/verdict.py STEP/x.step

Runs `cadgen step inspect validate` and `… refs --facts` on the file and turns them into the three
phases the pane header shows: Model (a script in src/), Build (a STEP on disk), Validate (every
solid closed and oriented). Ready is a valid STEP. The verdict names the STEP as the artifact, so
the CAD Viewer draws it.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

WORKSPACE = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
SKIP_DIRS = {".git", ".harness", ".venv", "node_modules", "tmp", "__pycache__", ".claude", ".agents"}


def newest_step(root: Path) -> Path | None:
    best: tuple[float, Path] | None = None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        for name in filenames:
            if name.lower().endswith((".step", ".stp")):
                path = Path(dirpath) / name
                mtime = path.stat().st_mtime
                if best is None or mtime > best[0]:
                    best = (mtime, path)
    return best[1] if best else None


def models(root: Path) -> list[Path]:
    src = root / "src"
    return sorted(p for p in src.glob("*.py")) if src.is_dir() else []


def cadgen(*args: str) -> dict:
    exe = os.environ.get("CADGEN") or str(Path(sys.executable).parent / "cadgen")
    try:
        out = subprocess.run([exe, *args, "--format", "json"], capture_output=True, text=True, cwd=WORKSPACE, timeout=600)
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "errors": [str(error)]}
    try:
        return json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {"ok": False, "errors": [out.stderr.strip()[:300]]}
    except json.JSONDecodeError:
        return {"ok": False, "errors": [(out.stderr or out.stdout).strip()[:300]]}


def judge(facts: dict, valid: dict, *, has_models: bool, step: str | None) -> dict:
    """Pure: the verdict for what the inspections said. Tested without cadgen."""
    findings: list[dict] = []
    for error in valid.get("errors") or []:
        findings.append({"severity": "error", "kind": "validate", "message": str(error)})
    for part in valid.get("parts") or []:
        if isinstance(part, dict) and part.get("ok") is False:
            findings.append({"severity": "error", "kind": "validate", "message": f"{part.get('name') or part.get('ref') or 'a solid'}: {part.get('reason') or 'invalid geometry'}", "ref": part.get("ref")})
    token = (facts.get("tokens") or [{}])[0]
    for warning in token.get("warnings") or []:
        findings.append({"severity": "warning", "kind": "facts", "message": str(warning)})
    for error in facts.get("errors") or []:
        findings.append({"severity": "error", "kind": "facts", "message": str(error)})
    summary_bits: list[str] = []
    summary = token.get("summary") or {}
    entry = token.get("entryFacts") or {}
    solids = summary.get("shapeCount")
    size = entry.get("size")
    if step:
        summary_bits.append(Path(step).name)
    if isinstance(solids, int):
        summary_bits.append(f"{solids} solid{'s' if solids != 1 else ''}")
    if isinstance(size, list) and len(size) == 3:
        summary_bits.append(" × ".join(f"{float(v):.0f}" for v in size) + " mm")
    validated = bool(step) and bool(valid.get("ok")) and int(valid.get("failureCount") or 0) == 0 and not any(f["severity"] == "error" for f in findings)
    if step:
        summary_bits.append("valid" if validated else "not valid")
    phases = [
        {"id": "model", "name": "Model", "state": "done" if has_models else "active"},
        {"id": "build", "name": "Build", "state": "done" if step else ("active" if has_models else "pending")},
        {"id": "validate", "name": "Validate", "state": ("done" if validated else "failed") if step else "pending"},
    ]
    return {
        "spec": 1,
        "ready": validated,
        "summary": " · ".join(summary_bits) if summary_bits else ("no STEP yet" if has_models else "no model yet"),
        "findings": findings,
        "artifact": step,
        "phases": phases,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def main(argv: list[str]) -> int:
    target = Path(argv[1]).resolve() if len(argv) > 1 else newest_step(WORKSPACE)
    has_models = bool(models(WORKSPACE))
    step_rel: str | None = None
    facts: dict = {}
    valid: dict = {}
    if target and target.is_file():
        step_rel = os.path.relpath(target, WORKSPACE)
        valid = cadgen("step", "inspect", "validate", step_rel)
        facts = cadgen("step", "inspect", "refs", "--facts", step_rel)
    verdict = judge(facts, valid, has_models=has_models, step=step_rel)
    out = WORKSPACE / ".harness" / "verdict.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for finding in verdict["findings"]:
        print(f"  {finding['severity']:<7} {finding['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
