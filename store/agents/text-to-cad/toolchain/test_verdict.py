"""python -m unittest toolchain/test_verdict.py — the verdict from what cadgen says, no cadgen needed."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from verdict import judge  # noqa: E402

FACTS = {"ok": True, "tokens": [{"summary": {"kind": "part", "shapeCount": 1}, "warnings": [], "entryFacts": {"size": [40.0, 30.0, 10.0]}}], "errors": []}
VALID = {"ok": True, "failureCount": 0, "parts": [], "errors": []}


class Judge(unittest.TestCase):
    def test_a_valid_step_is_ready_with_all_three_phases_done(self):
        v = judge(FACTS, VALID, has_models=True, step="STEP/part.step")
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "part.step · 1 solid · 40 × 30 × 10 mm · valid")
        self.assertEqual(v["artifact"], "STEP/part.step")

    def test_no_step_yet_is_building(self):
        v = judge({}, {}, has_models=True, step=None)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["summary"], "no STEP yet")

    def test_an_invalid_solid_fails_validate_with_a_finding(self):
        bad = {"ok": True, "failureCount": 1, "parts": [{"name": "lid", "ok": False, "reason": "open shell"}], "errors": []}
        v = judge(FACTS, bad, has_models=True, step="STEP/lid.step")
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][2]["state"], "failed")
        self.assertEqual(v["findings"][0]["message"], "lid: open shell")


if __name__ == "__main__":
    unittest.main()
