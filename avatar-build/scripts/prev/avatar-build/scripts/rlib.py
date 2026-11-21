# rlib.py - shared helpers (render setup, camera, materials) for the avatar build.
import bpy, math, os
from mathutils import Vector

def setup_cycles(scene, res=(1024, 1024), samples=96):
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
    scene.cycles.use_denoising = True
    try:
        scene.cycles.denoiser = 'OPENIMAGEDENOISE'
    except Exception:
        pass
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'JPEG'
    scene.render.image_settings.quality = 92
    scene.view_settings.view_transform = 'Standard'
    try:
        scene.view_settings.look = 'None'
    except Exception:
        pass
    scene.render.film_transparent = False

def setup_studio(scene, center=Vector((0, 0, 1.4)), scale=1.0):
    # grey world + three area lights; removes earlier studio lights
    for o in list(bpy.data.objects):
        if o.name.startswith("STUDIO_"):
            bpy.data.objects.remove(o)
    w = scene.world or bpy.data.worlds.new("World")
    scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes.get('Background')
    if bg is None:
        nt.nodes.clear()
        bg = nt.nodes.new('ShaderNodeBackground')
        out = nt.nodes.new('ShaderNodeOutputWorld')
        nt.links.new(bg.outputs[0], out.inputs[0])
    bg.inputs[0].default_value = (0.58, 0.58, 0.60, 1)
    bg.inputs[1].default_value = 0.55
    def area(name, loc, energy, size, col=(1, 1, 1)):
        l = bpy.data.lights.new(name, 'AREA')
        l.energy = energy; l.size = size; l.color = col
        o = bpy.data.objects.new(name, l)
        scene.collection.objects.link(o)
        o.location = center + Vector(loc) * scale
        d = center - o.location
        o.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
        return o
    # character faces -Y in Blender
    area("STUDIO_key", (-1.2, -2.2, 0.9), 75 * scale * scale, 1.6 * scale, (1.0, 0.97, 0.93))
    area("STUDIO_fill", (1.6, -1.8, 0.3), 28 * scale * scale, 2.0 * scale, (0.95, 0.97, 1.0))
    area("STUDIO_rim", (0.6, 2.2, 1.2), 40 * scale * scale, 1.2 * scale)

def get_cam(scene):
    cam = bpy.data.objects.get("RCAM")
    if cam is None:
        cd = bpy.data.cameras.new("RCAM")
        cam = bpy.data.objects.new("RCAM", cd)
        scene.collection.objects.link(cam)
    scene.camera = cam
    return cam

def shoot(scene, path, pos, target, lens=85, res=None, samples=None):
    cam = get_cam(scene)
    cam.data.lens = lens
    cam.data.sensor_width = 36
    cam.data.clip_start = 0.01
    cam.location = Vector(pos)
    d = Vector(target) - Vector(pos)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    if res:
        scene.render.resolution_x, scene.render.resolution_y = res
    if samples:
        scene.cycles.samples = samples
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("RENDERED", path)

def img_mat(name, image=None, rough=0.6, color=(0.8, 0.8, 0.8, 1), alpha_from_image=False, normal=None, spec=0.5, sss=0.0, metallic=0.0, clip=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    b.inputs['Roughness'].default_value = rough
    b.inputs['Base Color'].default_value = color
    b.inputs['Metallic'].default_value = metallic
    try:
        b.inputs['Specular IOR Level'].default_value = spec
    except Exception:
        pass
    if image is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = image; t.location = (-400, 300)
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        if alpha_from_image:
            if clip:
                r = nt.nodes.new('ShaderNodeMath'); r.operation = 'ROUND'
                nt.links.new(t.outputs['Alpha'], r.inputs[0])
                nt.links.new(r.outputs[0], b.inputs['Alpha'])
            else:
                nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
            try:
                m.surface_render_method = 'DITHERED'
            except Exception:
                pass
    if normal is not None:
        tn = nt.nodes.new('ShaderNodeTexImage'); tn.image = normal; tn.location = (-600, -200)
        normal.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.location = (-250, -200)
        nt.links.new(tn.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if sss > 0:
        try:
            b.inputs['Subsurface Weight'].default_value = sss
            b.inputs['Subsurface Radius'].default_value = (1.0, 0.35, 0.2)
            b.inputs['Subsurface Scale'].default_value = 0.006
        except Exception as e:
            print("sss", e)
    return m

def save(path):
    # /project is a symlink, so relative image paths break: keep absolute paths and pack images into the .blend
    for im in list(bpy.data.images):
        if im.users == 0 and im.type == 'IMAGE':
            bpy.data.images.remove(im)
    try:
        bpy.ops.file.pack_all()
    except Exception as e:
        print("pack_all:", e)
    bpy.ops.wm.save_as_mainfile(filepath=path, relative_remap=False)
    print("SAVED", path)
