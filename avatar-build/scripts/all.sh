#!/bin/bash
# all.sh : full rebuild from the skinned, fitted head (out/skin2.blend) to out/final.blend + quick look sheet
cd /project/w
blender -b out/skin2.blend --python s/22_pose.py -- /project/w/tex/eye.png /project/w/out/posed.blend 2>&1 | grep -e SAVED -e Trace -e Error -e WRIST -A4
blender -b out/posed.blend --python s/23_kameez.py -- /project/w/out/kameez.blend 2>&1 | grep -e CLOTH -e SAVED -e Trace -e Error -e "KAMEEZ final" -A4
blender -b out/kameez.blend --python s/24_wardrobe.py -- /project/w/out/wardrobe.blend 2>&1 | grep -e SHALWAR -e DUPATTA -e KHUSSA -e JEWEL -e NOSEPIN -e SAVED -e Trace -e Error -A4
blender -b out/wardrobe.blend --python s/25_hair.py -- /project/w/out/hair.blend 2>&1 | grep -e HAIR -e SAVED -e Trace -e Error -A6
blender -b out/hair.blend --python s/27_trim.py -- /project/w/out/trimmed.blend 2>&1 | grep -e BODY -e GROUND -e SAVED -e Trace -e Error -A4
python3 s/26_textures.py 2>&1 | tail -4
blender -b out/trimmed.blend --python s/28_materials.py -- /project/w/out/final.blend 2>&1 | grep -e SAVED -e Trace -e Error -A4
blender -b out/final.blend --python s/30_render.py -- /project/w/r quick q_ 2>&1 | grep -e "RENDER done" -e Trace -e Error -A4
python3 sheet.py /tmp/si.jpg 800 r/q_full-front.jpg r/q_three-quarter.jpg r/q_back.jpg r/q_waist-up.jpg r/q_face.jpg
echo ALLDONE
