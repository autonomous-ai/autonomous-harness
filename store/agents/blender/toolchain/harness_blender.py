"""The few lines every Blender script here needs: a clean scene, a camera that frames what you built,
a light, a glTF export the pane shows, a headless render (still and turntable), and a report for the
verdict.

    from harness_blender import fresh, frame_all, export_glb, render, turntable, report
    fresh()
    ... build with bpy ...
    frame_all(); export_glb("out/model.glb")      # the pane reloads the 3D scene now
    render("out/preview.png"); turntable("out/turntable.mp4", seconds=4); report()

While a script runs, the helper keeps `.harness/build.json` current — which step it is on, how far
the turntable has got, what it exported, whether it failed — so the 3D pane says "rebuilding" instead
of showing a stale model as if it were the answer.
"""
from __future__ import annotations
import atexit, json, math, os, shutil, subprocess, sys, time, traceback
from pathlib import Path

import bpy
from mathutils import Vector

_t0 = time.time()
_WS = Path(os.environ.get("HARNESS_WORKSPACE") or os.getcwd()).resolve()
_exported: list[str] = []


# ---------------------------------------------------------------------------------------------------
# The build feed: .harness/build.json, for the pane. Best effort — a feed that cannot be written never
# fails the script that is building.

_feed: dict = {}
_feed_written = 0.0


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(_WS).as_posix()
    except ValueError:
        return str(path)


def _activity(step: str | None = None, state: str = "building", progress: float | None = None, force: bool = True, **extra) -> None:
    """Record what the script is doing. `force=False` throttles (per-frame progress)."""
    global _feed_written
    harness = _WS / ".harness"
    if not harness.is_dir():
        return
    if not _feed:
        script = Path(sys.argv[0]) if sys.argv and sys.argv[0] else None
        _feed.update({"state": "building", "step": "Starting", "progress": None,
                      "script": _rel(script) if script and script.suffix == ".py" else None,
                      "pid": os.getpid(), "startedAt": _now(), "exported": None, "error": None})
    _feed["state"] = state
    if step is not None:
        _feed["step"] = step
    _feed["progress"] = None if progress is None else round(max(0.0, min(1.0, progress)), 3)
    _feed.update(extra)
    now = time.time()
    if not force and now - _feed_written < 0.25:
        return
    _feed_written = now
    _feed["updatedAt"] = _now()
    try:
        tmp = harness / ".build.json.tmp"
        tmp.write_text(json.dumps(_feed, indent=2) + "\n")
        os.replace(tmp, harness / "build.json")
    except OSError:
        pass


_prior_excepthook = sys.excepthook


def _excepthook(kind, value, tb):
    last = "".join(traceback.format_exception_only(kind, value)).strip().splitlines()
    message = last[-1] if last else kind.__name__
    _activity(state="failed", step=_feed.get("step") or "Failed", error=message if len(message) <= 200 else message[:199] + "…")
    _prior_excepthook(kind, value, tb)


def _finish() -> None:
    if _feed and _feed.get("state") == "building":
        _activity(state="done", step="Done")


sys.excepthook = _excepthook
atexit.register(_finish)
_activity("Running")


# ---------------------------------------------------------------------------------------------------
# The scene

def fresh(units: str = "METRIC", scale: float = 0.001) -> None:
    """An empty scene in millimetres (scale 0.001: 1 Blender unit = 1 mm)."""
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
    _activity("Modelling")


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


def _mm() -> float:
    """Millimetres per Blender unit: scale_length is metres per unit (0.001 → 1 unit = 1 mm)."""
    return bpy.context.scene.unit_settings.scale_length * 1000


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
    cam.data.clip_start = max(dist / 1000, 1e-3)
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


# ---------------------------------------------------------------------------------------------------
# Renders

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
    label = {"CYCLES": "Cycles", "BLENDER_EEVEE_NEXT": "Eevee", "BLENDER_EEVEE": "Eevee"}.get(s.render.engine, "Workbench")
    _activity(f"Rendering {Path(path).name} ({label})")
    s.render.resolution_x, s.render.resolution_y = size
    s.render.resolution_percentage = 100
    s.render.image_settings.file_format = "PNG"
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    s.render.filepath = str(out)
    bpy.ops.render.render(write_still=True)
    return out


