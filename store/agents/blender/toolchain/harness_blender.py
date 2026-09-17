"""The few lines every Blender script here needs: a clean scene, a camera that frames what you built,
a light, a headless render (still and turntable), a glTF export, and a report for the verdict.

    from harness_blender import fresh, frame_all, render, turntable, export_glb, report
    fresh()
    ... build with bpy ...
    frame_all(); render("out/preview.png"); turntable("out/turntable.mp4", seconds=4)
    export_glb("out/model.glb"); report()
"""
from __future__ import annotations
import json, math, os, shutil, subprocess, time
from pathlib import Path

import bpy
from mathutils import Vector

_t0 = time.time()


def fresh(units: str = "METRIC", scale: float = 0.001) -> None:
    """An empty scene in millimetres (scale 0.001: 1 Blender unit = 1 m, 1 mm = 0.001)."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.unit_settings.system = units
    s.unit_settings.scale_length = scale
    s.unit_settings.length_unit = "MILLIMETERS"
    s.render.engine = "BLENDER_WORKBENCH"
    s.display.shading.light = "MATCAP"
    s.display.shading.color_type = "MATERIAL"
    s.render.film_transparent = False
    world = bpy.data.worlds.new("World")
    s.world = world
    world.color = (0.05, 0.05, 0.06)


def meshes() -> list[bpy.types.Object]:
    """The meshes that render — a boolean cutter hidden from render is not part of the model."""
    return [o for o in bpy.context.scene.objects if o.type == "MESH" and not o.hide_render]


def bounds() -> tuple[Vector, Vector]:
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for o in meshes():
        for corner in o.bound_box:
            p = o.matrix_world @ Vector(corner)
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
    if not math.isfinite(lo.x):
        return Vector((0, 0, 0)), Vector((0, 0, 0))
    return lo, hi


def frame_all(azimuth: float = 35.0, elevation: float = 25.0, margin: float = 1.15) -> bpy.types.Object:
    """A camera and a key light framing everything built so far."""
    s = bpy.context.scene
    lo, hi = bounds()
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 1e-6) * margin
    cam = s.camera
    if cam is None:
        cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
        s.collection.objects.link(cam)
        s.camera = cam
    cam.data.lens = 50
    # Fit the bounding sphere in the NARROW direction of the frame: `angle` is the horizontal field
    # of view (already in radians), and a 16:9 frame is shorter than it is wide, so a tall model
    # needs the vertical one.
    res = bpy.context.scene.render
    aspect = min(1.0, res.resolution_y / max(res.resolution_x, 1))
    half = math.atan(math.tan(cam.data.angle / 2) * aspect)
    dist = radius / math.tan(half)
    az, el = math.radians(azimuth), math.radians(elevation)
    cam.location = centre + Vector((dist * math.cos(el) * math.cos(az), dist * math.cos(el) * math.sin(az), dist * math.sin(el)))
    _look_at(cam, centre)
    cam.data.clip_end = dist * 10
    if not any(o.type == "LIGHT" for o in s.objects):
        light = bpy.data.objects.new("Key", bpy.data.lights.new("Key", "SUN"))
        light.data.energy = 3
        s.collection.objects.link(light)
        light.rotation_euler = (math.radians(50), 0, math.radians(30))
    return cam


def _look_at(obj: bpy.types.Object, target: Vector) -> None:
    direction = target - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render(path: str | Path = "out/preview.png", size: tuple[int, int] = (1280, 720), engine: str | None = None, samples: int = 32) -> Path:
    """A still. Workbench by default (seconds); engine="CYCLES" for a beauty shot (CPU, samples)."""
    s = bpy.context.scene
    if s.camera is None:
        frame_all()
    if engine:
        s.render.engine = engine
        if engine == "CYCLES":
            s.cycles.samples = samples
            s.cycles.device = "CPU"
    s.render.resolution_x, s.render.resolution_y = size
    s.render.resolution_percentage = 100
    s.render.image_settings.file_format = "PNG"
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    s.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)
    return out


def turntable(path: str | Path = "out/turntable.mp4", seconds: float = 4.0, fps: int = 30, size: tuple[int, int] = (1280, 720)) -> Path:
    """The camera orbits the model once; an mp4 the pane plays. Workbench, so seconds not minutes."""
    s = bpy.context.scene
    cam = frame_all() if s.camera is None else s.camera
    lo, hi = bounds()
    centre = (lo + hi) / 2
    pivot = bpy.data.objects.new("Pivot", None)
    s.collection.objects.link(pivot)
    pivot.location = centre
    # matrix_world is stale until the scene evaluates; parenting against the stale identity would
    # shift the camera by the centre and the model would drift out of frame as the pivot turns.
    bpy.context.view_layer.update()
    cam.parent = pivot
    cam.matrix_parent_inverse = pivot.matrix_world.inverted()
    frames = int(seconds * fps)
    s.frame_start, s.frame_end = 1, frames
    s.render.fps = fps
    # Linear keys, set through the preference new keys are born with: Blender 5's layered actions
    # no longer expose `action.fcurves`, and this works on 4.x and 5.x alike.
    bpy.context.preferences.edit.keyframe_new_interpolation_type = "LINEAR"
    pivot.rotation_euler = (0, 0, 0)
    pivot.keyframe_insert("rotation_euler", frame=1)
    pivot.rotation_euler = (0, 0, math.tau)
    pivot.keyframe_insert("rotation_euler", frame=frames + 1)
    s.render.resolution_x, s.render.resolution_y = size
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    # The bpy wheel is built without a movie encoder, so the turntable is PNG frames that the
    # machine's ffmpeg joins. No ffmpeg: the frames stay, and the still is what the pane shows.
    frames_dir = out.parent / (out.stem + "-frames")
    frames_dir.mkdir(exist_ok=True)
    for old in frames_dir.glob("*.png"):
        old.unlink()
    s.render.image_settings.file_format = "PNG"
    s.render.filepath = str(frames_dir / "frame_")
    bpy.ops.render.render(animation=True)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        print(f"warn no ffmpeg on PATH — turntable frames are in {frames_dir}; brew install ffmpeg to get an mp4")
        return out
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(frames_dir / "frame_%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], check=True)
    shutil.rmtree(frames_dir, ignore_errors=True)
    return out


def export_glb(path: str | Path = "out/model.glb") -> Path:
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB", use_selection=False, export_apply=True)
    return out


def export_stl(path: str | Path = "out/model.stl") -> Path:
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.stl_export(filepath=str(out), export_selected_objects=False, apply_modifiers=True)
    return out


def report(path: str | Path = "out/report.json") -> dict:
    """What was built — the verdict reads it."""
    lo, hi = bounds()
    objs = meshes()
    verts = faces = 0
    for o in objs:
        m = o.evaluated_get(bpy.context.evaluated_depsgraph_get()).data
        verts += len(m.vertices)
        faces += len(m.polygons)
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "objects": [o.name for o in objs], "vertices": verts, "faces": faces,
        # scale_length is metres per Blender unit (0.001 → 1 unit = 1 mm); mm = units × scale × 1000.
        "size_mm": [round((hi - lo)[i] * bpy.context.scene.unit_settings.scale_length * 1000, 2) for i in range(3)],
        "materials": sorted({m.name for o in objs for m in o.data.materials if m}),
        "files": {k: str(Path(v)) for k, v in {"preview": "out/preview.png", "turntable": "out/turntable.mp4", "glb": "out/model.glb"}.items() if Path(v).exists()},
        "wall_seconds": round(time.time() - _t0, 1), "blender": bpy.app.version_string,
    }
    out.write_text(json.dumps(data, indent=2) + "\n")
    print(f"{len(objs)} object{'s' if len(objs) != 1 else ''} · {verts} verts · {faces} faces · {data['size_mm']} mm · {data['wall_seconds']} s")
    return data
