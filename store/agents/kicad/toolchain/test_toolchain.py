"""python3 -m unittest discover -s toolchain — the KiCad wrapper holds together.

The wrapper is a manifest, a pin and five hand-off scripts. These tests check the manifest's every
path points into `upstream/harness/kicad/` (the package this wraps), the pin is a full commit of the
project's public repository, the scripts exist, are executable and hand off to the right upstream
script with the environment the KiCad package's own scripts expect, and `runtimes.sh` is the store's copy. No
network, no install: the hand-offs are exercised against a stub `upstream/` in a temp dir.
"""
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

TOOLCHAIN = Path(__file__).resolve().parent
PACKAGE = TOOLCHAIN.parent
STORE = PACKAGE.parents[1]
UPSTREAM_PKG = "upstream/harness/kicad"
SCRIPTS = ("fetch-upstream.sh", "setup.sh", "doctor.sh", "init-workspace.sh", "viewer.sh", "python")
# A stub of a KiCad package script: says which one ran, with what, where; exits with $STUB_EXIT.
STUB = ('#!/bin/sh\necho "{name} dsh=$HARNESS_DSH_DIR python=${{CIRCUIT_PYTHON:-}} toolchain=${{CIRCUIT_TOOLCHAIN:-}} '
        'pwd=$(pwd -P)"\nexit "${{STUB_EXIT:-0}}"\n')


def manifest() -> dict:
    return json.loads((PACKAGE / "harness.json").read_text())


def versions_value(key: str) -> str:
    match = re.search(rf'^{key}="([^"]*)"$', (PACKAGE / "VERSIONS").read_text(), re.M)
    assert match, key
    return match.group(1)


class ManifestTest(unittest.TestCase):

    def test_identity(self):
        m = manifest()
        self.assertEqual((m["spec"], m["id"], m["name"], m["category"]), (1, "autonomous/kicad", "KiCad", "PCB"))
        self.assertIn(m["engine"], ("claude", "codex"))
        self.assertEqual(m["verdict"], ".harness/verdict.json")

    def test_every_project_path_points_into_the_wrapped_package(self):
        m = manifest()
        for rel in (m["workspace"]["template"], m["agent"]["instructions"], *m["agent"]["skills"]):
            self.assertTrue(rel.startswith(UPSTREAM_PKG + "/"), rel)
        self.assertEqual(m["workspace"]["marker"], "project.json")

    def test_the_agent_runs_the_pipeline_on_the_wrappers_python(self):
        env = manifest()["agent"]["env"]
        self.assertEqual(env["KICAD_HARNESS_PYTHON"], "${dsh}/" + UPSTREAM_PKG + "/toolchain/python")
        self.assertEqual(env["CIRCUIT_PYTHON"], "${dsh}/toolchain/python")
        self.assertEqual(env["KICAD_HARNESS_ROOT"], "${dsh}/upstream")
        self.assertEqual(env["CIRCUIT_TOOLCHAIN"], "${dsh}/upstream/toolchain")
        expected = ".agents/skills" if manifest()["engine"] == "codex" else ".claude/skills"
        self.assertTrue(env["CIRCUIT_SKILLS_DIR"].endswith(expected))

    def test_the_wrappers_own_scripts_are_named_and_executable(self):
        m = manifest()
        for rel in (m["workspace"]["init"], m["toolchain"]["setup"], m["toolchain"]["doctor"], m["viewer"]["command"]):
            self.assertTrue(rel.startswith("toolchain/"), rel)
            self.assertTrue(os.access(PACKAGE / rel, os.X_OK), rel)
        for name in SCRIPTS:
            self.assertTrue(os.access(TOOLCHAIN / name, os.X_OK), name)

    def test_versions_pins_a_full_commit_of_the_projects_public_repository(self):
        self.assertRegex(versions_value("UPSTREAM_COMMIT"), r"^[0-9a-f]{40}$")
        self.assertEqual(versions_value("UPSTREAM_REPO"), "https://github.com/autonomous-ai/autonomous-circuit.git")
        self.assertEqual(versions_value("UPSTREAM_SPARSE_MODE"), "no-cone")

    def test_runtimes_is_the_stores_copy(self):
        ours = hashlib.sha256((TOOLCHAIN / "runtimes.sh").read_bytes()).hexdigest()
        theirs = hashlib.sha256((STORE / "tools" / "runtimes.sh").read_bytes()).hexdigest()
        self.assertEqual(ours, theirs, "run node store/tools/sync-runtimes.mjs")

    def test_store_json_credits_the_upstream(self):
        s = json.loads((PACKAGE / "store.json").read_text())
        self.assertEqual(s["upstream"], "https://github.com/autonomous-ai/autonomous-circuit")
        self.assertEqual(s["license"], "MIT")
        self.assertLessEqual(len(s["tagline"]), 80)