def turntable(path: str | Path = "out/turntable.mp4", seconds: float = 4.0, fps: int = 30, size: tuple[int, int] = (1280, 720)) -> Path:
    """The camera orbits the model once; an mp4. Workbench, so seconds not minutes. The scene is left
    as it was found: the orbit pivot, its keys and the frame range are removed again, so a glTF
    exported afterwards carries the camera where frame_all put it, not a spinning rig."""
    s = bpy.context.scene
    cam = frame_all() if s.camera is None else s.camera
    lo, hi = bounds()
    centre = (lo + hi) / 2
    saved = dict(parent=cam.parent, matrix=cam.matrix_world.copy(), start=s.frame_start, end=s.frame_end, fps=s.render.fps,
                 current=s.frame_current, interp=bpy.context.preferences.edit.keyframe_new_interpolation_type)
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

    def progress(scene, *_):
        _activity(f"Rendering turntable {scene.frame_current}/{frames}", progress=scene.frame_current / frames, force=False)

    _activity(f"Rendering turntable 0/{frames}", progress=0.0)
    bpy.app.handlers.render_write.append(progress)
    try:
        bpy.ops.render.render(animation=True)
    finally:
        bpy.app.handlers.render_write.remove(progress)
        # Put the scene back: camera unparented at its world pose, the pivot and its action gone.
        cam.parent = saved["parent"]
        cam.matrix_world = saved["matrix"]
        action = pivot.animation_data.action if pivot.animation_data else None
        bpy.data.objects.remove(pivot, do_unlink=True)
        if action is not None and action.users == 0:
            bpy.data.actions.remove(action)
        s.frame_start, s.frame_end, s.render.fps = saved["start"], saved["end"], saved["fps"]
        s.frame_set(saved["current"])
        bpy.context.preferences.edit.keyframe_new_interpolation_type = saved["interp"]
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        print(f"warn no ffmpeg on PATH — turntable frames are in {frames_dir}; brew install ffmpeg to get an mp4")
        return out
    _activity("Encoding turntable")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(frames_dir / "frame_%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], check=True)
    shutil.rmtree(frames_dir, ignore_errors=True)
    return out


# ---------------------------------------------------------------------------------------------------
# Exports

def _r(v: float, n: int = 3) -> float:
    return round(float(v), n)


def _object_facts(o: bpy.types.Object, depsgraph) -> dict:
    """What the pane's properties panel shows for one object, in Blender's own terms and mm."""
    mm = _mm()
    facts: dict = {
        "type": o.type,
        "collections": [c.name for c in o.users_collection],
        "location_mm": [_r(v * mm) for v in o.location],
        "rotation_deg": [_r(math.degrees(v)) for v in o.rotation_euler],
        "rotation_mode": o.rotation_mode,
        "scale": [_r(v, 4) for v in o.scale],
        "dimensions_mm": [_r(v * mm) for v in o.dimensions],
    }
    if o.parent is not None:
        facts["parent"] = o.parent.name
    if o.type == "MESH":
        m = o.evaluated_get(depsgraph).data
        facts.update(vertices=len(m.vertices), edges=len(m.edges), faces=len(m.polygons),
                     triangles=sum(len(p.vertices) - 2 for p in m.polygons), mesh=o.data.name)
        facts["materials"] = [s.material.name for s in o.material_slots if s.material]
        mods = [{"name": md.name, "type": md.type} for md in o.modifiers if md.show_render]
        if mods:
            facts["modifiers"] = mods
    elif o.type == "LIGHT":
        light = o.data
        facts["light"] = {"type": light.type, "energy_w": _r(light.energy), "color": [_r(c) for c in light.color]}
    elif o.type == "CAMERA":
        cam = o.data
        facts["camera"] = {"type": cam.type, "lens_mm": _r(cam.lens), "sensor_mm": _r(cam.sensor_width), "scene_camera": bpy.context.scene.camera == o}
    return facts


def _stamp() -> list[tuple]:
    """Custom properties under "harness" on the scene, its collections and its objects, which the
    glTF exporter writes as `extras`. Returned so `_unstamp` can put back what was there before."""
    s = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    lo, hi = bounds()
    targets: list[tuple] = []

    def put(idblock, value: dict) -> None:
        targets.append((idblock, idblock.get("harness")))
        idblock["harness"] = value

    put(s, {
        "units": s.unit_settings.length_unit.lower() if s.unit_settings.system != "NONE" else "unit",
        "metres_per_unit": round(s.unit_settings.scale_length, 9),
        "size_mm": [_r((hi - lo)[i] * _mm(), 2) for i in range(3)],
        "fps": s.render.fps, "frame_start": s.frame_start, "frame_end": s.frame_end,
        "resolution": [s.render.resolution_x, s.render.resolution_y],
        "camera": s.camera.name if s.camera else "",
        "blender": bpy.app.version_string, "exported_at": _now(),
        # The exporter drops material custom properties, so what Solid shading needs rides here.
        "materials": {m.name: {"viewport_color": [_r(c) for c in m.diffuse_color], "metallic": _r(m.metallic), "roughness": _r(m.roughness)}
                      for m in bpy.data.materials if m.users},
    })
    for c in bpy.data.collections:
        if c.users:
            put(c, {"type": "COLLECTION"})
    put(s.collection, {"type": "COLLECTION"})
    for o in s.objects:
        put(o, _object_facts(o, depsgraph))
    return targets


def _unstamp(targets: list[tuple]) -> None:
    for idblock, before in targets:
        try:
            if before is None:
                del idblock["harness"]
            else:
                idblock["harness"] = before
        except (KeyError, ReferenceError):
            pass


def export_glb(path: str | Path = "out/model.glb", cameras: bool = True, lights: bool = True, collections: bool = True) -> Path:
    """The deliverable and what the pane shows: every renderable object under its Blender name, the
    collections as the hierarchy, modifiers applied, materials, the scene camera and lights, any
    animation, and per-object facts (dimensions in mm, vertex and face counts, modifiers) as extras.

    Written to a hidden file and renamed into place, so the pane never reads half a file. Export
    early — right after the blocky version — and again after each refinement: every export is a
    live update of the 3D pane."""
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    _activity(f"Exporting {out.name}")
    gltf = out.suffix.lower() == ".gltf"
    tmp = out.with_name(f".{out.stem}.partial{out.suffix}")
    targets = _stamp()
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(tmp), export_format="GLTF_EMBEDDED" if gltf else "GLB",
            use_selection=False, use_renderable=True, export_apply=True, export_yup=True,
            export_extras=True, export_cameras=cameras, export_lights=lights,
            export_hierarchy_full_collections=collections, export_animations=True)
    finally:
        _unstamp(targets)
    os.replace(tmp, out)
    rel = _rel(out)
    if rel not in _exported:
        _exported.append(rel)
    _activity(f"Exported {out.name}", exported=rel)
    return out


