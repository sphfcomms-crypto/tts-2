#!/bin/bash
# final.sh : morph fix -> export GLB + avatar.json -> GLB stats -> beauty renders -> re-import the GLB and render the check shots
cd /project/w
blender -b out/final.blend --python s/28b_morphfix.py -- /project/w/out/final2.blend /project/w/out/glb/morph-audit.json 2>&1 | grep -e ADDED -e AUDIT -e TEETH -e SAVED -e Trace -e Error -A4
blender -b out/final2.blend --python s/29_export.py -- /project/w/out/glb/avatar.glb /project/w/out/glb/avatar.json 2>&1 | grep -e "EXPORT args" -e JSON -e Trace -e Error -A5
python3 s/31_glbstat.py out/glb/avatar.glb out/glb/glb-check.json
blender -b out/final2.blend --python s/30_render.py -- /project/w/renders all 2>&1 | grep -e "RENDER done" -e Trace -e Error -A4
blender -b --factory-startup --python s/32_import.py -- /project/w/out/glb/avatar.glb /project/w/out/imported.blend 2>&1 | grep -e IMPORTED -e Trace -e Error -A4
blender -b out/imported.blend --python s/30_render.py -- /project/w/renders check imported- 2>&1 | grep -e "RENDER done" -e Trace -e Error -A6
cp out/final2.blend /project/scene.blend
echo FINALDONE