class HandoffTest(unittest.TestCase):
    """Each hand-off script runs the stub of its upstream twin with the environment the KiCad package expects."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.install = self.tmp / "install"
        (self.install / "toolchain").mkdir(parents=True)
        for name in ("init-workspace.sh", "viewer.sh", "doctor.sh", "runtimes.sh"):
            shutil.copy(TOOLCHAIN / name, self.install / "toolchain" / name)
        shutil.copy(PACKAGE / "VERSIONS", self.install / "VERSIONS")
        pkg = self.install / UPSTREAM_PKG / "toolchain"
        pkg.mkdir(parents=True)
        for name in ("init-workspace.sh", "viewer.sh", "doctor.sh"):
            path = pkg / name
            path.write_text(STUB.format(name=name))
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        (self.install / "upstream" / ".harness-commit").write_text(versions_value("UPSTREAM_COMMIT"))
        # A venv python that answers the version probe.
        venv = self.install / ".venv" / "bin"
        venv.mkdir(parents=True)
        (venv / "python").write_text('#!/bin/sh\nexit 0\n')
        (venv / "python").chmod(0o755)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("HARNESS_", "CIRCUIT_"))}

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_script(self, name, cwd=None, **extra):
        return subprocess.run([str(self.install / "toolchain" / name)], cwd=cwd or self.install,
                              env={**self.env, **extra}, capture_output=True, text=True, timeout=60)

    def test_init_runs_the_packages_own_in_the_workspace_with_its_package_dir(self):
        ws = self.tmp / "ws"
        ws.mkdir()
        out = self.run_script("init-workspace.sh", cwd=ws)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn(f"init-workspace.sh dsh={self.install}/{UPSTREAM_PKG} python={self.install}/toolchain/python", out.stdout)
        self.assertIn(f"pwd={ws.resolve()}", out.stdout)

    def test_viewer_hands_off_with_the_package_dir_and_the_venv_python(self):
        out = self.run_script("viewer.sh", HARNESS_VIEWER_PORT="1", HARNESS_WORKSPACE=str(self.tmp))
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn(f"viewer.sh dsh={self.install}/{UPSTREAM_PKG} python={self.install}/toolchain/python", out.stdout)

    def test_doctor_at_the_pin_hands_over_with_toolchain_and_python(self):
        out = self.run_script("doctor.sh")
        self.assertEqual(out.returncode, 0, out.stderr + out.stdout)
        self.assertIn("ok   autonomous-circuit @ " + versions_value("UPSTREAM_COMMIT")[:12], out.stdout)
        self.assertIn(f"doctor.sh dsh= python={self.install}/toolchain/python toolchain={self.install}/upstream/toolchain", out.stdout)

    def test_doctor_before_setup_is_a_miss(self):
        (self.install / "upstream" / ".harness-commit").unlink()
        out = self.run_script("doctor.sh")
        self.assertEqual(out.returncode, 1)
        self.assertIn("miss autonomous-circuit is not fetched", out.stdout)

    def test_doctor_warns_when_the_copy_is_behind_the_pin(self):
        (self.install / "upstream" / ".harness-commit").write_text("0" * 40)
        out = self.run_script("doctor.sh")
        self.assertIn("warn autonomous-circuit @ 000000000000, VERSIONS pins", out.stdout)

    def test_doctor_relays_the_packages_failure(self):
        out = self.run_script("doctor.sh", STUB_EXIT="1")
        self.assertEqual(out.returncode, 1)

    def test_doctor_without_the_venv_is_a_miss_and_still_asks_the_package(self):
        shutil.rmtree(self.install / ".venv")
        out = self.run_script("doctor.sh")
        self.assertEqual(out.returncode, 1)
        self.assertIn("miss .venv", out.stdout)
        self.assertIn("doctor.sh dsh=", out.stdout)


if __name__ == "__main__":
    unittest.main()
