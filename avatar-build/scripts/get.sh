#!/bin/bash
cd /project/build/dl
B=https://files.makehumancommunity.org
for u in functional/faceunits01.zip functional/visemes01.zip functional/visemes02.zip functional/haireditor.zip asset_packs/skins01/skins01_cc0.zip asset_packs/eyebrows01/eyebrows01_cc0.zip asset_packs/eyelashes01/eyelashes01_cc0.zip asset_packs/hair02/hair02_ccby.zip asset_packs/hair03/hair03_ccby.zip asset_packs/shoes02/shoes02_ccby.zip asset_packs/cheek01/cheek01_cc0.zip asset_packs/nose01/nose01_cc0.zip; do
  f=$(basename $u)
  curl -sfL -m 300 -o $f $B/$u; echo "$f rc=$? size=$(stat -c %s $f 2>/dev/null)"
done
echo ALLDONE
