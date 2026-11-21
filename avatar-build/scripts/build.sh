#!/bin/bash
# build.sh - the whole avatar build in run order (Blender 5.2 LTS + system python with numpy, Pillow, opencv, scipy, mediapipe 0.10.21).
# Paths are absolute: /project/w is the work dir, /project/build holds the MPFB2 install and asset packs of stage 00-02.
#
# Stage 00-02 (previous agent, /project/build/scripts; need the MPFB2 extension, see get.sh / 01.log):
#   python3 00_textures.py            MakeHuman CC0 skin/eye/teeth/tongue textures -> /project/build/tex
#   blender -b --python 01_body.py    MPFB2 human, ARKit face units + Meta visemes, mixamo rig, eyes/teeth/tongue/lashes -> out/stage1.blend
#   blender -b out/stage1.blend --python 02_skinbake.py   -> /project/build/out/stage2.blend
# Stage 11+ (this directory), reference photo at /project/w/ref/face.png:
set -e
cd /project/w; mkdir -p r tex out/glb renders
pip3 install -q mediapipe==0.10.21 opencv-python-headless scipy
./s/fit.sh                                   # 11_ortho + 12_fit + 13_warp, twice: head landmark-fitted to the photo -> out/fit2.blend, r/fit3_*
python3 s/14_prep.py ref/face.png r/fit3 tex # aligned photo (eye openings painted out) + shine map, in render space
blender -b out/fit2.blend --python s/15_bake.py -- /project/w/r/fit3 /project/w/tex /project/w/out/fit_baked.blend   # project + bake into the skin UVs
python3 s/16_skin.py tex                     # colour-matched skin composite, normal, roughness
blender -b out/fit_baked.blend --python s/17_assign.py -- /project/w/tex /project/w/out/skin.blend
python3 s/19_eyes.py tex/eye.png
blender -b out/skin.blend --python s/20_eyemat.py -- /project/w/tex/eye.png /project/w/out/skin2.blend
blender -b out/skin2.blend --python s/22_pose.py -- /project/w/tex/eye.png /project/w/out/posed.blend    # bones renamed, lashes thinned, relaxed pose baked as rest, slimmer build
blender -b out/posed.blend --python s/23_kameez.py -- /project/w/out/kameez.blend                         # kameez + cloth settle
blender -b out/kameez.blend --python s/24_wardrobe.py -- /project/w/out/wardrobe.blend                    # shalwar, dupatta (+cloth settle), khussa, jhumkas, nose pin
blender -b out/wardrobe.blend --python s/25_hair.py -- /project/w/out/hair.blend                          # hair cards
blender -b out/hair.blend --python s/27_trim.py -- /project/w/out/trimmed.blend                           # hidden body faces removed, soles on z=0
python3 s/26_textures.py                     # garment/hair textures, skin clean-up (needs out/kameez_uv.json and out/body_uv_polys.npy)
blender -b out/trimmed.blend --python s/28_materials.py -- /project/w/out/final.blend                     # materials, resting expression
./s/final.sh                                 # 28b_morphfix, 29_export, 31_glbstat, 30_render (all), 32_import + 30_render (check) -> out/glb, renders, /project/scene.blend
# look/debug helpers, not part of the build: 18_look.py, 21_close.py, pv.py, ../sheet.py, ../put.sh
