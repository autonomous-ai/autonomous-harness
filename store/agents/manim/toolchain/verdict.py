#!/usr/bin/env python
"""Judge the workspace's renders and write .harness/verdict.json (spec 1).

    python toolchain/verdict.py                  # the newest render under out/
    python toolchain/verdict.py out/videos/.../Intro.mp4

Phases: Write (a scene file under scenes/), Render (an mp4 or gif exists for it), Review (the render
is at least a second and has frames). Ready = a render exists and plays. The render is the artifact.
A render that failed after it (`.harness/render.json`, written by render.py) is an error: the pane
still plays the last good video, but it is not what the scene says any more.
"""
from __future__ import annotations
import json, os, subprocess, sys, time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
# sections/ holds --save_sections' per-chapter cuts of the render beside it: never the artifact.
SKIP = {".git", ".harness", ".venv", "node_modules", "__pycache__", "partial_movie_files", "sections", ".claude"}


def newest_render(root: Path) -> Path | None:
    best = None
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".")]
        for name in filenames:
            if name.lower().endswith((".mp4", ".webm", ".mov", ".gif")):
                p = Path(dirpath) / name; m = p.stat().st_mtime
                if best is None or m > best[0]: best = (m, p)
    return best[1] if best else None


def probe(path: Path) -> dict:
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,duration:format=duration", "-of", "json", str(path)], capture_output=True, text=True, timeout=60)
        d = json.loads(r.stdout or "{}")
        s = (d.get("streams") or [{}])[0]; f = d.get("format") or {}
        return {"width": s.get("width"), "height": s.get("height"), "frames": int(s.get("nb_frames") or 0) or None, "duration": float(s.get("duration") or f.get("duration") or 0) or None}
    except Exception:
        return {}


def judge(scenes: list[str], render: str | None, info: dict, failure: dict | None = None) -> dict:
    """failure: the last render attempt's error when it came after this render (see last_failure)."""
    written = bool(scenes)
    rendered = render is not None
    duration = info.get("duration"); frames = info.get("frames")
    plays = rendered and (duration or 0) >= 1.0 and (frames is None or frames > 1)
    findings = []
    if failure:
        where = f" ({failure['file']}:{failure['line']})" if failure.get("file") and failure.get("line") else ""
        what = f"{failure.get('type') or 'Error'}: {failure.get('message') or 'the render failed'}"
        findings.append({"severity": "error", "kind": "render_failed", "message": f"rendering {failure.get('scene') or 'the scene'} failed — {what}{where}", **({"ref": f"{failure['file']}:{failure['line']}"} if where else {})})
    if rendered and not plays:
        findings.append({"severity": "warning", "kind": "render", "message": f"{Path(render).name} is {duration or 0:.1f} s; a scene shorter than a second is a still"})
    render_state = ("done" if rendered else "active") if written else "pending"
    if failure: render_state = "failed"
    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active"},
        {"id": "render", "name": "Render", "state": render_state},
        {"id": "review", "name": "Review", "state": ("done" if plays and not failure else "active") if rendered else "pending"},
    ]
    bits = []
    if render: bits.append(Path(render).name)
    if duration: bits.append(f"{duration:.1f} s")
    if info.get("width") and info.get("height"): bits.append(f"{info['width']}×{info['height']}")
    if info.get("chapters"): bits.append(f"{info['chapters']} chapters")
    if failure: bits.append("last render failed")
    if not render: bits.append(f"{len(scenes)} scene{'s' if len(scenes) != 1 else ''}, no render yet" if written else "no scene yet")
    return {"spec": 1, "ready": bool(plays) and not failure, "summary": " · ".join(bits), "findings": findings, "artifact": render, "phases": phases,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def chapters(path: Path) -> int | None:
    """How many sections Manim saved for this render (--save_sections), when they belong to it."""
    index = path.parent / "sections" / f"{path.stem}.json"
    try:
        if index.stat().st_mtime < path.stat().st_mtime - 2: return None
        n = len(json.loads(index.read_text()))
        return n if n > 1 else None
    except (OSError, ValueError, TypeError):
        return None


def last_failure(target: Path | None) -> dict | None:
    """The error of the last render attempt, when render.py says it failed after the artifact was made."""
    try:
        status = json.loads((WS / ".harness" / "render.json").read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(status, dict) or status.get("state") != "failed": return None
    finished = (status.get("finishedAtMs") or status.get("updatedAtMs") or 0) / 1000
    if target is not None and target.is_file() and target.stat().st_mtime > finished: return None
    error = status.get("error") or {}
    return {**error, "scene": status.get("scene")}


def main(argv: list[str]) -> int:
    scenes = sorted(str(p.relative_to(WS)) for p in (WS / "scenes").glob("*.py")) if (WS / "scenes").is_dir() else []
    target = Path(argv[1]) if len(argv) > 1 else newest_render(WS / "out" if (WS / "out").is_dir() else WS)
    target = (target if target is None or target.is_absolute() else WS / target)
    render = os.path.relpath(target, WS) if target and target.is_file() else None
    info = probe(target) if render else {}
    if render and chapters(target): info["chapters"] = chapters(target)
    verdict = judge(scenes, render, info, last_failure(target if render else None))
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]: print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
