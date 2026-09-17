"""The starter: a mug — a bevelled cylinder, hollowed, with a torus handle and a material — exported
as glTF, previewed and turned. Replace it."""
import math
import bpy
from harness_blender import export_glb, frame_all, fresh, render, report, turntable

fresh()
# body: a cylinder 90 mm across, 100 mm tall, hollowed with a boolean, edges bevelled
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=45, depth=100, location=(0, 0, 50))
body = bpy.context.active_object
body.name = "Mug"
bpy.ops.mesh.primitive_cylinder_add(vertices=96, radius=41, depth=100, location=(0, 0, 54))
hole = bpy.context.active_object
cut = body.modifiers.new("Hollow", "BOOLEAN")
cut.operation = "DIFFERENCE"
cut.object = hole
hole.hide_render = hole.hide_viewport = True
bevel = body.modifiers.new("Bevel", "BEVEL")
bevel.width = 2
bevel.segments = 4
# handle: a torus, half sunk into the wall
bpy.ops.mesh.primitive_torus_add(major_radius=22, minor_radius=6, major_segments=64, minor_segments=24, location=(52, 0, 50), rotation=(math.pi / 2, 0, 0))
handle = bpy.context.active_object
handle.name = "Handle"
# one material, a warm ceramic
mat = bpy.data.materials.new("Ceramic")
mat.use_nodes = True
mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.86, 0.58, 0.32, 1)
mat.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.35
mat.diffuse_color = (0.86, 0.58, 0.32, 1)
for o in (body, handle):
    o.data.materials.append(mat)

frame_all()
render("out/preview.png")
turntable("out/turntable.mp4", seconds=4)
export_glb("out/model.glb")
report()