def export_stl(path: str | Path = "out/model.stl") -> Path:
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    _activity(f"Exporting {out.name}")
    bpy.ops.wm.stl_export(filepath=str(out), export_selected_objects=False, apply_modifiers=True)
    return out


def report(path: str | Path = "out/report.json") -> dict:
    """What was built — the verdict reads it, and the pane uses its size to check the glTF's units."""
    s = bpy.context.scene
    lo, hi = bounds()
    objs = meshes()
    verts = faces = 0
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        m = o.evaluated_get(depsgraph).data
        verts += len(m.vertices)
        faces += len(m.polygons)
    out = Path(path).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    glb = _exported[-1] if _exported else "out/model.glb"
    files = {"preview": "out/preview.png", "turntable": "out/turntable.mp4", "glb": glb}
    data = {
        "objects": [o.name for o in objs], "vertices": verts, "faces": faces,
        # scale_length is metres per Blender unit (0.001 → 1 unit = 1 mm); mm = units × scale × 1000.
        "size_mm": [round((hi - lo)[i] * s.unit_settings.scale_length * 1000, 2) for i in range(3)],
        "materials": sorted({m.name for o in objs for m in o.data.materials if m}),
        "collections": sorted({c.name for o in objs for c in o.users_collection if c != s.collection}),
        "cameras": [o.name for o in s.objects if o.type == "CAMERA"],
        "lights": [o.name for o in s.objects if o.type == "LIGHT"],
        "files": {k: v for k, v in files.items() if (_WS / v).exists() or Path(v).exists()},
        "wall_seconds": round(time.time() - _t0, 1), "blender": bpy.app.version_string,
    }
    out.write_text(json.dumps(data, indent=2) + "\n")
    _activity("Report written")
    print(f"{len(objs)} object{'s' if len(objs) != 1 else ''} · {verts} verts · {faces} faces · {data['size_mm']} mm · {data['wall_seconds']} s")
    return data
