#!/bin/bash
# fit.sh : two landmark-fit iterations from stage2.blend -> /project/w/out/fit.blend
set -e
cd /project/w
B=/project/build/out/stage2.blend
for i in 1 2 3; do
  blender -b $B --python s/11_ortho.py -- /project/w/r/ortho_$i.png 2>&1 | grep -e ORTHO -e Traceback -e Error || true
  python3 s/12_fit.py ref/face.png r/ortho_$i.png r/fit$i 2>&1 | grep -v -e WARNING -e INFO -e '^W0' -e '^I0'
  [ $i = 3 ] && break
  blender -b $B --python s/13_warp.py -- /project/w/r/fit$i /project/w/out/fit$i.blend 2>&1 | grep -e WARP -e EYE -e SAVED -e Traceback -e Error
  B=/project/w/out/fit$i.blend
done
echo FITDONE
