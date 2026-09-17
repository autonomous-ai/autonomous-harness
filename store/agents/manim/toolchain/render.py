#!/usr/bin/env python
"""Render Manim scenes the way the pane shows them, then judge them.

    "$MANIM_PYTHON" "$MANIM_TOOLCHAIN/render.py" scenes/proof.py Proof        # -ql by default: 480p15
    "$MANIM_PYTHON" "$MANIM_TOOLCHAIN/render.py" -qh scenes/proof.py Proof    # the final render

It is `manim render` — same flags, same output, same tracebacks — with `--media_dir out` and
`--save_sections` added (so every `self.next_section("…")` becomes a chapter), plus two files the
Video Viewer pane reads:

- `.harness/render.json` while it renders: the scene, animation n of ~m (m is the previous render's
  count), the section it is in, the clips written so far (playable in the pane before the movie
  exists), and on failure the error with the scene file and line.
- `.harness/renders/<video path>.json` when a scene lands: its animations (label, run time, clip,
  section) and the clips of the render before, so the pane can mark chapters and what changed.

Then the verdict (toolchain/verdict.py) is written. Exit status: Manim's when it failed, else the
verdict's (0 = ready).
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
HERE = Path(__file__).resolve().parent
STATUS = WS / ".harness" / "render.json"


def now_ms() -> int:
    return int(time.time() * 1000)


def rel(path) -> str | None:
    if path is None:
        return None
    try:
        return os.path.relpath(Path(path).resolve(), WS).replace(os.sep, "/")
    except (OSError, ValueError):
        return str(path)


def write_json(path: Path, data: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n")
        os.replace(tmp, path)
    except OSError:
        pass


def sidecar_path(output: str) -> Path:
    return WS / ".harness" / "renders" / f"{output}.json"


def with_manim_args(argv: list[str]) -> list[str]:
    args = list(argv)
    if args and args[0] == "render":
        args = args[1:]
    flags = " ".join(args)
    if not any(a.startswith("-q") or a.startswith("--quality") or a in ("-r", "--resolution") for a in args):
        args = ["-ql", *args]
    if "--media_dir" not in flags:
        args = ["--media_dir", "out", *args]
    if "--save_sections" not in flags:
        args = ["--save_sections", *args]
    return ["render", *args]


def error_from(exc: BaseException | None, tb) -> dict:
    if exc is None:
        return {"type": "Error", "message": "manim exited with an error"}
    out = {"type": type(exc).__name__, "message": str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__}
    if isinstance(exc, SyntaxError) and exc.filename:
        out.update(file=rel(exc.filename), line=exc.lineno, code=(exc.text or "").strip() or None)
        return out
    # The deepest frame in the workspace (the scene), not inside Manim.
    for frame in reversed(traceback.extract_tb(tb)):
        try:
            p = Path(frame.filename).resolve()
        except OSError:
            continue
        if WS in p.parents and ".venv" not in p.parts and "site-packages" not in p.parts:
            out.update(file=rel(p), line=frame.lineno, code=(frame.line or "").strip() or None, function=frame.name)
            break
    return out


QUALITY = {"l": "480p15", "m": "720p30", "h": "1080p60", "p": "1440p60", "k": "2160p60"}


def guess_target(command: list[str]) -> dict:
    """Before Manim has built a scene (a syntax error in the file), what the command meant to render."""
    source = next((a for a in command if a.endswith(".py")), None)
    if not source:
        return {}
    after = command[command.index(source) + 1:]
    scene = next((a for a in after if not a.startswith("-")), None)
    quality = next((QUALITY.get(a[2:3]) for a in command if a.startswith("-q") and len(a) == 3), None) or "480p15"
    media = command[command.index("--media_dir") + 1] if "--media_dir" in command else "media"
    out = {"source": rel(WS / source) if not os.path.isabs(source) else rel(source), "scene": scene, "quality": quality}
    if scene:
        out["output"] = f"{media}/videos/{Path(source).stem}/{quality}/{scene}.mp4"
    return out


class Status:
    def __init__(self, command: list[str]):
        self.command = command
        self.data: dict = {}
        self.scenes_begun = 0
        self.current_scene = None
        self.started = now_ms()
        self.last_write = 0.0

    def write(self, force: bool = False) -> None:
        t = time.monotonic()
        if not force and t - self.last_write < 0.12:
            return
        self.last_write = t
        self.data["updatedAtMs"] = now_ms()
        write_json(STATUS, self.data)

    # -- scene lifecycle -------------------------------------------------------------------------
    def begin(self, scene) -> None:
        from manim import __version__, config

        self.scenes_begun += 1
        self.current_scene = scene
        fw = scene.renderer.file_writer
        output = None
        if getattr(config, "format", None) == "gif" and hasattr(fw, "gif_file_path"):
            output = fw.gif_file_path
        elif hasattr(fw, "movie_file_path"):
            output = fw.movie_file_path
        elif hasattr(fw, "image_file_path"):
            output = fw.image_file_path
        out_rel = rel(output)
        previous = None
        if out_rel:
            old = sidecar_path(out_rel)
            try:
                previous = json.loads(old.read_text())
            except (OSError, ValueError):
                previous = None
        self.previous = previous
        self.data = {
            "spec": 1,
            "tool": f"manim {__version__}",
            "pid": os.getpid(),
            "state": "rendering",
            "command": " ".join(["manim", *self.command]),
            "source": rel(config.input_file) if config.input_file else None,
            "scene": type(scene).__name__,
            "quality": Path(output).parent.name if output else None,
            "output": out_rel,
            "startedAtMs": now_ms(),
            "animation": 0,
            "expected": len(previous.get("animations") or []) if previous else None,
            "current": None,
            "section": None,
            "sections": [],
            "clips": [],
            "animations": [],
            "error": None,
        }
        self.write(force=True)

    def sync(self, fw, label: str | None = None, run_time: float | None = None) -> None:
        if not self.data:
            return
        files = list(getattr(fw, "partial_movie_files", []) or [])
        sections, index = [], 0
        for s in getattr(fw, "sections", []) or []:
            sections.append({"name": s.name, "animation": index, "skipped": bool(s.skip_animations)})
            index += len(s.partial_movie_files)
        # The auto-created first section is dropped by Manim once a named one begins before any play.
        self.data["sections"] = sections
        self.data["section"] = sections[-1]["name"] if sections else None
        self.data["clips"] = [rel(f) for f in files if f is not None]
        self.data["animation"] = len(files)
        if label is not None:
            section_index = max(0, len(sections) - 1)
            self.data["animations"].append({
                "index": len(files) - 1,
                "label": label,
                "runTime": round(run_time, 4) if run_time is not None else None,
                "clip": Path(files[-1]).name if files and files[-1] else None,
                "section": section_index,
            })
            self.data["current"] = label
        self.write(force=label is not None)

    def finish(self, scene) -> None:
        if not self.data:
            return
        fw = scene.renderer.file_writer
        self.sync(fw)
        self.data["state"] = "done"
        self.data["finishedAtMs"] = now_ms()
        self.data["current"] = None
        out = self.data.get("output")
        if out and (WS / out).is_file():
            clips_dir = Path(getattr(fw, "partial_movie_directory", "")) if getattr(fw, "partial_movie_directory", None) else None

            def clip_entries(names):
                entries = []
                for name in names:
                    size = None
                    if clips_dir is not None:
                        try:
                            size = (clips_dir / name).stat().st_size
                        except OSError:
                            size = None
                    entries.append({"name": name, "size": size})
                return entries

            names = [Path(f).name for f in (fw.partial_movie_files or []) if f is not None]
            prev = self.previous or {}
            sidecar = {
                "spec": 1,
                "tool": self.data.get("tool"),
                "video": out,
                "scene": self.data.get("scene"),
                "source": self.data.get("source"),
                "quality": self.data.get("quality"),
                "renderedAtMs": self.data["finishedAtMs"],
                "tookMs": self.data["finishedAtMs"] - self.data["startedAtMs"],
                "clipsDir": rel(clips_dir) if clips_dir else None,
                "clips": clip_entries(names),
                "duration": round(sum((a.get("runTime") or 0) for a in self.data.get("animations", []) if a.get("clip")), 4),
                "animations": self.data.get("animations", []),
                "sections": [s for s in self.data.get("sections", []) if not s.get("skipped")],
                "previous": {"renderedAtMs": prev.get("renderedAtMs"), "duration": prev.get("duration"), "clips": prev.get("clips") or [], "sections": prev.get("sections") or []} if prev else None,
            }
            write_json(sidecar_path(out), sidecar)
        self.write(force=True)

    def fail(self, exc: BaseException | None, tb, cancelled: bool = False) -> None:
        if not self.data:
            self.data = {"spec": 1, "pid": os.getpid(), "command": " ".join(["manim", *self.command]), "startedAtMs": self.started, "animation": 0, "clips": [], "sections": [], **guess_target(self.command)}
        if self.data.get("state") in ("failed", "cancelled"):
            return
        self.data["state"] = "cancelled" if cancelled else "failed"
        self.data["finishedAtMs"] = now_ms()
        self.data["error"] = None if cancelled else error_from(exc, tb)
        self.write(force=True)


def describe(animation) -> str:
    """A short label for the pane's timeline: "FadeIn(Text “The theorem”)", "animate(Square)", "Wait"."""
    name = type(animation).__name__
    if name == "Wait":
        return "Wait"
    if name == "_MethodAnimation":
        name = "animate"
    mobject = getattr(animation, "mobject", None)
    if mobject is None:
        return name
    kind = type(mobject).__name__
    text = getattr(mobject, "original_text", None) or getattr(mobject, "text", None) or getattr(mobject, "tex_string", None)
    if isinstance(text, str) and text.strip():
        t = " ".join(text.split())
        return f"{name}({kind} “{t[:32].rstrip()}{'…' if len(t) > 32 else ''}”)"
    return f"{name}({kind})"


