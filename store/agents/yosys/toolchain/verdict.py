#!/usr/bin/env python3
"""Read what the flow left in out/, then write the two files that are the product of this harness:

    out/<top>.report.json    everything the pane draws: steps, sim result, cells, utilisation,
                             Fmax, where the schematic and the waves and the bitstream are
    .harness/verdict.json    spec 1: ready, one summary line, findings, phases

    python3 toolchain/verdict.py [top]

`flow.sh` calls this after every step, so both files exist — with the later steps still pending —
from the first second. Nothing here runs a tool; it only reads out/logs/*.log, out/logs/*.exit and
the JSON that nextpnr wrote. That is what makes it cheap enough to run seven times a flow.

Phases: Write (there is RTL), Simulate (vvp ran and the testbench did not print FAIL), Synthesize
(yosys mapped it), Place & route (nextpnr fitted it and met the clock), Bitstream (icepack packed
it). Ready = all five.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()

STEPS = [
    ("sim", "Simulate"),
    ("waves", "Waveforms"),
    ("synth", "Synthesize"),
    ("schematic", "Schematic netlist"),
    ("svg", "Schematic drawing"),
    ("pnr", "Place & route"),
    ("pack", "Bitstream"),
]

# The phase strip in the pane header, and which steps have to be done for each one.
PHASES = [
    ("write", "Write", []),
    ("simulate", "Simulate", ["sim"]),
    ("synthesize", "Synthesize", ["synth"]),
    ("pnr", "Place & route", ["pnr"]),
    ("bitstream", "Bitstream", ["pack"]),
]

RESOURCES = {
    "ICESTORM_LC": "Logic cells",
    "SB_IO": "I/O pins",
    "ICESTORM_RAM": "Block RAM",
    "ICESTORM_SPRAM": "SPRAM",
    "SB_GB": "Global buffers",
    "ICESTORM_PLL": "PLL",
    "ICESTORM_DSP": "DSP (MAC16)",
    "ICESTORM_HFOSC": "HF oscillator",
    "ICESTORM_LFOSC": "LF oscillator",
    "SB_RGBA_DRV": "RGB LED driver",
    "SB_LEDDA_IP": "LED driver IP",
    "SB_SPI": "SPI",
    "SB_I2C": "I2C",
    "SB_WARMBOOT": "Warm boot",
    "IO_I3C": "I3C pins",
}

DEVICES = {
    "--up5k": "iCE40 UP5K", "--lp8k": "iCE40 LP8K", "--hx8k": "iCE40 HX8K",
    "--lp1k": "iCE40 LP1K", "--hx1k": "iCE40 HX1K", "--lp4k": "iCE40 LP4K",
    "--hx4k": "iCE40 HX4K", "--u4k": "iCE40 U4K",
}


# --------------------------------------------------------------------------------------- parsing

def parse_sim_log(text: str) -> dict:
    """iverilog's diagnostics and what the testbench printed."""
    diagnostics = []
    for m in re.finditer(r"^(\S+?):(\d+):\s*(error|warning|sorry):\s*(.+)$", text, re.M | re.I):
        file, line, kind, message = m.groups()
        diagnostics.append({"severity": "warning" if kind.lower() == "warning" else "error",
                            "message": message.strip(), "ref": f"{file}:{line}"})
    checks = [l.strip() for l in text.splitlines() if re.match(r"\s*(ok|PASS|FAIL)\b", l.strip())]
    failures = [l for l in checks if l.upper().startswith("FAIL") or " FAIL" in l.upper()]
    # "FAIL  blink: 2 checks failed" is the testbench's own tally, not a third failing check.
    tallies = [l for l in failures if re.search(r"\bchecks?\s+failed", l, re.I)]
    # A testbench that never says PASS or FAIL has not been asked a question.
    asserted = any(l.upper().startswith(("PASS", "FAIL")) for l in checks)
    return {"diagnostics": diagnostics, "checks": checks, "failures": failures,
            "failedChecks": [l for l in failures if l not in tallies] or failures, "asserted": asserted}


