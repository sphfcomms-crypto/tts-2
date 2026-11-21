# Usage: blender -b scene.blend --python 08_render.py -- all | test | imported
import bpy,sys,os
from mathutils import Vector
sys.path.insert(0,'/project/build/scripts');import rlib
mode=sys.argv[-1];R='/project/avatar-build/renders/';os.makedirs(R,exist_ok=True);sc=bpy.context.scene
if mode=='imported':
 bpy.ops.wm.read_factory_settings(use_empty=True);sc=bpy.context.scene;bpy.ops.import_scene.gltf(filepath='/project/public/avatar/avatar.glb')
rlib.setup_cycles(sc,(800,800),44);rlib.setup_studio(sc,Vector((0,-.03,1.36)));sc.cycles.transparent_max_bounces=16;bpy.data.objects['STUDIO_key'].data.size=.95;bpy.data.objects['STUDIO_fill'].data.energy=23;bpy.data.objects['STUDIO_rim'].data.energy=28;sc.world.node_tree.nodes['Background'].inputs[1].default_value=.47
obs=[o for o in sc.objects if o.type=='MESH' and o.data.shape_keys];base={o.name:{k.name:k.value for k in o.data.shape_keys.key_blocks} for o in obs};
def render(n,pose=None):
 for o in obs:
  for k in o.data.shape_keys.key_blocks:k.value=(pose or {}).get(k.name,base[o.name][k.name]);
 bpy.context.view_layer.update();args={'front':((0,-3.3,.86),(0,0,.805),63,(680,960)),'three-quarter':((1.98,-2.7,.91),(0,0,.805),63,(680,960)),'back':((0,3.3,.86),(0,0,.805),63,(680,960)),'waist':((0,-1.58,1.265),(0,-.02,1.23),65,(768,900))}.get(n,((0,-.86,1.486),(0,-.065,1.469),96,(768,768))); pos,target,lens,res=args;rlib.shoot(sc,R+('imported-' if mode=='imported' else '')+n+'.jpg',pos,target,lens=lens,res=res,samples=18 if mode=='test' else 44)
if mode=='imported':render('waist');render('jawOpen',{'jawOpen':1})
else:
 for n in (['face','waist','front','three-quarter','back'] if mode=='all' else ['face','front','back']):render(n)
 if mode=='all':
  for nm,keys in [('jawOpen',['jawOpen']),('smile',['mouthSmileLeft','mouthSmileRight']),('blink',['eyeBlinkLeft','eyeBlinkRight']),('funnel',['mouthFunnel']),('viseme_aa',['viseme_aa'])]:render(nm,dict.fromkeys(keys,1))
