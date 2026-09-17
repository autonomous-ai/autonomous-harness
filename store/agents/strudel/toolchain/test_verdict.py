"""python3 -m unittest toolchain/test_verdict.py — what the verdict says about a track."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import verdict  # noqa: E402

TEMPLATE = HERE.parent / "template" / "track.strudel"
GOOD = 'setcpm(120/4)\nstack(\n  s("sbd*4").decay(0.2),\n  note("<c2 g1>(3,8)").s("sawtooth").lpf(800)\n)\n'


def kinds(result: dict, severity: str) -> list[str]:
    return [f["kind"] for f in result["findings"] if f["severity"] == severity]


class Judging(unittest.TestCase):
    def test_a_synth_track_is_ready_and_plays_offline(self) -> None:
        result = verdict.judge(GOOD, "track.strudel")
        self.assertTrue(result["ready"], result["findings"])
        self.assertEqual(result["artifact"], "track.strudel")
        self.assertIn("plays offline", result["summary"])
        self.assertEqual([p["state"] for p in result["phases"]], ["done", "done", "done"])

    def test_an_empty_file_is_not_written_yet(self) -> None:
        result = verdict.judge("\n// nothing here yet\n\n", "track.strudel")
        self.assertFalse(result["ready"])
        self.assertIn("empty", kinds(result, "error"))
        self.assertEqual([p["state"] for p in result["phases"]], ["active", "pending", "pending"])

    def test_an_unclosed_bracket_is_an_error_with_a_line(self) -> None:
        result = verdict.judge('stack(\n  s("sbd*4"),\n  note("c2")\n', "track.strudel")
        self.assertFalse(result["ready"])
        self.assertIn("syntax", kinds(result, "error"))
        self.assertTrue(any("line 1" in f["message"] for f in result["findings"]))

    def test_a_stray_bracket_is_an_error(self) -> None:
        result = verdict.judge('s("sbd*4"))\n', "track.strudel")
        self.assertFalse(result["ready"])
        self.assertTrue(any("stray )" in f["message"] for f in result["findings"]))

    def test_an_unclosed_quote_is_an_error(self) -> None:
        result = verdict.judge('s("sbd*4)\n', "track.strudel")
        self.assertFalse(result["ready"])
        self.assertTrue(any('" string is never closed' in f["message"] for f in result["findings"]))

    def test_brackets_inside_strings_and_comments_do_not_count(self) -> None:
        source = '// stack( [ {\n/* ) ] } */\ns("[bd sd]*2, white*8").gain("[0.3 0.14]*4")\n'
        result = verdict.judge(source, "track.strudel")
        self.assertEqual(kinds(result, "error"), [])

    @unittest.skipIf(subprocess.run(["node", "--version"], capture_output=True).returncode != 0, "node is not on PATH")
    def test_node_catches_what_the_bracket_scan_cannot(self) -> None:
        # Balanced brackets, balanced quotes, and still not a program.
        result = verdict.judge('note("c3") ,, .s("sawtooth")\n', "track.strudel")
        self.assertFalse(result["ready"])
        self.assertIn("syntax", kinds(result, "error"))
        self.assertTrue(any("node could not parse" in f["message"] for f in result["findings"]))

    @unittest.skipIf(subprocess.run(["node", "--version"], capture_output=True).returncode != 0, "node is not on PATH")
    def test_node_allows_top_level_await_the_way_the_repl_does(self) -> None:
        self.assertEqual(verdict.node_check('await samples("github:x/y")\ns("bd")\n'), [])

    def test_import_is_refused(self) -> None:
        result = verdict.judge('import { x } from "y"\n' + GOOD, "track.strudel")
        self.assertFalse(result["ready"])
        self.assertIn("scope", kinds(result, "error"))

    def test_prose_without_a_pattern_call_is_not_a_track(self) -> None:
        result = verdict.judge("const bpm = 120\n", "track.strudel")
        self.assertFalse(result["ready"])
        self.assertIn("pattern", kinds(result, "error"))

    def test_sample_sounds_are_a_warning_not_an_error(self) -> None:
        result = verdict.judge('setcpm(30)\ns("bd sd, hh*8").bank("RolandTR909")\n', "track.strudel")
        self.assertTrue(result["ready"], result["findings"])
        self.assertIn("network", kinds(result, "warning"))
        message = next(f["message"] for f in result["findings"] if f["kind"] == "network")
        self.assertIn("bd", message)
        self.assertIn("internet", result["summary"])

    def test_synth_aliases_do_not_trip_the_network_warning(self) -> None:
        result = verdict.judge('setcps(0.5)\ns("<saw sqr tri sin supersaw pulse white sbd>*4")\n', "track.strudel")
        self.assertEqual(kinds(result, "warning"), [])

    def test_a_missing_tempo_is_only_a_note(self) -> None:
        result = verdict.judge('s("sbd*4")\n', "track.strudel")
        self.assertTrue(result["ready"])
        self.assertIn("tempo", kinds(result, "info"))

    def test_the_template_is_ready_and_offline(self) -> None:
        result = verdict.judge(TEMPLATE.read_text(), "track.strudel")
        self.assertTrue(result["ready"], result["findings"])
        self.assertEqual(kinds(result, "warning"), [])
        self.assertIn("plays offline", result["summary"])


class Writing(unittest.TestCase):
    def run_in(self, workspace: Path, *args: str) -> tuple[int, dict]:
        env = {**os.environ, "HARNESS_WORKSPACE": str(workspace)}
        done = subprocess.run([sys.executable, str(HERE / "verdict.py"), *args], env=env, capture_output=True, text=True)
        written = workspace / ".harness" / "verdict.json"
        return done.returncode, json.loads(written.read_text()) if written.exists() else {}

    def test_it_writes_the_verdict_beside_the_track(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "track.strudel").write_text(GOOD)
            code, written = self.run_in(workspace)
            self.assertEqual(code, 0)
            self.assertEqual(written["spec"], 1)
            self.assertTrue(written["ready"])
            self.assertEqual(written["artifact"], "track.strudel")
            self.assertEqual(len(written["phases"]), 3)

    def test_a_missing_file_is_unreadable_not_a_crash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code, written = self.run_in(Path(tmp))
            self.assertEqual(code, 1)
            self.assertFalse(written["ready"])
            self.assertIn("unreadable", written["summary"])

    def test_it_judges_the_file_it_is_given(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "b-side.strudel").write_text(GOOD)
            code, written = self.run_in(workspace, "b-side.strudel")
            self.assertEqual(code, 0)
            self.assertEqual(written["artifact"], "b-side.strudel")


if __name__ == "__main__":
    unittest.main()
