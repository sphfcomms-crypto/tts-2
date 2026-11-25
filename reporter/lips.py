"""LatentSync loaded once and kept: make(video, audio, out) redraws only her mouth."""
import os
import sys

import torch
from omegaconf import OmegaConf

LS = os.environ.get("LATENTSYNC_DIR", "/workspace/reporter/LatentSync")
_pipe = None
_config = None


def load():
    global _pipe, _config
    if _pipe is not None:
        return
    os.chdir(LS)
    sys.path.insert(0, LS)
    from diffusers import AutoencoderKL, DDIMScheduler
    from latentsync.models.unet import UNet3DConditionModel
    from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
    from latentsync.whisper.audio2feature import Audio2Feature
    from DeepCache import DeepCacheSDHelper
    _config = OmegaConf.load("configs/unet/stage2_512.yaml")
    dtype = torch.float16
    scheduler = DDIMScheduler.from_pretrained("configs")
    audio_encoder = Audio2Feature(model_path="checkpoints/whisper/tiny.pt", device="cuda",
                                  num_frames=_config.data.num_frames, audio_feat_length=_config.data.audio_feat_length)
    vae = AutoencoderKL.from_pretrained("stabilityai/sd-vae-ft-mse", torch_dtype=dtype)
    vae.config.scaling_factor = 0.18215
    vae.config.shift_factor = 0
    unet, _ = UNet3DConditionModel.from_pretrained(OmegaConf.to_container(_config.model), "checkpoints/latentsync_unet.pt", device="cpu")
    unet = unet.to(dtype=dtype)
    _pipe = LipsyncPipeline(vae=vae, audio_encoder=audio_encoder, unet=unet, scheduler=scheduler).to("cuda")
    helper = DeepCacheSDHelper(pipe=_pipe)
    helper.set_params(cache_interval=3, cache_branch_id=0)
    helper.enable()


def make(video, audio, out, steps=20, temp="/workspace/reporter/tmp"):
    load()
    from accelerate.utils import set_seed
    set_seed(1247)
    os.makedirs(temp, exist_ok=True)
    _pipe(video_path=video, audio_path=audio, video_out_path=out, num_frames=_config.data.num_frames,
          num_inference_steps=steps, guidance_scale=1.5, weight_dtype=torch.float16,
          width=_config.data.resolution, height=_config.data.resolution,
          mask_image_path=_config.data.mask_image_path, temp_dir=temp)
