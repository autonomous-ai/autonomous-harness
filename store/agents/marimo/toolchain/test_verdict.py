import sys, unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from verdict import count_cells, judge

NB = '''import marimo
app = marimo.App()

@app.cell
def _():
    import marimo as mo
    return (mo,)

@app.cell
def _(mo):
    mo.md("hi")
    return
'''

class Verdict(unittest.TestCase):
    def test_cells_are_counted(self):
        self.assertEqual(count_cells(NB), 2); self.assertEqual(count_cells("def ("), -1)
    def test_runs(self):
        v = judge(2, "All checks passed", 0, "", 0, "notebook.py")
        self.assertTrue(v["ready"]); self.assertEqual(v["summary"], "notebook.py · 2 cells · runs")
    def test_check_failure(self):
        v = judge(2, "notebook.py:12: error MB001 multiple definitions of x", 1, None, None, "notebook.py")
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][1]["state"], "failed"); self.assertEqual(v["findings"][0]["severity"], "error")
    def test_run_failure(self):
        v = judge(2, "", 0, "Traceback\nZeroDivisionError: division by zero", 1, "notebook.py")
        self.assertFalse(v["ready"]); self.assertEqual(v["phases"][2]["state"], "failed"); self.assertIn("ZeroDivisionError", v["findings"][0]["message"])

if __name__ == "__main__": unittest.main()
