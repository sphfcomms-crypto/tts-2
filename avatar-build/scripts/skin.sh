#!/bin/bash
set -e
cd /project/w
python3 s/14_prep.py ref/face.png r/fit3 tex
blender -b out/fit2.blend --python s/15_bake.py -- /project/w/r/fit3 /project/w/tex /project/w/out/fit_baked.blend 2>&1 | grep -e BAKED -e zchin -e SAVED -e Traceback -e Error -e error
python3 s/16_skin.py tex
blender -b out/fit_baked.blend --python s/17_assign.py -- /project/w/tex /project/w/out/skin.blend 2>&1 | grep -e SAVED -e Traceback -e Error
blender -b out/skin.blend --python s/18_look.py -- /project/w/r/look1 - front,q,side 2>&1 | grep -e LOOK -e Traceback -e Error
blender -b out/skin.blend --python s/18_look.py -- /project/w/r/look1j jawOpen=1 front 2>&1 | grep -e LOOK -e Traceback -e Error
blender -b out/skin.blend --python s/18_look.py -- /project/w/r/look1b eyeBlinkLeft=1,eyeBlinkRight=1,mouthSmileLeft=1,mouthSmileRight=1 q 2>&1 | grep -e LOOK -e Traceback -e Error
python3 s/../sheet.py /tmp/sd.jpg 800 --cols=3 r/look1_front.jpg r/look1_q.jpg r/look1_side.jpg r/look1j_front.jpg r/look1b_q.jpg tex/skin_color.jpg
echo SKINDONE
