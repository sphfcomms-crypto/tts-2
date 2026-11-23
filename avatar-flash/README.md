# avatar-flash: her whole face, drawn live

In a live call this server draws her head and shoulders new for every picture, from her voice
alone: lips, teeth, jaw, cheeks, eyes, brows and the movement of her head. It is the second way
she can be drawn in a call. The first, `avatar-gpu/`, redraws only her mouth on clips that were
filmed beforehand.

It exists because of one clip: eleven seconds of her saying a line in the app's own voice, made
by Seedance 2.5 on OpenArt. That model needs about four minutes for eleven seconds, so it cannot
run inside a call. This one keeps up with her voice on one rented GPU.

## What it is

- **Model:** SoulX-FlashHead, the Lite variant (github.com/Soul-AILab/SoulX-FlashHead; code
  Apache-2.0; the Lite variant's LTX video VAE is under Open-RAIL-M). A streaming video model of
  1.3 billion parameters: from one picture of her and the sound, four denoising steps per pass
  give 33 pictures of 512x512, of which the first 9 repeat the end of the pass before, so her
  movement continues from one pass to the next.
- **Her picture:** one still, 4:3, mouth closed (`inputs/start.jpg`, 1664x1248). The model draws
  the 520x520 square around her head and shoulders (`FLASH_BOX`). The server lays that square back
  into the still with soft edges, so the room, her hands and the armchair are the photograph, and
  sends whole frames of 960x720.
- **One slice at a time:** her voice arrives in slices of 24 pictures (0.96 s). Each is answered
  with exactly those pictures as one silent fragmented MP4 (H.264, no B-frames, BT.709, the same
  settings as `avatar-gpu`, so the browser joins them the same way).
- **Silence:** a hiss far below hearing is mixed into what the model hears (never into what is
  played). With exact digital silence its sound features lose their scale and her lips stay
  parted: 0.065 of the distance between her eyes, against 0.003 with the hiss. And every call
  begins from a pose she has already settled into for four seconds: started from the still
  alone, she opened her mouth for the first two seconds of a call.

## Measured (L40S, 2026-11-23)

Fed three recordings of the app's voice in real time, a slice at a time, the way a call does
(`test_client.py`), 70 slices in all:

| | |
|---|---|
| work per 0.96 s slice | 0.33 s (sound 11 ms, model 252 ms, laying into her picture 8 ms, H.264 60 ms) |
| first sound of a slice spoken to its pictures being back | 1.30 s every time (worst 1.31 s) on the box itself; about 0.3 s more through the tunnel |
| size | 73 kB/s (590 kbit/s) at 960x720 |
| GPU memory | 5 GB; ready about 20 s after start |

Against the Seedance clips of the same three lines (`avatar-build/measure/`):

| | Seedance 2.5 | this server |
|---|---|---|
| lips fully closed on p, b and m | 58 of 58 | 49 of 54 (8/8, 17/22 and 24/24 by line) |
| her lips close before the sound by | 63 to 100 ms | 12 to 32 ms |
| lips apart, 95th percentile | 0.214 | 0.214 |
| mouth width, 5th to 95th percentile | 0.31 to 0.61 | 0.46 to 0.66 |
| blinks in 11 s | 9 | 8 |
| head movement (share of the frame, across and down) | 0.018, 0.036 | 0.016, 0.040 |
| fine detail in the mouth area (same scale) | 22.7 | 25.5 |
| in 15 s of silence | | lips closed (0.003), 9 blinks, head almost still |

So: the same opening of the mouth, the same amount of head movement and blinking, and as sharp;
her lips round less than in the Seedance clips, and in fast speech about one p/b/m in ten is not
fully closed. These are measurements. Watch the two side by side before deciding it is good
enough: nobody has yet judged it by eye on a phone in a real call.

Other settings that were tried and are worse:

- Shorter passes (`FLASH_FRAMES=25` or `17`: slices of 0.64 or 0.32 s, so less delay): the mouth
  area loses detail (21.3 and 13.9 against 25.5), her head wanders more, and with 17 her lips
  close about 130 ms later.
- Letting the model hear ahead (`FLASH_LOOK`), and making the voice louder (`FLASH_GAIN`): no
  gain in closed lips.
- The Pro variant draws 10.5 pictures a second on this GPU. A call needs 25.

## Build and start

```
bash setup.sh                     # once per storage: about four minutes, 25 GB under /workspace/tts-2-lab
# copy server.py, test_client.py, start.sh, stop.sh to /workspace/tts-2-lab/server/
bash /workspace/tts-2-lab/server/start.sh       # last line: FLASH_URL=https://....trycloudflare.com
bash /workspace/tts-2-lab/server/stop.sh
```

`start.sh` starts the server on 127.0.0.1:8100 and its own cloudflared tunnel, waits for
`/health`, and POSTs `{"url": "<tunnel url>"}` with the header `x-avatar-key` to
`<site>/api/avatar/flash/register` for every site the lip-sync box registers with
(`/workspace/avatar-gpu/register_urls.txt`) or those in `FLASH_REGISTER_URLS`. The key is the
app's `AVATAR_GPU_KEY` (read from `/workspace/avatar-gpu/key.txt`; `FLASH_KEY_FILE` names another
file). It shares the box with `avatar-gpu` and touches nothing of it.

