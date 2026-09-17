#!/usr/bin/env python3
"""Judge the workspace's circuit and write .harness/verdict.json (spec 1).

    python3 toolchain/verdict.py                      # circuit.txt
    python3 toolchain/verdict.py filters/lowpass.txt

Three phases:

  Write   circuit.txt is there, it has a `$` options header, and it has at least two elements.
  Parse   every line is one CircuitJS1 understands: a known element code, integer coordinates on
          the grid, scope and slider lines pointing at elements that exist, ends that meet.
  Run     the simulation itself. CircuitJS1 is a compiled GWT browser app; there is no headless
          way to step it from here, so this phase is not a check — it is the pane. It follows
          Parse, and what it is really saying is "the file loads; watch it".

ready = the file is written and parses with no errors. Warnings (an end nothing else touches, a
coordinate off the grid, no ground) are worth fixing but do not stop the circuit from running.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()

# Line types the loader handles itself; they are not elements and carry no coordinates.
# (`$` options, `o` scope, `h` hint, `!` custom-logic model, `.` composite model, `32`/`34`
# transistor and diode models, `38` slider, and the afilter-only `%`, `?`, `B`.)
NON_ELEMENT = {"$", "o", "h", "!", ".", "%", "?", "B", "32", "34", "38"}

# Elements whose two posts are exactly the two endpoints on the line.
TWO_POST = {
    "r", "c", "l", "d", "z", "v", "i", "w", "s", "m", "p", "I",
    "162", "175", "176", "181", "182", "183", "187", "203", "209", "216",
    "350", "370", "374", "404", "415", "422", "425", "426",
}
# Elements whose single post is the first endpoint; the second is only which way it is drawn.
ONE_POST = {
    "g", "R", "O", "L", "M", "A", "n",
    "170", "172", "200", "201", "207", "210", "211", "368", "408", "411", "418", "424",
}
# Elements that draw but do not connect.
NO_POST = {"x", "b", "403", "423"}
# Everything else CircuitJS1 knows. Their pins sit at offsets the app computes from the body size
# (chips, transistors, op-amps, pots, transformers), so a text file cannot say where they are and
# this checker does not guess.
COMPUTED_PINS = {
    "S", "T", "a", "f", "j", "t",
    "150", "151", "152", "153", "154", "155", "156", "157", "158", "159", "160", "161", "163",
    "164", "165", "166", "167", "168", "169", "171", "173", "174", "177", "178", "179", "180",
    "184", "185", "186", "188", "189", "193", "194", "195", "196", "197", "206", "208", "212",
    "213", "214", "215", "400", "401", "402", "405", "406", "407", "409", "410", "412", "413",
    "414", "416", "417", "419", "420", "421", "427", "428", "429", "430", "431", "432", "433",
    "436",
}
KNOWN = TWO_POST | ONE_POST | NO_POST | COMPUTED_PINS

SINGLE_ENDED_SOURCES = {"R", "170", "172", "200", "201", "418"}

NAMES = {
    "r": "resistor", "c": "capacitor", "l": "inductor", "d": "diode", "z": "zener",
    "v": "voltage source", "i": "current source", "w": "wire", "s": "switch", "g": "ground",
    "R": "rail", "O": "output", "a": "op-amp", "t": "transistor", "f": "MOSFET", "x": "text",
    "p": "probe", "162": "LED", "165": "555 timer", "174": "potentiometer", "170": "sweep",
    "207": "labeled node", "L": "logic input", "M": "logic output", "S": "SPDT switch",
    "T": "transformer", "n": "noise source", "b": "box", "j": "JFET", "i": "current source",
    "m": "memristor", "163": "ring counter", "172": "variable rail", "38": "slider",
}


def name_of(code: str) -> str:
    return NAMES.get(code, f"element {code}")


class Line:
    __slots__ = ("no", "code", "x1", "y1", "x2", "y2", "flags", "rest")

    def __init__(self, no: int, code: str, coords: list[int], rest: list[str]):
        self.no = no
        self.code = code
        self.x1, self.y1, self.x2, self.y2, self.flags = coords
        self.rest = rest


def judge(text: str | None, rel: str) -> dict:
    findings: list[dict] = []
    err = lambda kind, msg, ref=None: findings.append(  # noqa: E731
        {"severity": "error", "kind": kind, "message": msg, **({"ref": ref} if ref else {})})
    warn = lambda kind, msg, ref=None: findings.append(  # noqa: E731
        {"severity": "warning", "kind": kind, "message": msg, **({"ref": ref} if ref else {})})
    info = lambda kind, msg, ref=None: findings.append(  # noqa: E731
        {"severity": "info", "kind": kind, "message": msg, **({"ref": ref} if ref else {})})

    if text is None:
        err("file", f"{rel} is not there yet")
        return assemble(rel, findings, 0, 0, False, False)

    if text.lstrip().startswith("<"):
        err("format", f"{rel} is CircuitJS1's XML dump; this harness writes the text format "
                      f"(a `$` header line, then one element per line)")
        return assemble(rel, findings, 0, 0, False, False)

    header: list[str] | None = None
    elements: list[Line] = []
    scopes = 0
    sliders: list[tuple[int, int]] = []       # (line number, element index)
    scope_refs: list[tuple[int, int]] = []

    for no, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        tokens = line.replace("\t", " ").split()
        code = tokens[0]

        if code == "$":
            if header is None:
                header = tokens[1:]
                if len(header) < 5:
                    err("header", f"line {no}: the `$` options line needs at least "
                                  f"flags, timestep, iterations, current, voltage range", f"line {no}")
            continue
        if code == "o":
            scopes += 1
            if len(tokens) < 5:
                err("scope", f"line {no}: a scope line is `o <element> <speed> <value> <flags> "
                             f"<scaleV> <scaleA>`", f"line {no}")
            else:
                try:
                    scope_refs.append((no, int(tokens[1])))
                except ValueError:
                    err("scope", f"line {no}: the first field of a scope line is an element "
                                 f"index, not {tokens[1]!r}", f"line {no}")
            continue
        if code == "38":
            if len(tokens) < 2:
                err("slider", f"line {no}: a slider line is `38 <element> F<flags> <item> "
                              f"<min> <max> <shared> <label> <step>`", f"line {no}")
            else:
                try:
                    sliders.append((no, int(tokens[1])))
                except ValueError:
                    err("slider", f"line {no}: the first field of a slider line is an element "
                                  f"index, not {tokens[1]!r}", f"line {no}")
            continue
        if code in NON_ELEMENT:
            continue

        if code not in KNOWN:
            err("unknown_element", f"line {no}: {code!r} is not a CircuitJS1 element code", f"line {no}")
            continue
        if len(tokens) < 6:
            err("truncated", f"line {no}: {name_of(code)} needs `{code} x1 y1 x2 y2 flags` before "
                             f"its values; got {len(tokens) - 1} field(s)", f"line {no}")
            continue
        try:
            coords = [int(t) for t in tokens[1:6]]
        except ValueError:
            err("coordinates", f"line {no}: {name_of(code)} has non-integer coordinates or flags "
                               f"({' '.join(tokens[1:6])})", f"line {no}")
            continue
        elements.append(Line(no, code, coords, tokens[6:]))

    # Scope and slider lines address elements by their position in the file, counting only the
    # element lines. Off-by-one here is the single easiest thing to get wrong by hand.
    for no, idx in scope_refs:
        if idx < -1 or idx >= len(elements):
            err("scope_ref", f"line {no}: the scope watches element {idx}, but the file has "
                             f"{len(elements)} element(s) (they are numbered from 0, counting only "
                             f"element lines)", f"line {no}")
    for no, idx in sliders:
        if idx < 0 or idx >= len(elements):
            err("slider_ref", f"line {no}: the slider adjusts element {idx}, but the file has "
                              f"{len(elements)} element(s)", f"line {no}")

    grid = 8 if (header and _int(header[0]) & 2) else 16
    computed = [e for e in elements if e.code in COMPUTED_PINS]

    # Posts: where an element actually joins the circuit.
    posts: dict[tuple[int, int], list[Line]] = {}
    for e in elements:
        for pt in element_posts(e):
            posts.setdefault(pt, []).append(e)

    off_grid = 0
    for e in elements:
        if e.code in NO_POST:                   # text and boxes are placed freely, not snapped
            continue
        for x, y in ((e.x1, e.y1), (e.x2, e.y2)):
            if x % grid or y % grid:
                off_grid += 1
        if e.code in TWO_POST and (e.x1, e.y1) == (e.x2, e.y2):
            warn("zero_length", f"line {e.no}: the {name_of(e.code)} starts and ends at "
                                f"({e.x1}, {e.y1}); it has no length", f"line {e.no}")
    if off_grid:
        warn("grid", f"{off_grid} coordinate(s) are not multiples of {grid}; CircuitJS1 snaps to a "
                     f"{grid}-px grid and off-grid ends do not meet")

    floating = 0
    for e in elements:
        for pt in element_posts(e):
            if len(posts.get(pt, ())) > 1:
                continue
            floating += 1
            where = f"({pt[0]}, {pt[1]})"
            if computed:
                info("open_end", f"line {e.no}: nothing else ends at {where}, where the "
                                 f"{name_of(e.code)} does — either an open end, or a pin of a chip "
                                 f"or transistor, whose pins this check cannot see", f"line {e.no}")
            else:
                warn("floating", f"line {e.no}: the {name_of(e.code)} end at {where} is floating — "
                                 f"no other element reaches it", f"line {e.no}")

    codes = {e.code for e in elements}
    if elements and "g" not in codes and "207" not in codes:
        # A two-terminal source floats and is its own reference; a rail is single-ended and is not.
        if codes & SINGLE_ENDED_SOURCES:
            warn("no_ground", "no ground (`g`), but there is a rail or a sweep, which measures "
                              "against one: the solver has no reference node")
        else:
            info("no_ground", "no ground (`g`). Fine while every source is a two-terminal `v` or "
                              "`i`, which is its own reference; add one the moment a rail appears")
    if elements and not scopes:
        info("no_scope", "no scope (`o`) line: the circuit runs, but nothing is plotted. Add "
                         "`o <element> 64 0 2 5 0.0125` to watch a node")

    written = header is not None and len(elements) >= 2
    if header is None and text.strip():
        err("header", f"{rel} has no `$` options line; CircuitJS1 wants one first, e.g. "
                      f"`$ 1 0.000005 10.20027730826997 50 5 43 5e-11`")
    if header is not None and 0 < len(elements) < 2:
        warn("sparse", f"{len(elements)} element so far; a circuit needs at least two")

    return assemble(rel, findings, len(elements), scopes, written, True)


def _int(tok: str) -> int:
    try:
        return int(tok)
    except ValueError:
        return 0


def element_posts(e: Line) -> list[tuple[int, int]]:
    if e.code in TWO_POST:
        return [(e.x1, e.y1), (e.x2, e.y2)]
    if e.code in ONE_POST:
        return [(e.x1, e.y1)]
    return []                                   # decoration, or pins we cannot place


def assemble(rel: str, findings: list[dict], count: int, scopes: int, written: bool,
             parsed: bool) -> dict:
    errors = [f for f in findings if f["severity"] == "error"]
    warnings = [f for f in findings if f["severity"] == "warning"]
    ok = written and parsed and not errors

    bits = [Path(rel).name]
    if count:
        bits.append(f"{count} element{'s' if count != 1 else ''}"
                    + (f" · {scopes} scope{'s' if scopes != 1 else ''}" if scopes else ""))
    if errors:
        bits.append(f"{len(errors)} error{'s' if len(errors) != 1 else ''}")
    elif ok:
        bits.append(f"running{f' · {len(warnings)} warning' + ('s' if len(warnings) != 1 else '') if warnings else ''}")
    else:
        bits.append("empty")

    phases = [
        {"id": "write", "name": "Write", "state": "done" if written else "active", "artifact": rel},
        {"id": "parse", "name": "Parse",
         "state": ("failed" if errors else "done") if written else "pending"},
        {"id": "run", "name": "Run", "state": "done" if ok else "pending"},
    ]
    if ok:
        findings.append({"severity": "info", "kind": "run",
                         "message": "the simulation runs in the pane, not here — CircuitJS1 is a "
                                    "browser app, so Run is the pane's word, not a headless check"})
    return {
        "spec": 1,
        "ready": ok,
        "summary": " · ".join(bits)[:200],
        "findings": findings,
        "artifact": rel,
        "phases": phases,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def main(argv: list[str]) -> int:
    target = Path(argv[1]) if len(argv) > 1 else WS / "circuit.txt"
    target = target if target.is_absolute() else WS / target
    rel = os.path.relpath(target, WS)
    try:
        text = target.read_text()
    except OSError:
        text = None
    verdict = judge(text, rel)
    (WS / ".harness").mkdir(exist_ok=True)
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")
    print(f"{'ready' if verdict['ready'] else 'not ready'} · {verdict['summary']}")
    for f in verdict["findings"]:
        print(f"  {f['severity']:<7} {f['message']}")
    return 0 if verdict["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
