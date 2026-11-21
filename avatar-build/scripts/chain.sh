#!/bin/bash
# chain.sh : pose -> kameez -> wardrobe
cd /project/w
blender -b out/skin2.blend --python s/22_pose.py -- /project/w/tex/eye.png /project/w/out/posed.blend 2>&1 | grep -e SAVED -e Trace -e Error -e WRIST -A4
blender -b out/posed.blend --python s/23_kameez.py -- /project/w/out/kameez.blend 2>&1 | grep -e CLOTH -e SAVED -e Trace -e Error -e "KAMEEZ final" -A4
blender -b out/kameez.blend --python s/24_wardrobe.py -- /project/w/out/wardrobe.blend 2>&1 | grep -e SHALWAR -e DUPATTA -e KHUSSA -e JEWEL -e NOSEPIN -e SAVED -e Trace -e Error -A4
echo CHAINDONE