def parse_yosys_log(text: str) -> dict:
    """Cell counts from `stat`, plus yosys's own errors and warnings."""
    diagnostics = []
    for m in re.finditer(r"^(ERROR|Warning):\s*(.+)$", text, re.M):
        kind, message = m.groups()
        message = message.strip()
        latch = "latch" in message.lower()
        diagnostics.append({
            "severity": "error" if kind == "ERROR" else "warning",
            "kind": "latch" if latch else ("driver" if "driver" in message.lower() else "yosys"),
            "message": message,
        })
    # The last `=== <module> ===` block is our explicit `stat`; take its local cell counts.
    blocks = re.split(r"^={3,}\s*(\S+)\s*={3,}\s*$", text, flags=re.M)
    cells, by_type, wires = 0, {}, 0
    if len(blocks) > 1:
        body = blocks[-1]
        m = re.search(r"^\s*(\d+)\s+cells\s*$", body, re.M)
        if m:
            cells = int(m.group(1))
        m = re.search(r"^\s*(\d+)\s+wires\s*$", body, re.M)
        if m:
            wires = int(m.group(1))
        for cm in re.finditer(r"^\s+(\d+)\s{2,}(\$?\w+)\s*$", body, re.M):
            by_type[cm.group(2)] = int(cm.group(1))
    return {"cells": cells, "wires": wires, "byType": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
            "diagnostics": diagnostics}


def parse_pnr_report(report: dict) -> dict:
    """nextpnr's --report JSON: what of the chip is used, and how fast it came out."""
    util = []
    for name, row in sorted((report.get("utilization") or {}).items()):
        used, avail = int(row.get("used", 0)), int(row.get("available", 0) or 0)
        if used == 0 and name not in ("ICESTORM_LC", "SB_IO"):
            continue  # a resource nobody touched is not news
        util.append({"id": name, "name": RESOURCES.get(name, name), "used": used, "available": avail,
                     "percent": round(100.0 * used / avail, 2) if avail else 0.0})
    # Logic cells first, then pins, then whatever else the design actually used.
    rank = {"ICESTORM_LC": 0, "SB_IO": 1}
    util.sort(key=lambda r: (rank.get(r["id"], 2), -r["percent"], r["id"]))
    clocks = []
    for name, row in sorted((report.get("fmax") or {}).items()):
        achieved = float(row.get("achieved", 0.0))
        constraint = float(row.get("constraint", 0.0) or 0.0)
        # nextpnr decorates the net name; 'clk$SB_IO_IN_$glb_clk' is the port 'clk'.
        clocks.append({"clock": name.split("$")[0], "net": name,
                       "achievedMHz": round(achieved, 2), "constraintMHz": round(constraint, 2),
                       "pass": (achieved >= constraint) if constraint else True})
    return {"utilization": util, "clocks": clocks}


def parse_pnr_log(text: str) -> list[dict]:
    diagnostics = []
    for m in re.finditer(r"^(?:Info:\s*)?(ERROR|Warning):\s*(.+)$", text, re.M):
        kind, message = m.groups()
        diagnostics.append({"severity": "error" if kind == "ERROR" else "warning",
                            "kind": "nextpnr", "message": message.strip()})
    return diagnostics


# ------------------------------------------------------------------------------------- assembling

