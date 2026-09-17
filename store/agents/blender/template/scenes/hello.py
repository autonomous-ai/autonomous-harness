"""The starter: a mug — an open cylinder given a 4 mm wall with Solidify, rim bevelled, a torus
handle, a ceramic material — exported as glTF (the pane shows it the moment it lands), previewed and
turned. Replace it."""
import math
import bpy
import bmesh
from harness_blender import export_glb, frame_all, fresh, render, report, turntable

fresh()
# body: a cylinder 90 mm across and 100 mm tall with its top face removed, then a 4 mm wall inward
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=45, depth=100, location=(0, 0, 50))
body = bpy.context.active_object
body.name = "Mug"
bm = bmesh.new()
bm.from_mesh(body.data)
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.normal.z > 0.9], context="FACES")
bm.to_mesh(body.data)
bm.free()
wall = body.modifiers.new("Wall", "SOLIDIFY")
wall.thickness = 4
wall.offset = -1
wall.use_even_offset = True
bevel = body.modifiers.new("Bevel", "BEVEL")
bevel.width = 1.2
bevel.segments = 3
bevel.limit_method = "ANGLE"
bpy.ops.object.shade_smooth_by_angle(angle=math.radians(40))
# handle: a torus, half sunk into the wall
bpy.ops.mesh.primitive_torus_add(major_radius=22, minor_radius=6, major_segments=64, minor_segments=24, location=(52, 0, 50), rotation=(math.pi / 2, 0, 0))
handle = bpy.context.active_object
handle.name = "Handle"
bpy.ops.object.shade_smooth()
# one material, a warm ceramic
mat = bpy.data.materials.new("Ceramic")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.86, 0.58, 0.32, 1)
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35
mat.diffuse_color = (0.86, 0.58, 0.32, 1)
for o in (body, handle):
    o.data.materials.append(mat)

frame_all()
export_glb("out/model.glb")                # first: the 3D pane updates in a second
render("out/preview.png")
turntable("out/turntable.mp4", seconds=4)
report()
