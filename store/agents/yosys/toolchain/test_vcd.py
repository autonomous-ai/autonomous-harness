"""The VCD reader, on a dump shaped exactly like Icarus Verilog's."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from vcd2json import extend, parse, tick_fs  # noqa: E402

DUMP = """$date
\tWed Sep 16 13:10:58 2026
$end
$version
\tIcarus Verilog
$end
$timescale
\t1ps
$end
$scope module blink_tb $end
$var wire 1 ! ledg_n $end
$var parameter 32 # HALF $end
$var reg 1 ( clk $end
$var integer 32 + toggles [31:0] $end
$scope module dut $end
$var wire 1 ! ledg_n $end
$var reg 3 0 count [2:0] $end
$upscope $end
$scope task check $end
$var reg 320 3 what [319:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
$comment Show the parameter values. $end
$dumpall
b1000 #
$end
#0
$dumpvars
0(
1!
b0 0
b0 +
bx 3
$end
#5000
1(
b1 0
#10000
0(
b10 0
#15000
1(
0!
b11 0
b1 +
"""


class Header(unittest.TestCase):
    def setUp(self):
        self.w = parse(DUMP)
        self.by_name = {s["name"]: s for s in self.w["signals"]}

    def test_timescale(self):
        self.assertEqual(self.w["timescale"], "1ps")
        self.assertEqual(self.w["tickFs"], 1000)

    def test_parameters_are_not_waveforms(self):
        self.assertNotIn("blink_tb.HALF", self.by_name)

    def test_task_scopes_are_skipped(self):
        # Icarus dumps a task's arguments, including 320-bit string literals. Not a signal.
        self.assertFalse(any("what" in n for n in self.by_name))

    def test_names_are_scoped_and_one_lane_per_net(self):
        self.assertEqual([s["name"] for s in self.w["signals"]],
                         ["blink_tb.ledg_n", "blink_tb.clk", "blink_tb.toggles", "blink_tb.dut.count"])
        self.assertEqual(self.by_name["blink_tb.ledg_n"]["aliases"], ["blink_tb.dut.ledg_n"])

    def test_widths(self):
        self.assertEqual(self.by_name["blink_tb.dut.count"]["width"], 3)
        self.assertEqual(self.by_name["blink_tb.clk"]["width"], 1)


class Changes(unittest.TestCase):
    def setUp(self):
        self.w = parse(DUMP)
        self.by_name = {s["name"]: s for s in self.w["signals"]}

    def test_end_is_the_last_timestamp(self):
        self.assertEqual(self.w["end"], 15000)

    def test_scalar_edges(self):
        self.assertEqual(self.by_name["blink_tb.clk"]["changes"],
                         [[0, "0"], [5000, "1"], [10000, "0"], [15000, "1"]])

    def test_bus_values_are_extended_to_full_width(self):
        self.assertEqual(self.by_name["blink_tb.dut.count"]["changes"],
                         [[0, "000"], [5000, "001"], [10000, "010"], [15000, "011"]])

    def test_wide_bus_is_padded_not_truncated(self):
        self.assertEqual(self.by_name["blink_tb.toggles"]["changes"][1], [15000, "0" * 31 + "1"])

    def test_a_repeated_value_is_not_an_edge(self):
        w = parse(DUMP + "#20000\n1(\n")
        clk = next(s for s in w["signals"] if s["name"] == "blink_tb.clk")
        self.assertEqual(clk["changes"][-1], [15000, "1"])


class Extend(unittest.TestCase):
    def test_zero_extends(self):
        self.assertEqual(extend("1", 4), "0001")

    def test_x_and_z_extend_with_themselves(self):
        self.assertEqual(extend("x", 4), "xxxx")
        self.assertEqual(extend("z0", 4), "zzz0")

    def test_already_wide_enough(self):
        self.assertEqual(extend("1010", 4), "1010")


class Timescale(unittest.TestCase):
    def test_units(self):
        self.assertEqual(tick_fs("1ps"), 1000)
        self.assertEqual(tick_fs("10 ns"), 10 ** 7)
        self.assertEqual(tick_fs("1 fs"), 1)

    def test_nonsense_falls_back_to_a_picosecond(self):
        self.assertEqual(tick_fs("whenever"), 1000)


if __name__ == "__main__":
    unittest.main()
