import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from verdict import build_message, judge  # noqa: E402

PLAYS = {"create": True, "input": True, "gate": True}


class Judge(unittest.TestCase):
    def test_a_game_that_builds_and_plays_is_ready(self):
        v = judge(True, ["Title", "Play"], None, PLAYS, "out/dist/index.html")
        self.assertTrue(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "done", "done"])
        self.assertEqual(v["summary"], "2 scenes: Title, Play · builds · plays")
        self.assertEqual(v["artifact"], "out/dist/index.html")
        self.assertEqual(v["findings"], [])

    def test_a_build_error_fails_the_build_phase(self):
        v = judge(True, ["Play"], "src/scenes/Play.js:12:4: ERROR: Expected \";\"", PLAYS, None)
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["phases"][2]["state"], "pending")
        self.assertEqual(v["findings"][0]["severity"], "error")
        self.assertNotIn("artifact", v)

    def test_no_scene_is_an_error_even_when_main_exists(self):
        v = judge(True, [], None, {"create": False, "input": False, "gate": False}, None)
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][1]["state"], "failed")
        self.assertEqual(v["findings"][0]["kind"], "scene")

    def test_no_input_is_a_warning_and_play_stays_active(self):
        v = judge(True, ["Play"], None, {"create": True, "input": False, "gate": False}, "out/dist/index.html")
        self.assertFalse(v["ready"])
        self.assertEqual(v["phases"][2]["state"], "active")
        kinds = [f["kind"] for f in v["findings"]]
        self.assertEqual(kinds, ["input", "focus"])
        self.assertIn("1 warning", v["summary"])

    def test_a_missing_click_gate_is_only_info(self):
        v = judge(True, ["Play"], None, {"create": True, "input": True, "gate": False}, None)
        self.assertTrue(v["ready"])
        self.assertEqual([f["severity"] for f in v["findings"]], ["info"])

    def test_an_empty_workspace_is_writing(self):
        v = judge(False, [], None, {"create": False, "input": False, "gate": False}, None)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["active", "pending", "pending"])
        self.assertEqual(v["summary"], "no game yet")

    def test_no_build_does_not_claim_a_build_nobody_ran(self):
        v = judge(True, ["Title", "Play"], None, PLAYS, None, build_ran=False)
        self.assertFalse(v["ready"])
        self.assertEqual([p["state"] for p in v["phases"]], ["done", "active", "pending"])
        self.assertEqual(v["summary"], "2 scenes: Title, Play · not built yet")

    def test_summary_stays_inside_the_header(self):
        v = judge(True, [f"Scene{i}" for i in range(20)], None, PLAYS, None)
        self.assertLessEqual(len(v["summary"]), 200)
        self.assertIn("…", v["summary"])


class BuildMessage(unittest.TestCase):
    def test_takes_the_lines_after_error_during_build(self):
        out = (
            "vite v6.4.3 building for production...\n"
            "\x1b[31merror during build:\x1b[0m\n"
            "[vite:esbuild] Transform failed with 1 error:\n"
            "/tmp/ws/src/scenes/Play.js:12:4: ERROR: Expected \";\" but found \"x\"\n"
        )
        msg = build_message(out)
        self.assertIn("Play.js:12:4", msg)
        self.assertNotIn("\x1b", msg)

    def test_stops_before_rollups_file_line_and_stack(self):
        out = (
            "error during build:\n"
            "[vite]: Rollup failed to resolve\n"
            "Could not resolve \"../nope.js\" from \"src/scenes/Play.js\"\n"
            "file: /tmp/ws/src/scenes/Play.js\n"
            "    at getRollupError (file:///.../parseAst.js:319:41)\n"
        )
        msg = build_message(out)
        self.assertEqual(msg, '[vite]: Rollup failed to resolve Could not resolve "../nope.js" from "src/scenes/Play.js"')

    def test_falls_back_to_an_error_line(self):
        self.assertIn("Could not resolve", build_message("blah\n[vite]: Rollup failed: Could not resolve './Missing.js'\n"))

    def test_empty_output(self):
        self.assertEqual(build_message("   \n\n"), "vite build failed with no output")


if __name__ == "__main__":
    unittest.main()