def assemble(top: str, steps: dict, rtl: list[str], sim: dict, synth: dict, pnr: dict,
             bitstream: dict | None, waves: dict | None, device: str, package: str,
             schematic: str | None, run: dict | None = None) -> dict:
    """Everything parsed, into the one report the pane reads. Pure — the tests drive it directly."""
    findings: list[dict] = []
    ok = lambda name: steps.get(name, {}).get("state") == "done"
    failed = lambda name: steps.get(name, {}).get("state") == "failed"

    if not rtl:
        findings.append({"severity": "error", "kind": "rtl", "message": "no rtl/*.v — nothing to build"})

    # --- simulate
    for d in sim.get("diagnostics", []):
        findings.append({"severity": d["severity"], "kind": "verilog", "message": d["message"], "ref": d.get("ref", "")})
    for line in sim.get("failures", []):
        findings.append({"severity": "error", "kind": "testbench", "message": line, "ref": f"tb/{top}_tb.v"})
    if failed("sim") and not sim.get("diagnostics") and not sim.get("failures"):
        findings.append({"severity": "error", "kind": "simulation",
                         "message": f"simulation did not finish — see out/logs/sim.log", "ref": f"tb/{top}_tb.v"})
    if ok("sim") and not sim.get("asserted"):
        findings.append({"severity": "warning", "kind": "testbench",
                         "message": f"tb/{top}_tb.v ran but never printed PASS or FAIL — it is a dump, not a test",
                         "ref": f"tb/{top}_tb.v"})

    # --- synthesize
    for d in synth.get("diagnostics", []):
        if d["kind"] == "latch":
            d = {**d, "message": d["message"] + " — an incomplete if/case in a combinational always block infers a latch"}
        findings.append({"severity": d["severity"], "kind": d["kind"], "message": d["message"], "ref": f"rtl/{top}.v"})

    # --- place & route
    for d in pnr.get("diagnostics", []):
        findings.append({**d, "ref": f"constraints/{top}.pcf"})
    for c in pnr.get("clocks", []):
        if not c["pass"]:
            findings.append({"severity": "error", "kind": "timing",
                             "message": f"{c['clock']} closes at {c['achievedMHz']} MHz but the design asks for "
                                        f"{c['constraintMHz']} MHz — shorten the critical path",
                             "ref": f"constraints/{top}.pcf"})
    for r in pnr.get("utilization", []):
        if r["percent"] >= 90:
            findings.append({"severity": "warning", "kind": "utilization",
                             "message": f"{r['name']} {r['used']}/{r['available']} ({r['percent']:.0f}%) — nearly full"})

    # A step can fail without saying anything a parser recognises — nextpnr missing from PATH, a
    # tool killed, a full disk. Never leave a red phase with no explanation: fall back to the last
    # line the step printed.
    kind_of_step = {"verilog": "sim", "testbench": "sim", "simulation": "sim",
                    "yosys": "synth", "latch": "synth", "driver": "synth",
                    "nextpnr": "pnr", "timing": "pnr"}
    covered = {kind_of_step[f["kind"]] for f in findings if f.get("kind") in kind_of_step}
    for sid, sname in STEPS:
        if failed(sid) and sid not in covered:
            tail = (steps.get(sid) or {}).get("tail") or f"{sname.lower()} failed — see out/logs/{sid}.log"
            findings.append({"severity": "error", "kind": sid, "message": tail,
                             "ref": (steps.get(sid) or {}).get("log", "")})

    ready = all(ok(s) for s in ("sim", "synth", "pnr", "pack")) and not any(f["severity"] == "error" for f in findings)

    phases = []
    for pid, pname, needed in PHASES:
        if pid == "write":
            state = "done" if rtl else "active"
        elif pid == "simulate" and ok("sim") and sim.get("failures"):
            state = "failed"  # vvp returned 0, but the testbench said no
        elif any(failed(s) for s in needed):
            state = "failed"
        elif all(ok(s) for s in needed):
            state = "done"
        elif any(steps.get(s, {}).get("state") == "running" for s in needed):
            state = "active"
        else:
            state = "pending"
        phase = {"id": pid, "name": pname, "state": state}
        if pid == "synthesize" and schematic:
            phase["artifact"] = schematic
        if pid == "bitstream" and bitstream:
            phase["artifact"] = bitstream["path"]
        phases.append(phase)

    lc = next((r for r in pnr.get("utilization", []) if r["id"] == "ICESTORM_LC"), None)
    clock = next(iter(pnr.get("clocks", [])), None)
    bits = [top]
    if sim.get("failures"):
        n = len(sim.get("failedChecks") or sim["failures"])
        bits.append(f"{n} failing check{'s' if n != 1 else ''}")
    elif ok("sim"):
        bits.append("sim passes")
    if synth.get("cells"):
        bits.append(f"{synth['cells']} cells")
    if lc:
        bits.append(f"{lc['used']}/{lc['available']} LCs ({lc['percent']:.0f}%)")
    if clock:
        bits.append(f"{clock['achievedMHz']:.1f} MHz")
    if bitstream:
        bits.append("bitstream ready")
    elif not ready and any(f["severity"] == "error" for f in findings):
        n = sum(1 for f in findings if f["severity"] == "error")
        bits.append(f"{n} error{'s' if n != 1 else ''}")

    return {
        "top": top,
        "ready": ready,
        "summary": " · ".join(bits)[:200],
        "board": {"name": "iCEBreaker", "device": DEVICES.get(device, device.lstrip("-").upper()),
                  "package": package, "flash": f"iceprog out/{top}.bin"},
        "rtl": rtl,
        "steps": [{"id": sid, "name": sname, **steps.get(sid, {"state": "pending"})}
                  for sid, sname in STEPS],
        "simulation": {
            "state": steps.get("sim", {}).get("state", "pending"),
            "passed": ok("sim") and not sim.get("failures") and sim.get("asserted", False),
            "checks": sim.get("checks", []),
            "vcd": f"out/sim.vcd" if ok("sim") else None,
            "waves": "out/waves.json" if ok("waves") else None,
            "signals": len(waves.get("signals", [])) if waves else 0,
        },
        "synthesis": {
            "state": steps.get("synth", {}).get("state", "pending"),
            "cells": synth.get("cells", 0),
            "byType": synth.get("byType", {}),
            "netlist": f"out/{top}.json" if ok("synth") else None,
            "schematic": schematic,
        },
        "pnr": {
            "state": steps.get("pnr", {}).get("state", "pending"),
            "utilization": pnr.get("utilization", []),
            "clocks": pnr.get("clocks", []),
            "report": pnr.get("report"),
            "routed": pnr.get("routed"),
        },
        "run": run,
        "bitstream": bitstream,
        "findings": findings,
        "phases": phases,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def to_verdict(report: dict, artifact: str) -> dict:
    return {
        "spec": 1,
        "ready": report["ready"],
        "summary": report["summary"],
        "findings": report["findings"],
        "artifact": artifact,
        "phases": report["phases"],
        "updatedAt": report["updatedAt"],
    }


# ------------------------------------------------------------------------------------------- main

def read(path: Path) -> str:
    try:
        return path.read_text(errors="replace")
    except OSError:
        return ""


def load_json(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def read_step(logs: Path, sid: str, finished: bool) -> dict:
    """One step's state from the files flow.sh leaves beside its log: <sid>.exit when it is over,
    <sid>.start while it runs, <sid>.time (start and end, epoch ms) for how long it took. A step
    with none of them in a run that has finished was skipped — an earlier step failed."""
    exit_file, log_file = logs / f"{sid}.exit", logs / f"{sid}.log"
    rel = os.path.relpath(log_file, WS)
    times = read(logs / f"{sid}.time").split()
    started = read(logs / f"{sid}.start").strip() or (times[0] if times else "")
    if exit_file.exists():
        code = read(exit_file).strip()
        step = {"state": "done" if code == "0" else "failed", "exit": int(code or 1), "log": rel}
        if step["state"] == "failed":
            lines = [l.strip() for l in read(log_file).splitlines() if l.strip()]
            step["tail"] = lines[-1][:300] if lines else ""
    elif log_file.exists() or started:
        step = {"state": "running", "log": rel}
    else:
        return {"state": "skipped" if finished else "pending"}
    if started.isdigit():
        step["startedAt"] = int(started)
    if len(times) == 2 and all(t.isdigit() for t in times):
        step["seconds"] = round((int(times[1]) - int(times[0])) / 1000.0, 3)
    return step


def main(argv: list[str]) -> int:
    top = argv[1] if len(argv) > 1 else None
    if not top:
        top = read(WS / "out" / ".top").strip() or None
    if not top:
        tbs = sorted((WS / "tb").glob("*_tb.v")) if (WS / "tb").is_dir() else []
        top = tbs[0].name[: -len("_tb.v")] if tbs else "top"

    logs = WS / "out" / "logs"
    run = load_json(logs / "run.json")
    finished = bool(run and run.get("finishedAt"))
    steps: dict[str, dict] = {}
    for sid, _ in STEPS:
        steps[sid] = read_step(logs, sid, finished)

    rtl = sorted(os.path.relpath(p, WS) for p in (WS / "rtl").glob("*.v")) if (WS / "rtl").is_dir() else []
    sim = parse_sim_log(read(logs / "sim.log"))
    synth = parse_yosys_log(read(logs / "synth.log"))

    pnr_report = load_json(WS / "out" / f"{top}_pnr.json") or {}
    pnr = parse_pnr_report(pnr_report)
    pnr["diagnostics"] = parse_pnr_log(read(logs / "pnr.log")) if steps.get("pnr", {}).get("state") == "failed" else []
    for key, name in (("report", f"{top}_pnr.json"), ("routed", f"{top}_routed.json")):
        if (WS / "out" / name).exists():
            pnr[key] = f"out/{name}"

    svg = WS / "out" / f"{top}.svg"
    schematic = os.path.relpath(svg, WS) if svg.exists() else None

    binary = WS / "out" / f"{top}.bin"
    bitstream = None
    if steps.get("pack", {}).get("state") == "done" and binary.exists():
        bitstream = {"path": os.path.relpath(binary, WS), "bytes": binary.stat().st_size,
                     "flash": f"iceprog out/{top}.bin"}

    waves = load_json(WS / "out" / "waves.json")
    device = os.environ.get("YOSYS_DEVICE", "--up5k")
    package = os.environ.get("YOSYS_PACKAGE", "sg48")

    report = assemble(top, steps, rtl, sim, synth, pnr, bitstream, waves, device, package, schematic, run)
    out = WS / "out"
    out.mkdir(exist_ok=True)
    (out / f"{top}.report.json").write_text(json.dumps(report, indent=2) + "\n")
    (WS / ".harness").mkdir(exist_ok=True)
    verdict = to_verdict(report, f"out/{top}.report.json")
    (WS / ".harness" / "verdict.json").write_text(json.dumps(verdict, indent=2) + "\n")

    print(f"{'ready' if report['ready'] else 'not ready'} · {report['summary']}")
    for f in report["findings"][:20]:
        print(f"  {f['severity']:<7} {f['message']}" + (f"  ({f['ref']})" if f.get("ref") else ""))
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
