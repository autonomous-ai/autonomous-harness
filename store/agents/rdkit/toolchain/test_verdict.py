"""The judge, without RDKit: `python3 -m unittest toolchain/test_verdict.py` on any Python 3.10+."""
import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from verdict import judge

REPORT = {"name": "caffeine", "formula": "C8H10N4O2", "atoms": 24, "conformers": 1,
          "energies": {"forcefield": "MMFF94", "before": 91.2, "final": 28.4}, "violations": [],
          "properties": {"mw": 194.19, "logp": -1.03, "lipinski_violations": 0}}
SDF = {"path": "out/caffeine.sdf", "conformers": 1, "atoms": 24, "error": None}


class Judge(unittest.TestCase):
    def test_a_designed_and_embedded_molecule_is_ready(self):
        v = judge(True, REPORT, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["artifact"], "out/caffeine.sdf")
        self.assertEqual(v["summary"], "caffeine · C8H10N4O2 · MW 194.19 · cLogP -1.03 · 1 conformer · MMFF94 28.4 kcal/mol")
        self.assertEqual(v["findings"], [])

    def test_nothing_yet(self):
        v = judge(False, None, None)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertEqual(v["summary"], "no design yet")

    def test_a_script_without_a_report_is_still_designing(self):
        v = judge(True, None, None)
        self.assertEqual(v["summary"], "no molecule yet")
        self.assertEqual(v["phases"][0]["state"], "active")

    def test_an_sdf_that_does_not_parse_fails_embed(self):
        v = judge(True, REPORT, {"path": "out/x.sdf", "conformers": 0, "atoms": 0, "error": "bad valence"})
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0]["severity"], "error")
        self.assertIsNone(v["artifact"])

    def test_a_flat_sdf_has_no_conformer(self):
        v = judge(True, REPORT, {"path": "out/x.sdf", "conformers": 0, "atoms": 24, "error": None})
        self.assertFalse(v["ready"])
        self.assertIn("no conformer", v["findings"][0]["message"])

    def test_lipinski_violations_are_warnings_not_a_gate(self):
        report = {**REPORT, "violations": ["mw 612.3 > 500", "logp 6.1 > 5"]}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual([f["severity"] for f in v["findings"]], ["warning", "warning"])
        self.assertTrue(v["summary"].endswith("2 warnings"))

    def test_a_strained_conformer_warns(self):
        report = {**REPORT, "energies": {"forcefield": "MMFF94", "before": 900.0, "final": 480.0}}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual(v["findings"][0]["kind"], "energy")
        self.assertIn("strained", v["findings"][0]["message"])

    def test_an_unminimised_conformer_is_only_noted(self):
        report = {**REPORT, "energies": {"forcefield": None, "before": None, "final": None}}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual(v["findings"][0]["severity"], "info")

    def test_veber_alerts_and_stereo_are_reported_not_gated(self):
        report = {**REPORT, "veber": ["rotatable_bonds 17 > 10"], "alerts": ["Brenk: Aliphatic long chain"],
                  "unspecified_stereocenters": 1}
        v = judge(True, report, SDF)
        self.assertTrue(v["ready"])
        self.assertEqual([(f["kind"], f["severity"]) for f in v["findings"]],
                         [("veber", "warning"), ("alert", "warning"), ("stereo", "info")])
        self.assertTrue(v["summary"].endswith("2 warnings"))

    def test_an_analogue_names_its_parent_and_the_change(self):
        report = {**REPORT, "name": "caffeine_ethyl", "parent": {"name": "caffeine", "change": "+C", "similarity": 0.55}}
        v = judge(True, report, {**SDF, "conformers": 6})
        self.assertTrue(v["summary"].startswith("caffeine_ethyl (+C vs caffeine) · C8H10N4O2"))
        self.assertIn("6 conformers", v["summary"])


if __name__ == "__main__":
    unittest.main()
