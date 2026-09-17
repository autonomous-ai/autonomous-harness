"""The judge, without a toolchain: every fixture below is real output from iverilog, yosys or
nextpnr, trimmed. `python3 -m unittest discover -s toolchain`."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from verdict import assemble, parse_pnr_report, parse_sim_log, parse_yosys_log, read_step, to_verdict  # noqa: E402

DONE = {"state": "done", "exit": 0}
FAILED = {"state": "failed", "exit": 1}
ALL_DONE = {k: dict(DONE) for k in ("sim", "waves", "synth", "schematic", "svg", "pnr", "pack")}

PNR = {
    "fmax": {"clk$SB_IO_IN_$glb_clk": {"achieved": 64.80461883544922, "constraint": 12.00004768371582}},
    "utilization": {
        "ICESTORM_LC": {"available": 5280, "used": 36},
        "SB_IO": {"available": 39, "used": 4},
        "SB_GB": {"available": 8, "used": 1},
        "ICESTORM_RAM": {"available": 30, "used": 0},
        "ICESTORM_DSP": {"available": 8, "used": 0},
    },
}

STAT = """
2.51. Executing CHECK pass (checking for obvious problems).

3. Printing statistics.

=== blink ===

        +----------Local Count, excluding submodules.
        |
       54 wires
       83 wire bits
        4 ports
       77 cells
       21   SB_CARRY
        1   SB_DFFE
       23   SB_DFFSR
       32   SB_LUT4

