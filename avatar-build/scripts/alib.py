# alib.py - shared helpers for the avatar build (stage 11+): cycles setup, ortho/persp cameras, studio light, mesh numpy io.
import bpy, math, os, sys
import numpy as np
from mathutils import Vector
W = '/project/w/'
OCX, OCZ, OSIZE = 0.0, 1.47, 0.26      # orthographic front window (metres): centre x, centre z, width=height

def setup_cycles(scene, res=(1024, 1024), samples=64, denoise=True):
    scene.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'OPTIX'
        prefs.get_devices()
        for d in prefs.devices:
            d.use = (d.type == 'OPTIX')
        scene.cycles.device = 'GPU'
    except Exception as e:
        print("GPU setup failed", e)
    scene.cycles.samples = samples
    scene.cycles.use_denoising = denoise
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = 93
    scene.view_settings.view_transform = 'Standard'
    try: scene.view_settings.look = 'None'
    except Exception: pass
    scene.render.film_transparent = False

def cam(scene):
    c = bpy.data.objects.get("RCAM")
    if c is None:
        c = bpy.data.objects.new("RCAM", bpy.data.cameras.new("RCAM"))
        scene.collection.objects.link(c)
    scene.camera = c
    return c

def world(scene, col=(0.5, 0.5, 0.5), strength=1.0):
    w = scene.world or bpy.data.worlds.new("World")
    scene.world = w; w.use_nodes = True
    nt = w.node_tree; nt.nodes.clear()
    bg = nt.nodes.new('ShaderNodeBackground'); out = nt.nodes.new('ShaderNodeOutputWorld')
    nt.links.new(bg.outputs[0], out.inputs[0])
    bg.inputs[0].default_value = (*col, 1); bg.inputs[1].default_value = strength

def clear_lights():
    for o in list(bpy.data.objects):
        if o.type == 'LIGHT': bpy.data.objects.remove(o)

def ortho_front(scene, path, res=1024, samples=24, flat=True, fmt='PNG'):
    """Front orthographic render of the head window. Character faces -Y. Pixel (px,py): x = OCX + (px/res-0.5)*OSIZE, z = OCZ + (0.5-py/res)*OSIZE."""
    c = cam(scene); c.data.type = 'ORTHO'; c.data.ortho_scale = OSIZE
    c.location = (OCX, -2.0, OCZ); c.rotation_euler = (math.pi / 2, 0, 0); c.data.clip_start = 0.1; c.data.clip_end = 10
    setup_cycles(scene, (res, res), samples)
    if flat:
        clear_lights(); world(scene, (1, 1, 1), 1.0)
    scene.render.image_settings.file_format = fmt
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    c.data.type = 'PERSP'

def studio(scene, center=Vector((0, 0, 1.4)), bgcol=(0.52, 0.52, 0.54)):
    clear_lights(); world(scene, bgcol, 0.9)
    def area(name, loc, energy, size, col=(1, 1, 1)):
        l = bpy.data.lights.new(name, 'AREA'); l.energy = energy; l.size = size; l.color = col
        o = bpy.data.objects.new(name, l); scene.collection.objects.link(o)
        o.location = center + Vector(loc)
        o.rotation_euler = (center - o.location).to_track_quat('-Z', 'Y').to_euler()
    area("L_key", (-1.1, -2.3, 0.7), 90, 2.2, (1.0, 0.97, 0.94))
    area("L_fill", (1.7, -1.9, 0.2), 45, 2.6, (0.96, 0.98, 1.0))
    area("L_rim", (0.8, 2.0, 1.3), 35, 1.2)

def shoot(scene, path, pos, target, lens=85, res=(1024, 1024), samples=96):
    c = cam(scene); c.data.type = 'PERSP'; c.data.lens = lens; c.data.sensor_width = 36; c.data.clip_start = 0.01
    c.location = Vector(pos)
    c.rotation_euler = (Vector(target) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
    setup_cycles(scene, res, samples)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

def co(block, n):
    a = np.empty(n * 3, dtype=np.float32); block.foreach_get('co', a); return a.reshape(-1, 3)

def blocks(me):
    """all coordinate blocks of a mesh: vertices + every shape key"""
    b = [me.vertices]
    if me.shape_keys: b += [k.data for k in me.shape_keys.key_blocks]
    return b

def add_delta(me, delta):
    n = len(me.vertices); d = np.asarray(delta, dtype=np.float32).ravel()
    for blk in blocks(me):
        a = np.empty(n * 3, dtype=np.float32); blk.foreach_get('co', a); blk.foreach_set('co', a + d)
    me.update()

def save(path):
    for im in list(bpy.data.images):
        if im.users == 0 and im.type == 'IMAGE': bpy.data.images.remove(im)
    try: bpy.ops.file.pack_all()
    except Exception as e: print("pack_all:", e)
    bpy.ops.wm.save_as_mainfile(filepath=path, relative_remap=False)
    print("SAVED", path)

def args():
    return sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
