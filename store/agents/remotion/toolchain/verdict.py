#!/usr/bin/env python3
"""Judge the workspace's Remotion project and write .harness/verdict.json (spec 1).

    python3 toolchain/verdict.py

Phases: Write (src/Root.tsx exists), Bundle (`remotion compositions` bundles the project and lists
its compositions — the same bundle Studio and the renderer use), Render (an mp4 exists under out/
newer than the newest source file). Ready = it bundles. The newest render, when there is one, is
the artifact; the pane is Studio either way.
"""
from __future__ import annotations
import json, os, re, subprocess, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
REMOTION = os.environ.get("REMOTION") or str(WS / "node_modules" / ".bin" / "remotion")


def newest(root: Path, suffixes: tuple[str, ...]) -> Path | None:
    best: tuple[float, Path] | None = None
    for p in root.rglob("*"):
        if p.suffix.lower() in suffixes and p.is_file() and "node_modules" not in p.parts:
            m = p.stat().st_mtime
            if best is None or m > best[0]:
                best = (m, p)
    return best[1] if best else None


def judge(written: bool, comps: list[str], bundle_err: str | None, render: str | None, stale: bool) -> dict:
    findings: list[dict] = []
    if bundle_err:
        findings.append({"severity": "error", "kind": "bundle", "message": bundle_err[:400]})
    bundled = written and not bundle_err and bool(comps)
    if written and not bundle_err and not comps:
        findings.append({"severity": "error", "kind": "bundle", "message": "no compositions registered — <Composition id=… /> in src/Root.tsx"})
    if render and stale:
        findings.append({"severity": "warning", "kind": "render", "message": f"{Path(render).name} is older than the source — render again"})
    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active"},
        {"id": "bundle", "name": "Bundle", "state": ("done" if bundled else "failed") if written else "pending"},
        {"id": "render", "name": "Render", "state": ("done" if render and not stale else "active") if bundled else "pending"},
    ]
    bits = []
    if comps:
        bits.append(f"{len(comps)} composition{'s' if len(comps) != 1 else ''}: {', '.join(comps[:4])}{'…' if len(comps) > 4 else ''}")
    if render:
        bits.append(f"{Path(render).name}{' (stale)' if stale else ''}")
    if not bits:
        bits.append("bundles" if bundled else ("does not bundle" if written else "no project yet"))
    return {"spec": 1, "ready": bool(bundled), "summary": " · ".join(bits), "findings": findings,
            "artifact": render, "phases": phases, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def main(argv: list[str]) -> int:
    written = (WS / "src" / "Root.tsx").exists() and (WS / "src" / "index.ts").exists()
    comps: list[str] = []
    bundle_err = None
    if written:
        try:
            r = subprocess.run([REMOTION, "compositions", "src/index.ts", "--quiet"], capture_output=True, text=True, cwd=WS, timeout=600)
            if r.returncode != 0:
                lines = [l for l in (r.stderr + r.stdout).splitlines() if l.strip()]
                bundle_err = lines[-1] if lines else f"remotion compositions exited {r.returncode}"
            else:
                # One composition per line, its id first; anything that is not an id (a header, a
                # blank, progress) is dropped rather than counted.
                comps = []
                for line in r.stdout.splitlines():
                    first = line.strip().split()[0] if line.strip() else ""
                    if re.fullmatch(r"[A-Za-z0-9_\-]+", first) and first not in ("Bundling", "Getting", "Downloading", "Compositions", "id", "ID"):
                        comps.append(first)
        except (OSError, subprocess.TimeoutExpired) as error:
            bundle_err = f"remotion could not run ({error})"
    render = newest(WS / "out", (".mp4", ".webm", ".gif")) if (WS / "out").is_dir() else None
    source = newest(WS / "src", (".ts", ".tsx", ".css", ".json")) if (WS / "src").is_dir() else None
    stale = bool(render and source and source.stat().st_mtime > render.stat().st_mtime)
    verdict = judge(written, comps, bundle_err, os.path.relpath(render, WS) if render else None, stale)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
