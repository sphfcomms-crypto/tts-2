"""Compare two lam_avatar.py runs (frames and exported ZIP), and a ZIP against LAM_WebRender's sample.

usage: compare_runs.py <runA dir> <runB dir>            # each holds out/frames/*.png and avatar.zip
       compare_runs.py --layout <avatar.zip> <reference.zip>
"""
import hashlib
import io
import json
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image


def glb_summary(data):
    magic, version, length = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF", magic
    jlen, jtype = struct.unpack("<I4s", data[12:20])
    doc = json.loads(data[20:20 + jlen])
    out = {
        "glb_version": version,
        "generator": doc.get("asset", {}).get("generator"),
        "nodes": len(doc.get("nodes", [])),
        "meshes": len(doc.get("meshes", [])),
        "skins": len(doc.get("skins", [])),
        "joints": [len(s.get("joints", [])) for s in doc.get("skins", [])],
        "animations": len(doc.get("animations", [])),
        "anim_channels": [len(a.get("channels", [])) for a in doc.get("animations", [])],
        "accessors": len(doc.get("accessors", [])),
    }
    prims = [p for m in doc.get("meshes", []) for p in m.get("primitives", [])]
    out["primitives"] = len(prims)
    out["attributes"] = sorted({a for p in prims for a in p.get("attributes", {})})
    out["morph_targets"] = [len(p.get("targets", [])) for p in prims]
    names = [m.get("extras", {}).get("targetNames") for m in doc.get("meshes", [])]
    out["target_names"] = [n[:4] + ["..."] + n[-2:] if n and len(n) > 6 else n for n in names]
    out["target_name_count"] = [len(n) if n else 0 for n in names]
    if prims:
        acc = doc["accessors"][prims[0]["attributes"]["POSITION"]]
        out["vertices"] = acc["count"]
        out["pos_min"] = [round(x, 4) for x in acc.get("min", [])]
        out["pos_max"] = [round(x, 4) for x in acc.get("max", [])]
    out["node_names"] = [n.get("name") for n in doc.get("nodes", [])][:12]
    return out


def ply_summary(data):
    head = data[:data.index(b"end_header") + 10].decode("ascii", "replace").splitlines()
    return {"format": head[1], "elements": [h for h in head if h.startswith("element")],
            "properties": [h.split()[-1] for h in head if h.startswith("property")]}


def zip_summary(path):
    z = zipfile.ZipFile(path)
    out = {}
    for i in z.infolist():
        if i.filename.startswith("__MACOSX") or i.filename.endswith(".DS_Store") or i.is_dir():
            continue
        data = z.read(i)
        base = i.filename.split("/", 1)[-1]
        e = {"path": i.filename, "bytes": i.file_size, "sha1": hashlib.sha1(data).hexdigest()[:12]}
        if base.endswith(".glb"):
            e.update(glb_summary(data))
        elif base.endswith(".ply"):
            e.update(ply_summary(data))
        elif base.endswith(".json"):
            j = json.loads(data)
            e.update({"json_type": type(j).__name__, "len": len(j),
                      "min": min(j) if isinstance(j, list) else None, "max": max(j) if isinstance(j, list) else None,
                      "is_permutation": isinstance(j, list) and sorted(j) == list(range(len(j)))})
        out[base] = e
    return out


def layout(a, b):
    za, zb = zipfile.ZipFile(a), zipfile.ZipFile(b)
    print("== raw entries")
    for name, z in ((a, za), (b, zb)):
        print(name)
        for i in z.infolist():
            print(f"   {i.file_size:>9}  {i.filename}")
    sa, sb = zip_summary(a), zip_summary(b)
    print("== files (ignoring macOS metadata)")
    print("only in A:", sorted(set(sa) - set(sb)), "| only in B:", sorted(set(sb) - set(sa)))
    for k in sorted(set(sa) | set(sb)):
        print(f"-- {k}")
        ea, eb = sa.get(k, {}), sb.get(k, {})
        for f in sorted(set(ea) | set(eb)):
            va, vb = ea.get(f), eb.get(f)
            mark = "same" if va == vb else "DIFF"
            print(f"   {f:18} {mark}  A={va}")
            if va != vb:
                print(f"   {'':18}       B={vb}")


def runs(a, b):
    a, b = Path(a), Path(b)
    fa = sorted((a / "out" / "frames").glob("*.png"))
    for p in fa:
        q = b / "out" / "frames" / p.name
        x = np.asarray(Image.open(p)).astype(np.int16)
        y = np.asarray(Image.open(q)).astype(np.int16)
        d = np.abs(x - y)
        print(f"{p.name}: max abs diff {int(d.max())}, mean {d.mean():.4f}, px differing >2: {int((d.max(-1) > 2).sum())}")
    sa, sb = zip_summary(a / "avatar.zip"), zip_summary(b / "avatar.zip")
    for k in sa:
        print(k, "identical" if sa[k]["sha1"] == sb[k]["sha1"] else "differs", sa[k]["bytes"], sb[k]["bytes"])


if __name__ == "__main__":
    if sys.argv[1] == "--layout":
        layout(sys.argv[2], sys.argv[3])
    else:
        runs(sys.argv[1], sys.argv[2])
