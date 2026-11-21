# avatar-gpu: real-time lip-sync server

Turns pieces of speech audio into video of the avatar speaking them, faster than real time on one
GPU (measured on an L40S: about 0.27 s of work per second of speech).

The copies of these files on the PC are the source of truth; on the GPU box they live in
`/workspace/avatar-gpu/` together with everything that is built there.

## What it is

- **Model:** MuseTalk 1.5 (github.com/TMElyralab/MuseTalk, MIT), run in half precision. One UNet
  step per frame redraws the lower half of the face in the latent space of the Stable Diffusion
  VAE (`stabilityai/sd-vae-ft-mse`), driven by `openai/whisper-tiny` audio features. Face
  landmarks for the one-time preparation come from DWPose (`yzd-v/DWPose`, through ONNX Runtime),
  the blend mask from the face-parsing network MuseTalk ships with.
- **Preparation (once per clip, `prepare.py`):** every frame's face box, VAE latents, blend mask
  and the untouched picture are cached in `avatars/<clip>/`.
- **Serving (`server.py`):** audio -> whisper features -> UNet -> VAE decode -> the generated face
  is blended into the untouched frame (in YUV, so pixels outside the mask stay bit-exact) -> x264
  + AAC -> fragmented MP4, sent while it is being made.
- **Pauses:** on its own the model leaves the lips slightly parted during pauses. In pauses of
  200 ms or more the server swaps in audio features at which the model closes the mouth
  (`models/closed_mouth.npy`, found by `calibrate_silence.py` in a sample of the app's voice).

## Start on a new box

```
nohup bash /workspace/avatar-gpu/start.sh > /workspace/avatar-gpu/logs/start.log 2>&1 &
# then read the log; its last line is TUNNEL_URL=https://....trycloudflare.com
```

`start.sh` is safe to run again at any time (running parts are left alone; `--restart` stops them
first). It starts the server on 127.0.0.1:8000 and a cloudflared quick tunnel, waits for `/health`,
POSTs `{"url": "<tunnel url>"}` with the header `x-avatar-key` to every address in
`AVATAR_REGISTER_URLS` (space separated; if unset, the lines of `register_urls.txt`), and starts
`keeper.sh`, which runs `start.sh` again if the server or the tunnel dies. `stop.sh` stops all three.

Nothing has to be installed on a new box: Python, the packages, ffmpeg, cloudflared, the models
and the prepared clips are all inside `/workspace/avatar-gpu`.

## Rebuild from nothing

```
# PC -> box: the files of this folder, the clips, the voice sample, the key
bash /workspace/avatar-gpu/setup.sh          # Python 3.11 + packages, ffmpeg, cloudflared, MuseTalk, weights (about 3 min)
#   clips/talk.mp4 clips/idle.mp4 clips/think.mp4   samples/long.wav   key.txt (mode 600)
bash /workspace/avatar-gpu/build_assets.sh   # prepare talk + idle, closed-mouth calibration, idle/think loops (about 3 min)
bash /workspace/avatar-gpu/start.sh
```

`clips/talk.mp4` on the box is `talk2.mp4` from the PC. Run `build_assets.sh` again whenever a
clip is replaced, then `start.sh --restart`.

## API

Every request needs the header `x-avatar-key` (the `AVATAR_GPU_KEY` value; on the box in
`key.txt`). Without it the answer is 401.

### `GET /health`

```
{"ok": true, "model": "...", "encoder": "...",
 "clips": [{"name": "talk", "frames": 361, "fps": 25, "width": 960, "height": 720, "cycle": 720, ...}],
 "speed": {...the last /speak: frames, audio_seconds, processing_seconds,
           seconds_per_second_of_speech, first_fragment_ms, ms: {feat, unet, vae, blend, encode, ...}},
 "gpu_memory": {...}, "requests": n, "uptime_seconds": n}
```

### `POST /speak?clip=talk&start=<int>`

Body: a WAV file (16-bit PCM mono 24 kHz is the normal case; other rates, stereo and float are
accepted). Answer: `video/mp4`.

| parameter | meaning |
|---|---|
| `clip` | prepared clip, default `talk` (`idle` is also prepared: same woman, mouth closed in the base) |
| `start` | position in the clip's cycle to begin at, any non-negative integer (taken modulo `cycle`). The cycle is the clip forwards then backwards: `cycle = 2 * frames - 2` |
| `lead_ms` | the first `lead_ms` of the WAV are context only: used for the audio features, not rendered, not returned |
| `tail_ms` | (extra) the same at the end of the WAV: look-ahead that is not rendered |
| `audio=0` | (extra) video track only |

Response headers: `X-Next-Start` (value of `start` for the next piece), `X-Start`, `X-Frames`,
`X-Cycle`, `X-Duration`. Pieces of up to 15 frames come back in one go with `Content-Length` and a
`Server-Timing` header (milliseconds per stage); longer ones are chunked and sent as they are made.

The MP4: frames = ceil(seconds after the lead * 25). H.264 High, yuv420p, BT.709 limited range,
constant 25 fps, no B-frames, first frame at time 0, a keyframe at the start and every 25 frames,
constant quality (CRF 16) capped at 3.5 Mbit/s, about 2.3 Mbit/s on the test audio. AAC-LC 48 kHz
mono 96 kbit/s, first packet at time 0, exactly as long as the video, no edit list. Fragmented MP4
(`frag_keyframe+empty_moov+default_base_moof`, fragments of at most 0.4 s, no `mfra` box at the
end); every piece starts at time 0 with its own init segment, same codec settings every time:
`video/mp4; codecs="avc1.64001f, mp4a.40.2"`.

Audio detail: an AAC stream starts with one priming frame, so the sound sits 21 ms later than the
picture and the last 21 ms of each piece's sound are not in it (in practice that is the silence
padding). For gapless sound across many short pieces (live call) play the voice separately and
ask for `audio=0`.