def install_hooks(status: Status) -> None:
    """Wrap the few Manim methods that mark a scene's progress. Each hook calls through first, and a
    hook that fails never stops the render: the pane is a nicety, the render is the work."""
    from manim.scene.scene import Scene
    from manim.scene.scene_file_writer import SceneFileWriter
    from manim.renderer.cairo_renderer import CairoRenderer
    import manim.cli.render.commands as commands

    current = {"scene": None}

    def safely(fn, *a):
        try:
            fn(*a)
        except Exception:
            pass

    orig_render = Scene.render

    def render(self, *args, **kwargs):
        safely(status.begin, self)
        try:
            result = orig_render(self, *args, **kwargs)
        except KeyboardInterrupt:
            safely(status.fail, None, None, True)
            raise
        except BaseException as exc:
            safely(status.fail, exc, exc.__traceback__)
            raise
        safely(status.finish, self)
        return result

    Scene.render = render

    orig_play = CairoRenderer.play

    def play(self, scene, *args, **kwargs):
        current["scene"] = scene
        return orig_play(self, scene, *args, **kwargs)

    CairoRenderer.play = play

    orig_add = SceneFileWriter.add_partial_movie_file

    def add_partial_movie_file(self, hash_animation):
        orig_add(self, hash_animation)

        def record():
            scene = current["scene"]
            animations = list(getattr(scene, "animations", None) or [])
            label = describe(animations[0]) if animations else "Animation"
            if len(animations) > 1:
                label += f" +{len(animations) - 1}"
            status.sync(self, label, getattr(scene, "duration", None))

        safely(record)

    SceneFileWriter.add_partial_movie_file = add_partial_movie_file

    orig_next = SceneFileWriter.next_section

    def next_section(self, *args, **kwargs):
        orig_next(self, *args, **kwargs)
        safely(status.sync, self)

    SceneFileWriter.next_section = next_section

    console = commands.error_console
    orig_print_exception = console.print_exception

    def print_exception(*args, **kwargs):
        exc_type, exc, tb = sys.exc_info()
        safely(status.fail, exc, tb, isinstance(exc, KeyboardInterrupt))
        return orig_print_exception(*args, **kwargs)

    console.print_exception = print_exception


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        return 0 if len(argv) >= 2 else 2
    command = with_manim_args(argv[1:])
    status = Status(command)
    code = 0
    try:
        install_hooks(status)
    except Exception as exc:  # a Manim this wrapper does not know: render plainly
        print(f"render.py: progress hooks unavailable ({exc}); rendering without them", file=sys.stderr)
    from manim.__main__ import main as manim_main

    try:
        manim_main(args=command, prog_name="manim", standalone_mode=True)
    except SystemExit as exit_:
        code = exit_.code if isinstance(exit_.code, int) else (0 if exit_.code is None else 1)
    except KeyboardInterrupt:
        status.fail(None, None, cancelled=True)
        code = 130
    except BaseException as exc:
        status.fail(exc, exc.__traceback__)
        traceback.print_exc()
        code = 1
    if code != 0:
        status.fail(None, None)
    elif status.scenes_begun == 0:
        status.data = {"spec": 1, "state": "done", "pid": os.getpid(), "command": " ".join(["manim", *command]), "startedAtMs": status.started, "finishedAtMs": now_ms(), "animation": 0, "clips": [], "sections": [], "note": "no scene rendered"}
        status.write(force=True)
    sys.stdout.flush()
    verdict = subprocess.run([sys.executable, str(HERE / "verdict.py")], cwd=str(WS), env={**os.environ, "HARNESS_WORKSPACE": str(WS)})
    return code if code != 0 else verdict.returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
