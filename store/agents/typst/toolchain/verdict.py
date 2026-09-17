#!/usr/bin/env python3
"""Compile the workspace's main.typ (or the given .typ) and write .harness/verdict.json (spec 1).

    python3 toolchain/verdict.py            # main.typ → out/main.pdf
    python3 toolchain/verdict.py paper.typ  # paper.typ → out/paper.pdf

Errors and warnings come from Typst's own diagnostics. Ready = it compiles. Phases: Write (a .typ
exists with content), Compile (no errors), Review (no warnings either). The PDF is the artifact.
"""
from __future__ import annotations
import json, os, re, subprocess, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
TYPST = os.environ.get("TYPST") or str(Path(os.environ.get("HARNESS_DSH_DIR", "")) / "bin" / "typst")


def judge(source: str, diagnostics: str, code: int, pdf: str | None, pages: int | None) -> dict:
    findings = []
    for m in re.finditer(r"^(error|warning): (.+?)$(?:\n\s+┌─ (\S+?):(\d+):(\d+))?", diagnostics, re.M):
        sev, msg, file, line, col = m.groups()
        findings.append({"severity": "error" if sev == "error" else "warning", "kind": "typst", "message": msg.strip(), **({"ref": f"{file}:{line}:{col}"} if file else {})})
    errors = [f for f in findings if f["severity"] == "error"]
    written = len(source.strip()) > 0
    compiled = code == 0 and not errors and pdf is not None
    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active"},
        {"id": "compile", "name": "Compile", "state": ("done" if compiled else "failed") if written else "pending"},
        {"id": "review", "name": "Review", "state": "pending" if not compiled else ("active" if findings else "done")},
    ]
    bits = []
    if pdf: bits.append(Path(pdf).name)
    if pages: bits.append(f"{pages} page{'s' if pages != 1 else ''}")
    bits.append("compiles" if compiled else (f"{len(errors)} error{'s' if len(errors) != 1 else ''}" if errors else "not compiled"))
    return {"spec": 1, "ready": compiled, "summary": " · ".join(bits), "findings": findings, "artifact": pdf, "phases": phases,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def page_count(pdf: Path) -> int | None:
    try:
        # /Type/Page, not /Pages and not /PageLabel (Typst writes one per page, which doubled the count).
        return len(re.findall(rb"/Type\s*/Page(?![A-Za-z])", pdf.read_bytes())) or None
    except OSError:
        return None


def main(argv: list[str]) -> int:
    src = Path(argv[1]) if len(argv) > 1 else WS / "main.typ"
    src = src if src.is_absolute() else WS / src
    out = WS / "out" / (src.stem + ".pdf")
    out.parent.mkdir(parents=True, exist_ok=True)
    source = src.read_text() if src.exists() else ""
    code, diag = 1, "error: no main.typ in the workspace"
    if src.exists():
        r = subprocess.run([TYPST, "compile", "--root", str(WS), str(src), str(out)], capture_output=True, text=True, cwd=WS)
        code, diag = r.returncode, r.stderr
    pdf = os.path.relpath(out, WS) if out.exists() and code == 0 else (os.path.relpath(out, WS) if out.exists() else None)
    verdict = judge(source, diag, code, pdf, page_count(out) if out.exists() else None)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}" + (f"  ({f['ref']})" if f.get("ref") else ""))
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
