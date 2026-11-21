#!/bin/bash
# fin.sh : trim -> textures -> materials -> quick look
cd /project/w
blender -b out/hair.blend --python s/27_trim.py -- /project/w/out/trimmed.blend 2>&1 | grep -e BODY -e GROUND -e SAVED -e Trace -e Error -A4
python3 s/26_textures.py 2>&1 | tail -4
blender -b out/trimmed.blend --python s/28_materials.py -- /project/w/out/final.blend 2>&1 | grep -e SAVED -e Trace -e Error -A4
blender -b out/final.blend --python s/30_render.py -- /project/w/r quick q_ 2>&1 | grep -e "RENDER done" -e Trace -e Error -A4
python3 sheet.py /tmp/sh.jpg 900 r/q_full-front.jpg r/q_three-quarter.jpg r/q_back.jpg r/q_waist-up.jpg r/q_face.jpg
echo FINDONE
