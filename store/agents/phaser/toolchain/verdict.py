#!/usr/bin/env python3
"""Judge the workspace's Phaser game and write .harness/verdict.json (spec 1).

    python3 "$PHASER_TOOLCHAIN/verdict.py"             # the full check
    python3 "$PHASER_TOOLCHAIN/verdict.py" --no-build  # skip the bundle (seeding, a quick pass)

Phases:

  Write   src/main.js exists and at least one file declares a Phaser scene.
  Build   `vite build --outDir out/dist` succeeds — the compile check. A syntax error, a missing
          import, an unresolved module all land here, as findings with the file and line.
  Play    a static read of the scenes: one of them has a `create()`, and the game handles input
          (cursor keys, addKey/addKeys, a pointer handler, an interactive object). It cannot tell
          whether the game is *fun*; it can tell that nothing would respond to the player.

Ready = it builds and something would respond. The artifact is the built page when there is one;
the pane is the dev server either way.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
VITE = os.environ.get("VITE") or str(WS / "node_modules" / ".bin" / "vite")

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SCENE = re.compile(r"extends\s+(?:Phaser\.)?Scene\b")
CREATE = re.compile(r"(?:^|\W)create\s*\(", re.M)
INPUT = re.compile(
    r"this\.input\b|createCursorKeys|addKeys?\s*\(|setInteractive|on\(\s*['\"]pointer|"
    r"input\.keyboard|Phaser\.Input\b"
)
GATE = re.compile(r"input\.once\s*\(\s*['\"]pointerdown")


def source_files(ws: Path) -> list[Path]:
    """Every hand-written .js/.ts under src/ — never node_modules, never the build output."""
    if not (ws / "src").is_dir():
        return []
    skip = {"node_modules", "out", "dist", ".vite"}
    return sorted(
        p for p in (ws / "src").rglob("*")
        if p.suffix in (".js", ".mjs", ".ts") and p.is_file() and not (skip & set(p.parts))
    )


def build_message(output: str) -> str:
    """The one line of a vite build failure worth showing in the pane header."""
    lines = [ANSI.sub("", line).rstrip() for line in output.splitlines()]
    lines = [line for line in lines if line.strip()]
    if not lines:
        return "vite build failed with no output"
    for i, line in enumerate(lines):
        if "error during build" in line.lower():
            # What follows is the message, then Rollup's own `file:` line and a JS stack. The
            # message is the part a person can act on; the stack is noise in a pane header.
            rest: list[str] = []
            for candidate in lines[i + 1:i + 6]:
                text = candidate.strip()
                if not text:
                    continue
                if text.startswith(("file:", "at ", "    at ")):
                    break
                rest.append(text)
            if rest:
                return " ".join(rest)[:300]
    for line in lines:
        if re.search(r"\bERROR\b|error TS\d|Could not resolve|Transform failed", line):
            return line.strip()[:300]
    return lines[-1].strip()[:300]


def judge(written: bool, scenes: list[str], build_err: str | None, play: dict,
          artifact: str | None, build_ran: bool = True) -> dict:
    """Pure: the whole verdict from the facts gathered above. Unit-tested without vite.

    `build_ran` is false on a `--no-build` pass: the Build phase then says "still to check" rather
    than claiming a success nobody verified, and `ready` stays false until a real build says so.
    """
    findings: list[dict] = []
    if build_err:
        findings.append({"severity": "error", "kind": "build", "message": build_err})
    if written and not scenes:
        findings.append({"severity": "error", "kind": "scene",
                         "message": "no scene: a game needs a class that extends Phaser.Scene"})
    built = written and bool(scenes) and build_ran and build_err is None
    if scenes and not play.get("create"):
        findings.append({"severity": "warning", "kind": "scene",
                         "message": "no scene has a create() — nothing is put on the screen"})
    if scenes and not play.get("input"):
        findings.append({"severity": "warning", "kind": "input",
                         "message": "no input handling — nothing would respond to the player"})
    if scenes and not play.get("gate"):
        findings.append({"severity": "info", "kind": "focus",
                         "message": "no click-to-play gate: the pane has no keyboard focus until the "
                                    "player clicks, so the first scene should wait on "
                                    "this.input.once('pointerdown', …)"})
    playable = bool(scenes) and bool(play.get("create")) and bool(play.get("input"))

    if not written:
        build_state = "pending"
    elif build_err or not scenes:
        build_state = "failed"
    elif not build_ran:
        build_state = "active"
    else:
        build_state = "done"
    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active"},
        {"id": "build", "name": "Build", "state": build_state},
        {"id": "play", "name": "Play", "state": ("done" if playable else "active") if built else "pending"},
    ]

    bits: list[str] = []
    if scenes:
        bits.append(f"{len(scenes)} scene{'s' if len(scenes) != 1 else ''}: "
                    f"{', '.join(scenes[:4])}{'…' if len(scenes) > 4 else ''}")
    if not written:
        bits.append("no game yet")
    elif build_err:
        bits.append("does not build")
    elif scenes and not build_ran:
        bits.append("not built yet")
    elif built:
        bits.append("builds · plays" if playable else "builds · nothing responds yet")
    errors = sum(1 for f in findings if f["severity"] == "error")
    warnings = sum(1 for f in findings if f["severity"] == "warning")
    if errors or warnings:
        bits.append(", ".join(x for x in (
            f"{errors} error{'s' if errors != 1 else ''}" if errors else "",
            f"{warnings} warning{'s' if warnings != 1 else ''}" if warnings else "") if x))

    verdict = {
        "spec": 1,
        "ready": bool(built and playable),
        "summary": " · ".join(bits)[:200],
        "findings": findings,
        "phases": phases,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if artifact:
        verdict["artifact"] = artifact
    return verdict


def main(argv: list[str]) -> int:
    no_build = "--no-build" in argv
    files = source_files(WS)
    written = (WS / "src" / "main.js").exists() or (WS / "src" / "main.ts").exists()
    scenes: list[str] = []
    play = {"create": False, "input": False, "gate": False}
    for path in files:
        try:
            text = path.read_text(encoding="utf8", errors="replace")
        except OSError:
            continue
        if SCENE.search(text):
            scenes.append(path.stem)
        if CREATE.search(text):
            play["create"] = True
        if INPUT.search(text):
            play["input"] = True
        if GATE.search(text):
            play["gate"] = True

    build_err: str | None = None
    build_ran = bool(written and scenes and not no_build)
    if build_ran:
        try:
            run = subprocess.run(
                [VITE, "build", "--outDir", "out/dist", "--minify", "false", "--logLevel", "warn"],
                capture_output=True, text=True, cwd=WS, timeout=600)
            if run.returncode != 0:
                build_err = build_message(run.stderr + "\n" + run.stdout)
        except (OSError, subprocess.TimeoutExpired) as error:
            build_err = f"vite could not run ({error})"

    out = WS / "out" / "dist" / "index.html"
    artifact = "out/dist/index.html" if out.exists() else None
    verdict = judge(written, scenes, build_err, play, artifact, build_ran)

    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for finding in verdict["findings"]:
        print(f"  {finding['severity']:<7} {finding['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
