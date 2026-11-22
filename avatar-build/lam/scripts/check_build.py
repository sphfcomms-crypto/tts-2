"""Smoke test for the compiled extensions: import each one and run it once on the GPU."""
import torch

print("torch", torch.__version__, "| cuda", torch.version.cuda, "|", torch.cuda.get_device_name(0))

import pytorch3d
from pytorch3d.ops import knn_points
from pytorch3d.structures import Meshes
from pytorch3d.renderer.mesh import rasterize_meshes

p = torch.rand(1, 2000, 3, device="cuda")
d = knn_points(p, p, K=4).dists
verts = torch.tensor([[-0.5, -0.5, 1.0], [0.5, -0.5, 1.0], [0.0, 0.5, 1.0]], device="cuda")
faces = torch.tensor([[0, 1, 2]], device="cuda")
pix_to_face, _, _, _ = rasterize_meshes(Meshes([verts], [faces]), image_size=64, faces_per_pixel=1)
print("pytorch3d", pytorch3d.__version__, "knn ok", tuple(d.shape), "raster covered px:", int((pix_to_face >= 0).sum()))

from diff_gaussian_rasterization import GaussianRasterizationSettings, GaussianRasterizer
print("diff_gaussian_rasterization ok")

import nvdiffrast.torch as dr
ctx = dr.RasterizeCudaContext()
pos = torch.tensor([[[-0.8, -0.8, 0.0, 1.0], [0.8, -0.8, 0.0, 1.0], [0.0, 0.8, 0.0, 1.0]]], device="cuda")
tri = torch.tensor([[0, 1, 2]], dtype=torch.int32, device="cuda")
rast, _ = dr.rasterize(ctx, pos, tri, resolution=[64, 64])
print("nvdiffrast ok, covered px:", int((rast[..., 3] > 0).sum()))

import fbx
mgr = fbx.FbxManager.Create()
print("fbx sdk ok", mgr.GetVersion() if hasattr(mgr, "GetVersion") else "")
mgr.Destroy()
