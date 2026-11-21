#!/bin/bash
# tail.sh : hair -> trim -> textures -> materials -> morph fix (out/final2.blend), export, GLB stats, all renders
cd /project/w
if [ "$1" = "wardrobe" ]; then blender -b out/kameez.blend --python s/24_wardrobe.py -- /project/w/out/wardrobe.blend 2>&1 | grep -e SAVED -e Trace -e Error -A4; fi
blender -b out/wardrobe.blend --python s/25_hair.py -- /project/w/out/hair.blend 2>&1 | grep -e HAIR -e SAVED -e Trace -e Error -e custom -A6
blender -b out/hair.blend --python s/27_trim.py -- /project/w/out/trimmed.blend 2>&1 | grep -e BODY -e GROUND -e SAVED -e Trace -e Error -A4
python3 s/26_textures.py 2>&1 | tail -2
blender -b out/trimmed.blend --python s/28_materials.py -- /project/w/out/final.blend 2>&1 | grep -e SAVED -e Trace -e Error -A4
blender -b out/final.blend --python s/28b_morphfix.py -- /project/w/out/final2.blend /project/w/out/morph-audit.json 2>&1 | grep -e JAW -e ADDED -e AUDIT -e SAVED -e Trace -e Error -A4
mkdir -p out/glb renders
blender -b out/final2.blend --python s/29_export.py -- /project/w/out/glb/avatar.glb /project/w/out/glb/avatar.json 2>&1 | grep -e "EXPORT args" -e JSON -e Trace -e Error -A5
python3 s/31_glbstat.py out/glb/avatar.glb out/glb/glb-check.json
blender -b out/final2.blend --python s/30_render.py -- /project/w/renders all 2>&1 | grep -e "RENDER done" -e Trace -e Error -A4
echo TAILDONE