Unlike `avatar-gpu` it has no keeper: nothing restarts it, and it does not stop the box when
nobody calls. Stop it, or the box, by hand.

## API

Every request needs the header `x-avatar-key` or, for `/say` from a browser, `t=<expires>.<hex
HMAC-SHA256 of expires under the key>` in the address (the token the app's `/api/avatar/status`
hands out). Anything else is answered 401.

### `GET /health`

`{"ok": true, "model": "SoulX-FlashHead lite", "fps": 25, "slice_frames": 24, "look_frames": 0,
"width": 960, "height": 720, "speed": {...the last slice, milliseconds per stage}, "sessions": n,
"idle_seconds": n}`

### `POST /say?sid=<session>&seq=<n>`

Body: a WAV file holding one slice of her voice (`slice_frames / fps` seconds; 16-bit PCM or
mu-law, any rate, mono). Answer: `video/mp4`, `slice_frames` pictures, silent.

- `sid`: 1 to 64 letters and digits, made up by the caller for one call.
- `seq`: 0, 1, 2, ... A slice that arrives before the one in front of it waits up to 1.5 s for
  it. `seq=0` begins her again from the settled rest pose. A number already drawn is answered 409.
- 400: not a WAV, or not one slice long. 503: as many calls as `FLASH_MAX_SESSIONS` (3) already.
- With `FLASH_LOOK` above 0 the pictures of a slice show the sound from that many pictures
  earlier (`X-Lookahead-Frames`).

## Settings (environment variables, or `flash.env` next to the logs)

`FLASH_FRAMES` (33), `FLASH_LOOK` (0), `FLASH_PICTURE` (`inputs/start.jpg`), `FLASH_BOX`
(`520,0,520`: left, top and size of the square in the picture's own pixels; it should land on
whole pixels of the output), `FLASH_OUT` (`960x720`), `FLASH_FEATHER` (0.09) and
`FLASH_FEATHER_BOTTOM` (0.14: the fade at the square's edges as a share of its size),
`FLASH_NOISE_FLOOR` (0.0005), `FLASH_GAIN` (1), `FLASH_SEED` (42), `FLASH_X264_PRESET` (faster),
`FLASH_X264_CRF` (20), `FLASH_KBPS` (1600), `FLASH_MAX_SESSIONS` (3), `FLASH_SESSION_IDLE` (45 s),
`FLASH_COMPILE` (0; 1 needs a C compiler on the box), `FLASH_PORT` (8100).

## In the app

`src/lib/avatar/flashTalk.ts` uses it in a live call whenever `/api/avatar/status` reports one
(`flash`): her voice is held back about 1.5 s, cut into slices and sent in order all through the
call, her silences too; the answers are joined and a clock keeps the picture on the sound being
heard. Between calls, and whenever a slice is late or the server stops answering, the filmed
clips show; the stream is started again after 2, 5 and 10 seconds. If it never produces a picture
in a call, her lips are drawn the older way. The Play button still uses the lip video.

Checked on the real page without the voice model and without a GPU
(`avatar-build/measure/flash_call.mjs` with `flash_standin.py`): 37 of 37 slices joined in order,
none late, the picture on the sound at 0 ms, the stream on screen all the time she speaks; when
she is cut off the filmed clip shows for 1.6 s; when the server dies mid-call her voice goes on
and the stream returns by itself once the server is back.

Not yet done: a real call against this server from a phone, and a deployed site. During a call
her hands do not move, and the room is a still picture.

## Files

| file | what |
|---|---|
| `setup.sh` | one-time build under `/workspace/tts-2-lab` |
| `server.py` | the server |
| `start.sh`, `stop.sh` | run it, with its tunnel, and tell the app |
| `test_client.py` | feeds it a recording the way a call does; writes the film and the timings |
