---
name: blender
description: Model objects and scenes with Blender's Python (bpy) headless — primitives, modifiers, materials, cameras, lights — render stills and turntables, export glTF/STL, and keep the pane showing the latest render. Use for any request that ends in a 3D model, a rendered shot or a glTF.
---

# blender

Blender runs here as a Python module (`bpy`, pinned): everything Blender does, no window. Scripts
live in `scenes/`, run with `$BLENDER_PYTHON`, and `harness_blender` (on `PYTHONPATH`) gives you the
scene, the camera, the renders, the export and the report in one import.

## Build, render, verdict

```bash
"$BLENDER_PYTHON" scenes/hello.py                        # builds → out/preview.png, out/turntable.mp4, out/model.glb, out/report.json
"$BLENDER_PYTHON" "$BLENDER_TOOLCHAIN/verdict.py"        # judges out/ → the pane header
```

```python
import bpy
from harness_blender import fresh, frame_all, render, turntable, export_glb, export_stl, report
fresh()                                    # empty scene, millimetres, Workbench matcap
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=45, depth=100, location=(0, 0, 50))
body = bpy.context.active_object
frame_all()                                # camera + key light framing everything
render("out/preview.png")                  # a still, seconds (engine="CYCLES", samples=64 for a beauty shot)
turntable("out/turntable.mp4", seconds=4)  # the pane plays this
export_glb("out/model.glb"); report()      # the deliverable, and what the verdict reads
```

## Modelling, the parts that matter

- **Primitives**: `primitive_cube_add(size)`, `primitive_cylinder_add(vertices, radius, depth)`,
  `primitive_uv_sphere_add(radius)`, `primitive_torus_add(major_radius, minor_radius)`,
  `primitive_plane_add`. Each becomes `bpy.context.active_object`; name it.
- **Modifiers** (non-destructive, applied on export): `o.modifiers.new("Bevel", "BEVEL")` (width,
  segments), `"SUBSURF"` (levels), `"BOOLEAN"` (operation DIFFERENCE/UNION, object), `"ARRAY"`
  (count, relative_offset_displace), `"MIRROR"`, `"SOLIDIFY"` (thickness), `"SCREW"`, `"DISPLACE"`.
- **Edit-mode ops** when a modifier will not do: `bpy.ops.object.mode_set(mode="EDIT")`, `bmesh`
  for exact geometry (`bmesh.ops.extrude_face_region`, `inset`, `bevel`), then back to OBJECT.
- **Curves and text**: `bpy.data.curves.new(type="FONT")` + `body` for lettering, `extrude` for depth.
- **Materials**: `bpy.data.materials.new`, `use_nodes = True`, Principled BSDF inputs `Base Color`,
  `Roughness`, `Metallic`; set `diffuse_color` too so Workbench shows it.
- **Units**: `fresh()` puts the scene in millimetres. Model at real size; the report says the size.
- **Cameras**: `frame_all(azimuth, elevation)` for the shot; `render(engine="CYCLES")` for light,
  shadow and glass (CPU: 64 samples at 1280×720 is under a minute for a small scene).
- **Animation**: `obj.keyframe_insert("location", frame=n)`; `scene.frame_end`; the turntable helper
  is one example.
- **Geometry Nodes** exist (`modifiers.new(type="NODES")`) but hand-built node trees are long; prefer
  modifiers and bmesh unless the request is procedural by nature.

## Rules

- Never write inside the package; `out/` holds everything produced, `scenes/` the scripts.
- First a blocky version (primitives, no bevels), render, then refine. The turntable is the proof.
- Deliver `out/model.glb` (and `.stl` when it is for printing); say the size in mm.
