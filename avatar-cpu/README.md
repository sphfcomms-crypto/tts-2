# CPU call renderer

The website can send its authenticated video-only requests to this loopback worker when the rental renderer is unavailable. It keeps the original call audio on the browser's playback clock. For each 25 fps source frame, it predicts speech sounds from the actual waveform and selects mouth images rendered on that exact frame by MuseTalk. Soft changes warp corresponding lip landmarks toward the intermediate shape before blending the two poses. Digital silence uses the calibrated rest pose.

## Install

Use Python 3.12 and the system FFmpeg executable. Install the pinned binary wheels from `requirements.txt` in `/opt/tts/performance-cpu/venv`. The Python sources, the service template and the requirements file belong in `/opt/tts/performance-cpu`. The daemon reads local assets only and makes no outbound requests. Keep `OPENBLAS_NUM_THREADS=1` and `OMP_NUM_THREADS=1` when benchmarking or serving.

The default data directory is `/opt/tts/performance-data`. Install the pinned ONNX artifact described in [the acoustic model instructions](PHONE_MODEL.md) in `models/uni2005-int8.onnx`. The reproducible exporter is `build_phone_model.py`. Provision units under this layout.

```text
atlas/<name>/meta.json
atlas/<name>/patches.npy
atlas/<name>/lips.npy
clips/<name>.mp4
cache/
```

The `avatar-gpu/make_cpu_atlas.py` exporter writes the per-unit arrays and checksums. Copy a complete unit into place through a staging directory followed by a rename. The matching MP4 is the original static master from `public/avatar/video/units`. Set `AVATAR_CPU_CLIPS` to that directory if the website already serves those files. All arrays and masters must be readable by the service user. Only the cache directory needs write access. First startup verifies source and atlas hashes and decodes each master once into a memory-mapped YUV cache. The cache filename includes the exact master hash. Only verified units appear in health.

The included systemd template runs as the unprivileged `tts-avatar` account. Create this account or use the site's existing service user and set filesystem permissions accordingly. Install the template as `/etc/systemd/system/tts-avatar-cpu.service`. Configure `/etc/tts-avatar-cpu.env` with `AVATAR_CPU_KEY_FILE` pointing to the existing relay key file, or provide the existing `AVATAR_GPU_KEY` environment value to the service. The key must match the website's relay key. The default address is `127.0.0.1:8191`. `AVATAR_CPU_DATA`, `AVATAR_CPU_PORT`, `AVATAR_CPU_WORKERS` and `AVATAR_CPU_THREADS` can override the defaults (two concurrent jobs, one worker thread per render). Reload systemd and start the service after installing the assets.

## API and measurements

Both endpoints require the existing `x-avatar-key` header. `GET /health` returns verified native unit IDs and dimensions. `POST /speak?audio=0&clip=<name>&start=<frame>&lead_ms=<ms>&tail_ms=<ms>` accepts the same 16 kHz G.711 μ-law or 24 kHz PCM WAV as the browser. The body limit is 200,000 bytes and the requested interval is at most five seconds. The response is silent fragmented H.264 MP4 with `X-Start`, `X-Frames`, `X-Next-Start`, `X-Cycle` and `X-Duration`. Out-of-order requests are independent. A missing unit returns 404 and an overloaded worker returns 503.

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 venv/bin/python test_renderer.py
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 venv/bin/python benchmark.py \
  --url http://127.0.0.1:8191 --key-file /path/to/existing-key \
  --voice /path/to/real-utterance.wav --clip oa1_talk_explain --runs 24
```

The benchmark sends 400 ms of voiced output per request with 200 ms of previous and 100 ms of following audio. It checks the returned display timestamps, number of frames and absence of an audio track. It records median, p95 and maximum phone-model, composition, encoding and full HTTP timing. Use `--concurrent 2` to measure a second client. The in-process benchmark accepts `--threads 1` or `--threads 2` for a provider-specific CPU comparison. Without `--url` it benchmarks the same local renderer and exact installed source atlas in process.