End of script.
"""


def build(steps=None, sim=None, synth=None, pnr=None, bitstream=None, rtl=("rtl/blink.v",)):
    return assemble(
        "blink", steps if steps is not None else dict(ALL_DONE), list(rtl),
        sim if sim is not None else {"checks": ["PASS blink"], "failures": [], "asserted": True, "diagnostics": []},
        synth if synth is not None else {"cells": 77, "byType": {"SB_LUT4": 32}, "diagnostics": []},
        pnr if pnr is not None else {**parse_pnr_report(PNR), "diagnostics": []},
        bitstream if bitstream is not None else {"path": "out/blink.bin", "bytes": 104090, "flash": "iceprog out/blink.bin"},
        {"signals": [{"name": "clk"}], "end": 985000}, "--up5k", "sg48", "out/blink.svg",
    )


class SimLog(unittest.TestCase):
    def test_pass_and_checks(self):
        s = parse_sim_log("  ok   red LED dark\n  ok   green LED toggled\nPASS  blink: 12 toggles\n")
        self.assertTrue(s["asserted"])
        self.assertEqual(s["failures"], [])
        self.assertEqual(len(s["checks"]), 3)

    def test_fail_is_seen(self):
        s = parse_sim_log("  FAIL green LED toggled once per half period (at 480000)\nFAIL  blink: 1 check failed\n")
        self.assertEqual(len(s["failures"]), 2)

    def test_iverilog_error_carries_its_place(self):
        s = parse_sim_log("tb/blink_tb.v:47: syntax error\nrtl/blink.v:19: error: Unknown module type: countr\n")
        self.assertEqual(s["diagnostics"], [
            {"severity": "error", "message": "Unknown module type: countr", "ref": "rtl/blink.v:19"}])

    def test_a_dump_with_no_assertion_is_not_a_test(self):
        self.assertFalse(parse_sim_log("VCD info: dumpfile out/sim.vcd opened\n")["asserted"])


class YosysLog(unittest.TestCase):
    def test_stat_gives_cells_and_types(self):
        y = parse_yosys_log(STAT)
        self.assertEqual(y["cells"], 77)
        self.assertEqual(y["byType"], {"SB_LUT4": 32, "SB_DFFSR": 23, "SB_CARRY": 21, "SB_DFFE": 1})

    def test_byType_is_ordered_by_count(self):
        self.assertEqual(list(parse_yosys_log(STAT)["byType"])[0], "SB_LUT4")

    def test_latch_warning_is_its_own_kind(self):
        y = parse_yosys_log(r"Warning: Latch inferred for signal `\bad.\y' from process")
        self.assertEqual(y["diagnostics"][0]["kind"], "latch")
        self.assertEqual(y["diagnostics"][0]["severity"], "warning")

    def test_error_is_an_error(self):
        y = parse_yosys_log("ERROR: Multiple conflicting drivers for bad.\\y")
        self.assertEqual(y["diagnostics"][0]["severity"], "error")
        self.assertEqual(y["diagnostics"][0]["kind"], "driver")


class PnrReport(unittest.TestCase):
    def test_fmax_against_the_constraint(self):
        c = parse_pnr_report(PNR)["clocks"][0]
        self.assertEqual((c["clock"], c["achievedMHz"], c["constraintMHz"], c["pass"]), ("clk", 64.8, 12.0, True))

    def test_a_missed_clock_does_not_pass(self):
        slow = {"fmax": {"clk$x": {"achieved": 9.5, "constraint": 12.0}}, "utilization": {}}
        self.assertFalse(parse_pnr_report(slow)["clocks"][0]["pass"])

    def test_logic_cells_come_first_and_unused_resources_are_dropped(self):
        util = parse_pnr_report(PNR)["utilization"]
        self.assertEqual([u["id"] for u in util], ["ICESTORM_LC", "SB_IO", "SB_GB"])
        self.assertEqual(util[0]["percent"], round(3600 / 5280, 2))
        self.assertEqual(util[0]["name"], "Logic cells")


class Assemble(unittest.TestCase):
    def test_a_clean_run_is_ready(self):
        r = build()
        self.assertTrue(r["ready"])
        self.assertEqual(r["findings"], [])
        self.assertEqual([p["state"] for p in r["phases"]], ["done"] * 5)
        self.assertIn("bitstream ready", r["summary"])
        self.assertIn("64.8 MHz", r["summary"])
        self.assertIn("36/5280 LCs", r["summary"])

    def test_a_failing_testbench_is_not_ready(self):
        sim = parse_sim_log("  FAIL red LED dark (at 5000)\n  FAIL green toggled (at 9000)\n"
                            "FAIL  blink: 2 checks failed\n")
        r = build(sim=sim, bitstream=None)
        self.assertFalse(r["ready"])
        # vvp returned 0, but the testbench said no: the phase strip must show that.
        self.assertEqual(r["phases"][1]["state"], "failed")
        self.assertEqual(r["findings"][0]["kind"], "testbench")
        # Three FAIL lines, but the last is the testbench's own tally, not a third check.
        self.assertIn("2 failing checks", r["summary"])
        self.assertEqual(len(r["findings"]), 3)

    def test_pending_steps_read_as_pending_not_failed(self):
        steps = {"sim": dict(DONE), "waves": dict(DONE)}
        r = build(steps=steps, pnr={"utilization": [], "clocks": [], "diagnostics": []},
                  synth={"cells": 0, "byType": {}, "diagnostics": []}, bitstream=None)
        self.assertEqual([p["state"] for p in r["phases"]], ["done", "done", "pending", "pending", "pending"])
        self.assertFalse(r["ready"])

    def test_a_missed_clock_is_an_error_finding(self):
        slow = {**parse_pnr_report({"fmax": {"clk$x": {"achieved": 9.5, "constraint": 12.0}}, "utilization": {}}),
                "diagnostics": []}
        r = build(pnr=slow)
        self.assertFalse(r["ready"])
        self.assertEqual(r["findings"][0]["kind"], "timing")
        self.assertIn("9.5 MHz", r["findings"][0]["message"])

    def test_a_nearly_full_chip_warns_but_still_ships(self):
        full = {**parse_pnr_report({"fmax": {}, "utilization": {"ICESTORM_LC": {"used": 5200, "available": 5280}}}),
                "diagnostics": []}
        r = build(pnr=full)
        self.assertTrue(r["ready"])
        self.assertEqual(r["findings"][0]["severity"], "warning")
        self.assertIn("nearly full", r["findings"][0]["message"])

    def test_a_testbench_that_asserts_nothing_warns(self):
        sim = {"checks": [], "failures": [], "asserted": False, "diagnostics": []}
        r = build(sim=sim)
        self.assertTrue(r["ready"])  # it builds; it is just not proven
        self.assertEqual(r["findings"][0]["severity"], "warning")
        self.assertIn("never printed PASS or FAIL", r["findings"][0]["message"])

    def test_no_rtl_at_all(self):
        r = build(steps={}, rtl=(), bitstream=None)
        self.assertFalse(r["ready"])
        self.assertEqual(r["phases"][0]["state"], "active")
        self.assertEqual(r["findings"][0]["kind"], "rtl")

    def test_a_step_that_failed_silently_still_explains_itself(self):
        # nextpnr missing from PATH prints nothing a parser recognises; the phase must not go red
        # with no reason beside it.
        steps = {**ALL_DONE, "pnr": {"state": "failed", "exit": 127, "log": "out/logs/pnr.log",
                                     "tail": "nextpnr-ice40 is not installed - run toolchain/setup.sh"},
                 "pack": {"state": "failed", "exit": 127, "log": "out/logs/pack.log", "tail": ""}}
        r = build(steps=steps, pnr={"utilization": [], "clocks": [], "diagnostics": []}, bitstream=None)
        self.assertFalse(r["ready"])
        messages = [f["message"] for f in r["findings"]]
        self.assertIn("nextpnr-ice40 is not installed - run toolchain/setup.sh", messages)
        self.assertIn("bitstream failed — see out/logs/pack.log", messages)
        self.assertEqual([p["state"] for p in r["phases"]], ["done", "done", "done", "failed", "failed"])

    def test_a_parsed_failure_is_not_repeated_as_a_log_tail(self):
        steps = {**ALL_DONE, "synth": {"state": "failed", "exit": 1, "log": "out/logs/synth.log",
                                       "tail": "ERROR: Found 1 problems in 'check -assert'."}}
        synth = {"cells": 0, "byType": {}, "diagnostics": [
            {"severity": "error", "kind": "yosys", "message": "Found 1 problems in 'check -assert'."}]}
        r = build(steps=steps, synth=synth, bitstream=None)
        self.assertEqual(len([f for f in r["findings"] if "check -assert" in f["message"]]), 1)

    def test_a_latch_finding_explains_itself(self):
        synth = {"cells": 4, "byType": {}, "diagnostics": [
            {"severity": "warning", "kind": "latch", "message": r"Latch inferred for signal `\bad.\y'"}]}
        r = build(synth=synth)
        self.assertIn("infers a latch", r["findings"][0]["message"])


class Verdict(unittest.TestCase):
    def test_shape_is_spec_1(self):
        v = to_verdict(build(), "out/blink.report.json")
        self.assertEqual(v["spec"], 1)
        self.assertIs(v["ready"], True)
        self.assertEqual(v["artifact"], "out/blink.report.json")
        self.assertLessEqual(len(v["summary"]), 200)
        self.assertLessEqual(len(v["phases"]), 12)
        for p in v["phases"]:
            self.assertIn(p["state"], {"done", "active", "pending", "failed"})
            self.assertLessEqual(len(p["name"]), 40)
        for f in v["findings"]:
            self.assertIn(f["severity"], {"error", "warning", "info"})
            self.assertTrue(f["message"])
        self.assertRegex(v["updatedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_summary_is_capped(self):
        sim = {"checks": [], "failures": ["FAIL " + "x" * 400], "asserted": True, "diagnostics": []}
        self.assertLessEqual(len(to_verdict(build(sim=sim), "a")["summary"]), 200)


class Steps(unittest.TestCase):
    """What flow.sh leaves beside each log: <step>.start, <step>.time, <step>.exit."""

    def test_running_done_failed_skipped(self):
        with tempfile.TemporaryDirectory() as d:
            logs = Path(d)
            (logs / "sim.start").write_text("1000\n")
            (logs / "sim.time").write_text("1000 1750\n")
            (logs / "sim.exit").write_text("0\n")
            (logs / "sim.log").write_text("PASS\n")
            (logs / "synth.start").write_text("2000\n")
            (logs / "synth.log").write_text("")
            (logs / "pnr.exit").write_text("1\n")
            (logs / "pnr.log").write_text("Info: placing\nERROR: IO 'tx' is unconstrained\n")
            sim = read_step(logs, "sim", finished=False)
            self.assertEqual((sim["state"], sim["startedAt"], sim["seconds"]), ("done", 1000, 0.75))
            self.assertEqual(read_step(logs, "synth", finished=False)["state"], "running")
            pnr = read_step(logs, "pnr", finished=True)
            self.assertEqual((pnr["state"], pnr["tail"]), ("failed", "ERROR: IO 'tx' is unconstrained"))
            self.assertEqual(read_step(logs, "pack", finished=False), {"state": "pending"})
            self.assertEqual(read_step(logs, "pack", finished=True), {"state": "skipped"})

    def test_a_skipped_step_is_a_pending_phase(self):
        steps = dict(ALL_DONE)
        steps["synth"] = dict(FAILED)
        steps["pnr"] = {"state": "skipped"}
        steps["pack"] = {"state": "skipped"}
        r = build(steps=steps, bitstream=None)
        phases = {p["id"]: p["state"] for p in r["phases"]}
        self.assertEqual((phases["synthesize"], phases["pnr"], phases["bitstream"]), ("failed", "pending", "pending"))
        self.assertFalse(r["ready"])


if __name__ == "__main__":
    unittest.main()
