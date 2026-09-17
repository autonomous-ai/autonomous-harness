#!/usr/bin/env python3
"""Judge the workspace's track and write .harness/verdict.json (spec 1).

    python3 toolchain/verdict.py                 # track.strudel
    python3 toolchain/verdict.py b-side.strudel

Phases: Write (the file has a pattern in it), Check (it parses and the calls make sense), Play (the
pane plays it). Play is the one thing a headless check cannot do — no speakers here, and Strudel's
audio needs a browser and a click — so it is marked done when Check passes, and the pane is where a
human confirms it.

Check is static. Strudel's own transpiler parses a pattern as ECMAScript 2022 with top-level await
allowed (`parse(input, { ecmaVersion: 2022, allowAwaitOutsideFunction: true })` in
@strudel/transpiler), so `node --check --input-type=module` is exactly the parser the REPL will use
and is the real syntax gate here. Without node we fall back to a bracket/quote scanner. What is not
checked: whether a name exists in Strudel's eval scope, and whether it sounds good.
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
DEFAULT = "track.strudel"

# Sounds superdough registers itself, with no bank to download: registerSynthSounds() (the four
# oscillators plus user/one, sbd, supersaw, pulse, bytebeat, bus and the four noises) and
# registerZZFXSounds(). Everything else — bd, sd, hh, piano, gm_* — is a sample bank fetched from
# the network at REPL start, so a pattern that uses one needs the internet.
OFFLINE_SOUNDS = {
    "sine", "square", "sawtooth", "triangle", "user", "one",
    "sin", "sqr", "saw", "tri",  # the aliases superdough registers beside them
    "supersaw", "pulse", "bytebeat", "sbd", "bus",
    "white", "pink", "brown", "crackle",
    "zzfx", "z_sine", "z_sawtooth", "z_triangle", "z_square", "z_tan", "z_noise",
}
# The calls that turn text into a pattern. One of them has to be in the file for it to be a track.
PATTERN_CALLS = (
    "s", "sound", "note", "n", "freq", "stack", "seq", "sequence", "cat", "slowcat",
    "fastcat", "timeCat", "silence", "polymeter", "pure", "arrange", "run",
)
SOUND_LITERAL = re.compile(r'\b(?:s|sound)\s*\(\s*(["\'])(.*?)\1', re.DOTALL)
NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
PAIRS = {")": "(", "]": "[", "}": "{"}


def strip_code(text: str) -> tuple[str, list[dict]]:
    """Walk the source once: report unbalanced brackets and unterminated strings, and return the
    code with comments and string bodies blanked out so name scans do not trip over them."""
    findings: list[dict] = []
    out: list[str] = []
    stack: list[tuple[str, int]] = []
    i, line, n = 0, 1, len(text)
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            out.append(c)
            i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            end = text.find("*/", i + 2)
            if end == -1:
                findings.append({"severity": "error", "kind": "syntax", "message": f"line {line}: a /* comment is never closed"})
                i = n
            else:
                line += text.count("\n", i, end)
                i = end + 2
        elif c in "\"'`":
            quote, start_line, i = c, line, i + 1
            closed = False
            while i < n:
                ch = text[i]
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    i += 1
                    closed = True
                    break
                if ch == "\n":
                    if quote != "`":
                        break  # ' and " do not span lines; leave the newline to the outer loop
                    line += 1
                i += 1
            if not closed:
                findings.append({"severity": "error", "kind": "syntax", "message": f"line {start_line}: a {quote} string is never closed"})
            out.append(" ")
        elif c in "([{":
            stack.append((c, line))
            out.append(c)
            i += 1
        elif c in ")]}":
            if not stack or stack[-1][0] != PAIRS[c]:
                findings.append({"severity": "error", "kind": "syntax", "message": f"line {line}: a stray {c}"})
            else:
                stack.pop()
            out.append(c)
            i += 1
        else:
            out.append(c)
            i += 1
    for opener, at in stack:
        findings.append({"severity": "error", "kind": "syntax", "message": f"line {at}: {opener} is never closed"})
    return "".join(out), findings


def node_check(text: str) -> list[dict]:
    """The REPL's own parser, when node is on PATH. Silent when node is not."""
    try:
        done = subprocess.run(["node", "--check", "--input-type=module"], input=text, capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return []
    if done.returncode == 0:
        return []
    detail = ""
    for raw in (done.stderr or "").splitlines():
        stripped = raw.strip()
        if stripped.startswith("SyntaxError:"):
            detail = stripped[len("SyntaxError:"):].strip()
            break
    return [{"severity": "error", "kind": "syntax", "message": f"node could not parse the pattern: {detail or 'syntax error'}"}]


def judge(text: str, rel: str) -> dict:
    findings: list[dict] = []
    code, scan = strip_code(text)
    findings += scan
    bare = "".join(ch for ch in code if not ch.isspace())
    written = bool(bare)
    if not written:
        findings.append({"severity": "error", "kind": "empty", "message": f"{rel} has no pattern in it yet"})

    if written and not scan:
        findings += node_check(text)

    if re.search(r"^\s*import\s|\brequire\s*\(", code, re.MULTILINE):
        findings.append({"severity": "error", "kind": "scope", "message": "import/require: the REPL evaluates the file in its own scope, there is no module loader"})

    names = set(NAME.findall(code))
    calls = {m for m in names if re.search(r"\b" + re.escape(m) + r"\s*\(", code)}
    if written and not (calls & set(PATTERN_CALLS)):
        findings.append({"severity": "error", "kind": "pattern", "message": f"no pattern call — a track needs one of {', '.join(PATTERN_CALLS[:6])}(…)"})
    if written and not ({"setcps", "setcpm"} & calls):
        findings.append({"severity": "info", "kind": "tempo", "message": "no setcps/setcpm: Strudel runs at its default 0.5 cycles per second"})

    online: list[str] = []
    for _, literal in SOUND_LITERAL.findall(text):
        for token in NAME.findall(literal):
            if token not in OFFLINE_SOUNDS and token not in online:
                online.append(token)
    if online:
        findings.append({"severity": "warning", "kind": "network",
                         "message": f"{', '.join(online[:8])} {'is' if len(online) == 1 else 'are'} sample-bank sound(s): the pane downloads them at start, so this track needs the internet"})

    errors = [f for f in findings if f["severity"] == "error"]
    warnings = [f for f in findings if f["severity"] == "warning"]
    ok = written and not errors

    lines = len(text.splitlines())
    bits = [Path(rel).name]
    if written:
        bits.append(f"{lines} line{'s' if lines != 1 else ''}")
    if not written:
        bits.append("empty")
    elif errors:
        bits.append(f"{len(errors)} error{'s' if len(errors) != 1 else ''}")
    elif online:
        bits.append("plays — samples need the internet")
    elif warnings:
        bits.append(f"plays · {len(warnings)} warning{'s' if len(warnings) != 1 else ''}")
    else:
        bits.append("plays offline")

    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active"},
        {"id": "check", "name": "Check", "state": ("done" if ok else "failed") if written else "pending"},
        # No speakers here: the pane is the only place the track is actually heard.
        {"id": "play", "name": "Play", "state": "done" if ok else "pending"},
    ]
    return {"spec": 1, "ready": ok, "summary": " · ".join(bits), "findings": findings,
            "artifact": rel, "phases": phases,
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


def main(argv: list[str]) -> int:
    target = Path(argv[1]) if len(argv) > 1 else WS / DEFAULT
    target = target if target.is_absolute() else WS / target
    rel = os.path.relpath(target, WS)
    try:
        text = target.read_text()
    except OSError as error:
        verdict = {"spec": 1, "ready": False, "summary": f"{Path(rel).name} · unreadable",
                   "findings": [{"severity": "error", "kind": "file", "message": f"{rel}: {error}"}],
                   "artifact": rel,
                   "phases": [{"id": "write", "name": "Write", "state": "active"},
                              {"id": "check", "name": "Check", "state": "pending"},
                              {"id": "play", "name": "Play", "state": "pending"}],
                   "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    else:
        verdict = judge(text, rel)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
