#!/usr/bin/env python3
"""Turn Icarus Verilog's VCD dump into a small JSON of lanes.

    python3 toolchain/vcd2json.py out/sim.vcd out/waves.json

The verdict counts its signals and any script can read it without a VCD parser. The pane itself
reads out/sim.vcd whole (viewer/lib/vcd.mjs), since a capped summary would cut the clock short.
A VCD is a stream of value changes against a shared clock of integer ticks; this reads it once and
writes:

    { "timescale": "1ps", "tickFs": 1000, "end": 985000,
      "signals": [ { "name": "blink_tb.clk", "width": 1, "aliases": [...],
                     "changes": [[0, "0"], [5000, "1"], ...] } ] }

Values are strings: "0"/"1"/"x"/"z" for a wire, and a full-width binary string for a bus (the
viewer renders those as hex). VCD left-truncates bus values, so they are re-extended here by the
standard rule — pad with the leading character, except that a leading 1 pads with 0.

Three things are deliberately dropped, because they are noise in a waveform: `$var parameter`
(constants, dumped once), anything declared inside a `task` or `function` scope (Icarus dumps a
task's arguments, including 320-bit string literals), and signals wider than MAX_WIDTH.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

MAX_WIDTH = 64      # a bus wider than this is memory, not a waveform
MAX_SIGNALS = 64    # lanes the pane can usefully show
MAX_CHANGES = 20000 # per signal; a clock over a long run is the usual offender

# 1 tick of the timescale, in femtoseconds.
UNITS = {"s": 10**15, "ms": 10**12, "us": 10**9, "ns": 10**6, "ps": 10**3, "fs": 1}


def tick_fs(timescale: str) -> int:
    """'10 ns' -> 10_000_000 femtoseconds. Unknown text -> 1000 (1 ps), the Icarus default."""
    m = re.match(r"\s*(\d+)\s*([munpf]?s)\s*$", timescale)
    return int(m.group(1)) * UNITS[m.group(2)] if m and m.group(2) in UNITS else UNITS["ps"]


def extend(bits: str, width: int) -> str:
    """Undo the VCD's left truncation of a bus value."""
    if len(bits) >= width:
        return bits[-width:]
    pad = "0" if bits[:1] == "1" else (bits[:1] or "0")
    return pad * (width - len(bits)) + bits


def parse(text: str) -> dict:
    tokens = text.split()
    i, n = 0, len(tokens)
    timescale = "1ps"
    scopes: list[str] = []
    skipping = 0          # depth inside a non-module scope (task/function/fork/begin)
    order: list[str] = []  # ids, in declaration order
    sigs: dict[str, dict] = {}

    # --- header ---------------------------------------------------------------------------------
    while i < n:
        t = tokens[i]
        if t == "$enddefinitions":
            while i < n and tokens[i] != "$end":
                i += 1
            i += 1
            break
        if t == "$timescale":
            j = i + 1
            parts = []
            while j < n and tokens[j] != "$end":
                parts.append(tokens[j])
                j += 1
            timescale = " ".join(parts)
            i = j + 1
            continue
        if t == "$scope":
            kind = tokens[i + 1] if i + 1 < n else "module"
            name = tokens[i + 2] if i + 2 < n else "?"
            if skipping or kind != "module":
                skipping += 1
            else:
                scopes.append(name)
            while i < n and tokens[i] != "$end":
                i += 1
            i += 1
            continue
        if t == "$upscope":
            if skipping:
                skipping -= 1
            elif scopes:
                scopes.pop()
            i += 2
            continue
        if t == "$var":
            j = i + 1
            parts = []
            while j < n and tokens[j] != "$end":
                parts.append(tokens[j])
                j += 1
            i = j + 1
            if skipping or len(parts) < 4:
                continue
            kind, width_s, ident, name = parts[0], parts[1], parts[2], parts[3]
            # parts[4:] is the bit range, e.g. "[2:0]" — the width already says it.
            try:
                width = int(width_s)
            except ValueError:
                continue
            if kind == "parameter" or width < 1 or width > MAX_WIDTH:
                continue
            full = ".".join(scopes + [name])
            if ident in sigs:
                sigs[ident]["aliases"].append(full)
            elif len(order) < MAX_SIGNALS:
                order.append(ident)
                sigs[ident] = {"name": full, "width": width, "aliases": [], "changes": []}
            continue
        # $date, $version, $comment and anything else: skip to its $end
        if t.startswith("$"):
            while i < n and tokens[i] != "$end":
                i += 1
            i += 1
            continue
        i += 1

    # --- value changes --------------------------------------------------------------------------
    time = 0
    end = 0
    truncated = False
    while i < n:
        t = tokens[i]
        i += 1
        if not t:
            continue
        head = t[0]
        if head == "#":
            try:
                time = int(t[1:])
            except ValueError:
                continue
            end = max(end, time)
            continue
        if head == "$":
            continue  # $dumpvars / $dumpall / $end — the values inside them are ordinary changes
        if head in "bBrR":
            value, ident = t[1:], (tokens[i] if i < n else "")
            i += 1
        else:
            value, ident = head, t[1:]
        sig = sigs.get(ident)
        if sig is None:
            continue
        if len(sig["changes"]) >= MAX_CHANGES:
            truncated = True
            continue
        if head in "bB":
            value = extend(value.lower(), sig["width"])
        elif head in "rR":
            value = value  # a real; the pane prints it as it stands
        else:
            value = value.lower()
        if sig["changes"] and sig["changes"][-1][1] == value:
            continue  # a repeat of the same value carries no edge
        if sig["changes"] and sig["changes"][-1][0] == time:
            sig["changes"][-1][1] = value  # same tick: the last write wins
            continue
        sig["changes"].append([time, value])

    return {
        "timescale": timescale,
        "tickFs": tick_fs(timescale),
        "end": end,
        "truncated": truncated,
        "signals": [sigs[k] for k in order],
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: vcd2json.py <sim.vcd> [waves.json]", file=sys.stderr)
        return 2
    src = Path(argv[1])
    dst = Path(argv[2]) if len(argv) > 2 else src.with_suffix(".json")
    if not src.exists():
        print(f"no VCD at {src} — did the testbench call $dumpfile/$dumpvars?", file=sys.stderr)
        return 1
    waves = parse(src.read_text(errors="replace"))
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(waves) + "\n")
    print(f"{len(waves['signals'])} signal(s), {sum(len(s['changes']) for s in waves['signals'])} "
          f"change(s), 0..{waves['end']} {waves['timescale']} -> {dst}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