Errors: 400 (not a WAV / nothing left after the lead), 401 (key), 404 (unknown clip), 413 (longer
than 120 s).

## Settings (environment variables read by `server.py`)

`AVATAR_X264_PRESET` (faster), `AVATAR_X264_CRF` (16), `AVATAR_KBPS` (2500 at 960x720; the cap is
1.4 times this), `AVATAR_SHARPEN` (0.5), `AVATAR_SILENCE_RMS` (0.003; 0 switches the closed mouth
in pauses off), `AVATAR_SILENCE_MIN_FRAMES` (5), `AVATAR_MEL_REF` (0.6), `AVATAR_MAX_SECONDS` (120),
`AVATAR_CUDA_GRAPH` (1), `AVATAR_PORT` (8000).

## Files

| file | what |
|---|---|
| `setup.sh` | one-time build of the environment under `/workspace/avatar-gpu` |
| `requirements.txt`, `requirements.lock` | Python packages (the lock file is what setup installed) |
| `prepare.py` | prepares one clip for speaking |
| `calibrate_silence.py` | finds the closed-mouth conditioning |
| `make_loops.sh` | idle/think ping-pong loops and the poster |
| `build_assets.sh` | the three above in one go |
| `server.py` | the server |
| `start.sh`, `stop.sh`, `keeper.sh` | run it |
| `test_client.py` | PC-side test: `python test_client.py <tunnel url>` |

## Added after the first version

- **`server.env`** (next to `start.sh`): settings for the server, one `NAME=value` per line, read by
  `start.sh` and so also by the keeper. It currently lowers the picture to `AVATAR_KBPS=1100`,
  `AVATAR_X264_CRF=21`, which halves the pieces.
- **Browsers may call the server directly** (`patch_direct.py` made this edit; it is already applied
  to `server.py`). The app's own server reaches the user through a slow relay, so:
  - `POST /speak?...&t=<expires>.<signature>`: a request without the key header is accepted when its
    address carries a token made by the app's server: the expiry time (Unix seconds, at most two
    hours ahead) and the hex HMAC-SHA256 of that number under the key. A token opens `/speak` only.
  - `POST /speak?...&keep=1` (with the key): the piece is rendered, kept for two minutes, and the
    answer is JSON `{"id", "bytes", "frames", "next"}`.
  - `GET /piece/<id>`: the kept piece. The id is 64 random hex characters and is its own permission.
  - Answers to requests without the key header carry `Access-Control-Allow-Origin: *`.
- **The `talk` clip** is now a closed-mouth clip with head movement (`talk4.mp4` on the PC), so the
  jaw is drawn by the model alone. The earlier talking clip is kept on the box as
  `clips/talk2-backup.mp4`.
