"""Scripted Blender preview of independently verified CAD, not a live Blender agent.

Usage: installed-blender-python this-script.py exported-mesh-directory output-directory
"""
import sys
from pathlib import Path
import bpy
from mathutils import Vector

meshes, output = map(Path, sys.argv[1:3])
output.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)
parts = []
for name, color in [("holder", (0.10, 0.13, 0.16, 1)), ("token", (0.84, 0.18, 0.09, 1))]:
    bpy.ops.wm.stl_import(filepath=str(meshes / f"{name}.stl"))
    part = bpy.context.object
    part.name = name
    part.scale = (0.001,) * 3  # STL source units are explicitly millimeters.
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Roughness"].default_value = 0.32
    part.data.materials.append(material)
    parts.append(part)

# Only the actual parts go into the portable model; lighting is presentation-only.
bpy.ops.object.select_all(action="DESELECT")
for part in parts:
    part.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(output / "assembly.glb"), export_format="GLB", use_selection=True)

bpy.ops.mesh.primitive_plane_add(size=0.4, location=(0, 0, -0.00002))
floor = bpy.context.object
mat = bpy.data.materials.new("warm matte floor")
mat.diffuse_color = (0.34, 0.30, 0.26, 1)
floor.data.materials.append(mat)

bpy.ops.object.camera_add(location=(0.046, -0.058, 0.062))
camera = bpy.context.object
camera.rotation_euler = (Vector((0, 0, 0.003)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type = "ORTHO"
camera.data.ortho_scale = 0.055
camera.data.clip_start = 0.0001
camera.data.clip_end = 10
bpy.context.scene.camera = camera
for position, energy, size in [((0.025, -0.025, 0.075), 0.12, 0.045), ((-0.04, -0.005, 0.045), 0.06, 0.05), ((0.02, 0.04, 0.06), 0.16, 0.03)]:
    bpy.ops.object.light_add(type="AREA", location=position)
    light = bpy.context.object
    light.data.energy, light.data.shape, light.data.size = energy, "DISK", size
    light.rotation_euler = (-light.location).to_track_quat("-Z", "Y").to_euler()

scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 16
scene.cycles.max_bounces = 4
scene.cycles.use_denoising = True
scene.world.color = (0.15, 0.15, 0.15)
scene.render.resolution_x, scene.render.resolution_y = 1024, 768
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(output / "preview.png")
bpy.ops.render.render(write_still=True)
