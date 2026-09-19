"""Portable runner copied into each independently installable studio package."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def workspace():
    return Path(os.environ.get("HARNESS_WORKSPACE", os.getcwd())).resolve()


def package():
    return Path(__file__).resolve().parent.parent


def contained(path):
    target = Path(path).resolve()
    target.relative_to(workspace())
    return target


def atomic_json(path, data):
    path = contained(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, prefix=".studio-", delete=False) as f:
            temp = f.name
            json.dump(data, f, indent=2, allow_nan=False)
            f.write("\n")
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


def command(argv, cwd=None, timeout=120, env=None):
    """No shell interpolation; keep complete logs as output, bound execution time."""
    result = subprocess.run([str(x) for x in argv], cwd=cwd, timeout=timeout,
                            env=env, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-1600:] or f"{argv[0]} exited {result.returncode}")
    return result.stdout


def parameters(config, values):
    if not isinstance(values, dict) or set(values) - {c["id"] for c in config["controls"]}:
        raise ValueError("Invalid studio controls")
    result = {}
    for c in config["controls"]:
        value = values.get(c["id"], c["value"])
        if c["type"] == "number":
            if type(value) not in (int, float) or not math.isfinite(value) or not c["min"] <= value <= c["max"]:
                raise ValueError(f'{c["label"]} is outside its range')
            if c.get("integer") and value != int(value):
                raise ValueError(f'{c["label"]} must be a whole number')
        elif c["type"] == "select":
            if value not in [o["value"] for o in c["options"]]:
                raise ValueError(f'Unknown {c["label"]}')
        elif not isinstance(value, str) or len(value) > c.get("maxLength", 500):
            raise ValueError(f'Invalid {c["label"]}')
        result[c["id"]] = value
    return result


def metric(label, value, unit=""):
    return {"label": label, "value": value, "unit": unit}


def previous_runs():
    base = contained(workspace() / "out/runs")
    rows = []
    for p in sorted(base.glob("*/result.json"))[-100:]:
        try:
            rows.append(json.loads(contained(p).read_text()))
        except (ValueError, OSError):
            continue
    return rows


def execute(actions):
    root = workspace()
    config = json.loads((package() / "studio.config.json").read_text())
    action = sys.argv[1] if len(sys.argv) > 1 else config["actions"][0]["id"]
    started = time.monotonic()
    verdict_path = root / ".harness/verdict.json"
    verdict = {"spec": 1, "ready": False, "summary": "Preparing the studio run", "findings": [],
               "phases": [{"id": "run", "name": "Make", "state": "active"},
                          {"id": "inspect", "name": "Inspect", "state": "pending"}]}
    try:
        if action not in actions:
            raise ValueError(f"Unknown action: {action}")
        source = contained(root / "studio.json")
        if source.stat().st_size > 16384:
            raise ValueError("studio.json is too large")
        project = json.loads(source.read_text())
        p = parameters(config, project["parameters"])
        atomic_json(verdict_path, verdict)
        run_id = time.strftime("%Y%m%dT%H%M%S", time.gmtime()) + "-" + uuid.uuid4().hex[:8]
        output = contained(root / "out/runs" / run_id)
        output.mkdir(parents=True)
        print(f'{config["title"]}: {action}', flush=True)
        result = actions[action](p, output)
        artifacts = []
        for artifact in result.pop("files", []):
            file = contained(output / artifact["name"])
            file.relative_to(output)
            if not file.is_file() or not file.stat().st_size:
                raise ValueError(f'Missing output: {artifact["name"]}')
            artifacts.append({"label": artifact["label"], "path": str(file.relative_to(root))})
        result.update({"spec": 1, "id": run_id, "action": action, "parameters": p,
                       "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       "durationSeconds": round(time.monotonic() - started, 3), "artifacts": artifacts,
                       "upstream": json.loads((package() / "upstream.lock.json").read_text())})
        atomic_json(output / "result.json", result)
        atomic_json(root / "out/latest.json", result)
        verdict.update({"ready": True, "summary": f'{result["title"]} · {result["engine"]}',
                        "artifact": str((output / "result.json").relative_to(root)),
                        "phases": [{"id": "run", "name": "Make", "state": "done"},
                                   {"id": "inspect", "name": "Inspect", "state": "done"}],
                        "updatedAt": result["createdAt"]})
        atomic_json(verdict_path, verdict)
        print(f'Ready: {result["title"]}', flush=True)
    except Exception as exc:
        verdict.update({"summary": str(exc)[:500], "findings": [{"severity": "error", "kind": "run-failed", "message": str(exc)[:1000]}],
                        "phases": [{"id": "run", "name": "Make", "state": "failed"}]})
        try:
            atomic_json(verdict_path, verdict)
        except (ValueError, OSError):
            pass
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from exc
