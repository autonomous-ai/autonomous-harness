import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from verdict import judge

class Judge(unittest.TestCase):
    def test_compiles_clean(self):
        v = judge("= Hi", "", 0, "out/main.pdf", 2)
        self.assertTrue(v["ready"]); self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "main.pdf · 2 pages · compiles")
    def test_error_is_parsed_with_its_place(self):
        diag = "error: unknown variable: foo\n  ┌─ main.typ:3:5\n  │\n3 │ #foo\n"
        v = judge("#foo", diag, 1, None, None)
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0], {"severity": "error", "kind": "typst", "message": "unknown variable: foo", "ref": "main.typ:3:5"})
    def test_warning_keeps_review_open(self):
        diag = "warning: unused import\n  ┌─ main.typ:1:1\n"
        v = judge("x", diag, 0, "out/main.pdf", 1)
        self.assertTrue(v["ready"]); self.assertEqual(v["phases"][2]["state"], "active")

if __name__ == "__main__": unittest.main()
