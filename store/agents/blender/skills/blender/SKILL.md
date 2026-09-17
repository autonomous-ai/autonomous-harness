---
name: blender
description: Model objects and scenes with Blender's Python (bpy) headless — primitives, modifiers, materials, collections, cameras, lights, animation — export glTF the 3D pane shows live, render stills and turntables, export STL. Use for any request that ends in a 3D model, a rendered shot or a glTF.
---

# blender

Blender runs here as a Python module (`bpy`, pinned): everything Blender does, no window. Scripts
live in `scenes/`, run with `$BLENDER_PYTHON`, and `harness_blender` (on `PYTHONPATH`) gives you the
scene, the camera, the export, the renders and the report in one import.

## Build, export, render, verdict

```bash
"$BLENDER_PYTHON" scenes/hello.py                        # builds → out/model.glb, out/preview.png, out/turntable.mp4, out/report.json
"$BLENDER_PYTHON" "$BLENDER_TOOLCHAIN/verdict.py"        # judges out/ → the pane header, and which glTF the pane opens
```

```python
import bpy
from harness_blender import fresh, frame_all, export_glb, render, turntable, export_stl, report
fresh()                                    # empty scene, millimetres, Workbench matcap
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=45, depth=100, location=(0, 0, 50))
body = bpy.context.active_object
body.name = "Mug"                          # the name the pane's outliner shows
frame_all()                                # camera + key light framing everything
export_glb("out/model.glb")                # FIRST: the 3D pane reloads now, in place
render("out/preview.png")                  # a still, seconds (engine="CYCLES", samples=64 for a beauty shot)
turntable("out/turntable.mp4", seconds=4)  # the pane's Turntable tab; the scene is left as it was
report()                                   # what the verdict reads
```

## What the pane shows, and how to feed it

The pane is a 3D viewport of the glTF, not a video player. `export_glb` carries everything it needs:

- **Names and hierarchy**: every renderable object under its Blender name, collections as the
  outliner's tree, parenting kept. Name objects, collections and materials for what they are.
- **Facts per object** (as glTF `extras`): dimensions and location in mm, rotation, scale, vertex /
  face / triangle counts, modifiers, materials, collections. Your own custom properties
  (`obj["part_no"] = "A-12"`) appear in the properties panel too.
- **Materials**: Principled BSDF base colour, metallic, roughness, textures; `diffuse_color` is what
  Solid shading uses — set it to match.
- **The scene camera and lights** (KHR_lights_punctual): the user can look through the camera
  (numpad 0) and switch the lights on in Material / Rendered shading.
- **Animation**: keyframed objects play on the pane's timeline (`obj.keyframe_insert(...)`,
  `scene.frame_end`, `scene.render.fps`).
- **Units**: the scene's unit scale travels with the export, so millimetres read as millimetres.

While a script runs, the helper writes `.harness/build.json` (step, turntable progress, failure) and
the pane shows "Rebuilding · …" over the last good model. Exports are written to a hidden file and
renamed into place, so the pane never reads half a file. Export after every meaningful change.

## Modelling, the parts that matter

- **Primitives**: `primitive_cube_add(size)`, `primitive_cylinder_add(vertices, radius, depth)`,
  `primitive_uv_sphere_add(radius)`, `primitive_torus_add(major_radius, minor_radius)`,
  `primitive_plane_add`. Each becomes `bpy.context.active_object`; name it.
- **Collections**: `c = bpy.data.collections.new("Lamp"); bpy.context.scene.collection.children.link(c)`,
  then move an object: `for u in list(o.users_collection): u.objects.unlink(o)` and `c.objects.link(o)`.
- **Modifiers** (non-destructive, applied on export): `o.modifiers.new("Bevel", "BEVEL")` (width,
  segments, `limit_method="ANGLE"`), `"SUBSURF"` (levels), `"BOOLEAN"` (operation DIFFERENCE/UNION,
  object — hide the cutter with `hide_render = True`), `"ARRAY"`, `"MIRROR"`, `"SOLIDIFY"`
  (thickness — a clean way to give an open shape a wall), `"SCREW"`, `"DISPLACE"`.
- **Smooth shading**: `bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))` on curved parts.
- **Edit-mode ops** when a modifier will not do: `bmesh` for exact geometry
  (`bmesh.ops.extrude_face_region`, `inset`, `bevel`, `delete`), then back to the mesh.
- **Curves and text**: `bpy.data.curves.new(type="FONT")` + `body` for lettering, `extrude` for depth.
- **Materials**: `bpy.data.materials.new`, `use_nodes = True`, Principled BSDF inputs `Base Color`,
  `Roughness`, `Metallic`; set `diffuse_color` too so Workbench and the pane's Solid mode show it.
- **Units**: `fresh()` puts the scene in millimetres. Model at real size; the report says the size.
- **Cameras**: `frame_all(azimuth, elevation)` for the shot; `render(engine="CYCLES")` for light,
  shadow and glass (CPU: 64 samples at 1280×720 is under a minute for a small scene).
- **Animation**: `obj.keyframe_insert("location", frame=n)`; `scene.frame_end`; it exports and plays
  on the pane's timeline.
- **Geometry Nodes** exist (`modifiers.new(type="NODES")`) but hand-built node trees are long; prefer
  modifiers and bmesh unless the request is procedural by nature.

## Rules

- Never write inside the package; `out/` holds everything produced, `scenes/` the scripts.
- First a blocky version (primitives, no bevels), **export it**, then render; then refine and export
  again. The live 3D scene is the proof; the turntable is the deliverable.
- Deliver `out/model.glb` (and `.stl` when it is for printing); say the size in mm.
