"""The pane's marimo settings take on the pinned marimo: .venv/bin/python -m unittest toolchain/test_viewer.py

viewer.py layers three settings over marimo's config by wrapping the factory `marimo._server.start`
calls. If a marimo bump moves that factory, the pane still starts (with marimo's defaults) — this
test is what notices.
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    import marimo._server.start as start
except ImportError:  # the plain `python3 -m unittest` run, outside the venv
    start = None


@unittest.skipIf(start is None, "marimo is not importable here; run with .venv/bin/python")
class PaneConfig(unittest.TestCase):
    def test_overrides_reach_the_server_config(self):
        import viewer

        original = start.get_default_config_manager
        try:
            viewer.tune()
            with tempfile.TemporaryDirectory() as ws:
                notebook = Path(ws, "notebook.py")
                notebook.write_text("import marimo\napp = marimo.App()\n")
                config = start.get_default_config_manager(current_path=str(notebook)).get_config()
            self.assertIs(config["runtime"]["auto_instantiate"], True)
            self.assertEqual(config["runtime"]["watcher_on_save"], "autorun")
            self.assertEqual(config["save"]["autosave"], "off")
        finally:
            start.get_default_config_manager = original


if __name__ == "__main__":
    unittest.main()
