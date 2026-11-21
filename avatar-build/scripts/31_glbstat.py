# 31_glbstat.py (system python) - inspect the exported GLB itself: meshes, triangles, morph targets, skin, images, extensions.
#   python3 31_glbstat.py avatar.glb OUT.json
import sys, json, struct, io, os
from PIL import Image
f = open(sys.argv[1], 'rb').read(); magic, ver, total = struct.unpack('<4sII', f[:12]); assert magic == b'glTF'
l0, t0 = struct.unpack('<II', f[12:20]); G = json.loads(f[20:20 + l0]); bin0 = 20 + l0 + 8
acc = G['accessors']; R = {'file_bytes': len(f), 'meshes': {}, 'images': [], 'triangles': 0}
ymin = 9
for m in G['meshes']:
    tris = 0
    for p in m['primitives']:
        tris += acc[p['indices']]['count'] // 3 if 'indices' in p else acc[p['attributes']['POSITION']]['count'] // 3
        ymin = min(ymin, acc[p['attributes']['POSITION']]['min'][1])
    R['meshes'][m['name']] = {'primitives': len(m['primitives']), 'triangles': tris, 'vertices': sum(acc[p['attributes']['POSITION']]['count'] for p in m['primitives']),
                              'morphTargets': m.get('extras', {}).get('targetNames', []), 'targets_in_prim0': len(m['primitives'][0].get('targets', [])),
                              'sparse_targets': sum(1 for t in m['primitives'][0].get('targets', []) if 'sparse' in acc[t['POSITION']]),
                              'morph_normals': any('NORMAL' in t for t in m['primitives'][0].get('targets', []))}
    R['triangles'] += tris
for im in G.get('images', []):
    bv = G['bufferViews'][im['bufferView']]; data = f[bin0 + bv.get('byteOffset', 0): bin0 + bv.get('byteOffset', 0) + bv['byteLength']]
    R['images'].append({'name': im.get('name'), 'mime': im.get('mimeType'), 'bytes': bv['byteLength'], 'size': Image.open(io.BytesIO(data)).size})
R['skins'] = [{'name': s.get('name'), 'joints': [G['nodes'][j]['name'] for j in s['joints']]} for s in G.get('skins', [])]
R['mesh_nodes'] = [n['name'] for n in G['nodes'] if 'mesh' in n]; R['min_y'] = ymin
R['extensionsUsed'] = G.get('extensionsUsed', []); R['extensionsRequired'] = G.get('extensionsRequired', [])
R['materials'] = [{'name': m['name'], 'alphaMode': m.get('alphaMode', 'OPAQUE'), 'doubleSided': m.get('doubleSided', False),
                   'textures': sorted([k for k in list(m.get('pbrMetallicRoughness', {}).keys()) + list(m.keys()) if k.endswith('Texture')])} for m in G['materials']]
R['generator'] = G['asset'].get('generator')
json.dump(R, open(sys.argv[2], 'w'), indent=1)
print("GLB %.2f MB, %d triangles, %d meshes, %d skin(s) with %d joints, min y %.4f" % (len(f) / 1e6, R['triangles'], len(R['meshes']), len(R['skins']), len(R['skins'][0]['joints']) if R['skins'] else 0, ymin))
for k, v in R['meshes'].items(): print("  mesh %-10s tris %6d verts %6d prims %d morphs %d (sparse %d, normals %s)" % (k, v['triangles'], v['vertices'], v['primitives'], len(v['morphTargets']), v['sparse_targets'], v['morph_normals']))
for i in R['images']: print("  image %-24s %-10s %8d B %s" % (i['name'], i['mime'], i['bytes'], i['size']))
for m in R['materials']: print("  material %-10s %-6s ds=%s %s" % (m['name'], m['alphaMode'], m['doubleSided'], m['textures']))
print("  extensions used", R['extensionsUsed'], "required", R['extensionsRequired'])
