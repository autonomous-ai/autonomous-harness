"""Original Store artwork, rendered with the Blender harness's bpy runtime.

python render.py --output ../../assets/store [--pcb-glb /path/to/board.glb]
The PCB input is Copper's MIT-licensed terminal-keyboard example. See the
asset README for provenance. No network access or third-party assets for 3D.
"""
import argparse
import math
from pathlib import Path

import bpy
from mathutils import Vector


def material(name, color, metal=0, roughness=.32):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Metallic'].default_value = metal
    bsdf.inputs['Roughness'].default_value = roughness
    return mat


def finish(obj, mat, bevel=0):
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Soft edges', 'BEVEL')
        mod.width = bevel
        mod.segments = 4
        obj.modifiers.new('Normals', 'WEIGHTED_NORMAL')
    return obj


def box(name, loc, scale, mat, bevel=.08):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, mat, bevel)


def cylinder(name, loc, radius, depth, mat):
    bpy.ops.mesh.primitive_cylinder_add(vertices=128, radius=radius, depth=depth, location=loc)
    obj = bpy.context.object
    obj.name = name
    finish(obj, mat, .07)
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def point(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def setup(background, target, camera, scale, width, height):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    s = bpy.context.scene
    s.render.engine = 'CYCLES'
    s.cycles.samples = 32
    s.cycles.use_denoising = True
    s.render.resolution_x = width
    s.render.resolution_y = height
    s.render.resolution_percentage = 100
    s.render.image_settings.file_format = 'PNG'
    s.world = bpy.data.worlds.new('Studio')
    s.world.use_nodes = True
    s.world.node_tree.nodes['Background'].inputs['Color'].default_value = (*background, 1)
    s.world.node_tree.nodes['Background'].inputs['Strength'].default_value = .4
    s.view_settings.view_transform = 'AgX'
    bpy.ops.object.camera_add(location=camera)
    cam = bpy.context.object
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = scale
    point(cam, target)
    s.camera = cam
    for name, pos, power, size, color in [
        ('Softbox', (0, -5, 11), 2100, 8, (1, .91, .78)),
        ('Mint rim', (6, 4, 8), 2500, 6, (.53, 1, .83)),
        ('Fill', (-5, -2, 5), 1100, 5, (.65, .82, 1)),
    ]:
        data = bpy.data.lights.new(name, 'AREA')
        data.energy = power
        data.shape = 'DISK'
        data.size = size
        data.color = color
        lamp = bpy.data.objects.new(name, data)
        s.collection.objects.link(lamp)
        lamp.location = pos
        point(lamp, (1, 0, 1))
    return s


def render_scene(output):
    s = setup((.022, .075, .063), (-2.4, 0, 1.7), (10, -19, 12), 18, 1800, 860)
    ground = material('Deep jade', (.026, .105, .081), roughness=.45)
    cream = material('Porcelain', (.82, .91, .75), roughness=.26)
    orange = material('Burnt apricot', (.92, .31, .115), roughness=.32)
    chrome = material('Polished silver', (.7, .89, .85), metal=.92, roughness=.16)
    mint = material('Mint enamel', (.25, .8, .58), metal=.25)
    box('Ground', (0, 0, -.32), (200, 200, .4), ground)
    cylinder('Floating plinth', (2, .25, .05), 3.9, .3, ground)
    cylinder('Porcelain stage', (2, .25, .25), 3.55, .2, cream)
    # A real mesh arch: concentric arcs and straight legs, extruded in Y.
    outer = [(-2.1, 0), (-2.1, 1.65)]
    outer += [(2.1 * math.cos(t), 1.65 + 2.1 * math.sin(t)) for t in [math.pi * (1 - i / 64) for i in range(65)]]
    outer += [(2.1, 0)]
    inner = [(-1.49, 0), (-1.49, 1.65)]
    inner += [(1.49 * math.cos(t), 1.65 + 1.49 * math.sin(t)) for t in [math.pi * (1 - i / 64) for i in range(65)]]
    inner += [(1.49, 0)]
    n = len(outer)
    verts = [(x + 2.1, y, z + .36) for y in (.7, 1.38) for ring in (outer, inner) for x, z in ring]
    faces = []
    for i in range(n - 1):
        faces += [(i, i + 1, n + i + 1, n + i),
                  (2*n+i, 3*n+i, 3*n+i+1, 2*n+i+1),
                  (i, 2*n+i, 2*n+i+1, i+1),
                  (n+i, n+i+1, 3*n+i+1, 3*n+i)]
    faces += [(0, n, 3*n, 2*n), (n-1, 2*n-1, 4*n-1, 3*n-1)]
    mesh = bpy.data.meshes.new('Arch')
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new('Apricot arch', mesh)
    s.collection.objects.link(obj)
    finish(obj, orange, .07)
    cylinder('Orb pedestal', (1.65, -.8, .68), .98, .65, mint)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=64, radius=.95, location=(1.65, -.8, 1.95))
    finish(bpy.context.object, chrome)
    bpy.ops.object.shade_smooth()
    for i in range(5):
        box('Porcelain stair', (3.6 + i*.33, -.95, .4 + (5-i)*.17), (.35, 1.2, (5-i)*.34), cream, .035)
    bpy.ops.mesh.primitive_torus_add(major_radius=.62, minor_radius=.18, major_segments=96, minor_segments=32, location=(4.2, 1, 2.4), rotation=(math.pi/2, .3, -.2))
    finish(bpy.context.object, chrome)
    bpy.ops.object.shade_smooth()
    cylinder('Small column', (.3, -1.1, .6), .3, .52, orange)
    # Original render, also usable as the product's output preview.
    s.render.filepath = str(output / 'blender-studio.png')
    bpy.ops.render.render(write_still=True)


def render_pcb(output, source):
    s = setup((.02, .035, .075), (0, 0, .4), (9, -12, 15), 11, 1200, 760)
    bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bounds = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    low = Vector(tuple(min(v[i] for v in bounds) for i in range(3)))
    high = Vector(tuple(max(v[i] for v in bounds) for i in range(3)))
    center = (low + high) / 2
    scale = 7.6 / max(high - low)
    root = bpy.data.objects.new('Board presentation', None)
    s.collection.objects.link(root)
    imported = [o for o in s.objects if o.parent is None and o.type not in {'CAMERA', 'LIGHT'} and o != root]
    for obj in imported:
        obj.parent = root
    root.scale = (scale,) * 3
    root.location = -center * scale
    ground = material('Midnight studio', (.03, .045, .09), roughness=.5)
    box('Ground', (0, 0, -1), (200, 200, .1), ground)
    s.render.filepath = str(output / 'copper-board.png')
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--pcb-glb', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    render_scene(args.output.resolve())
    if args.pcb_glb:
        render_pcb(args.output.resolve(), args.pcb_glb.resolve())
