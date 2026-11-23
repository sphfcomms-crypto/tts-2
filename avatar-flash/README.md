# avatar-flash: her whole face, drawn live

In a live call this server draws her head and shoulders new for every picture, from her voice
alone: lips, teeth, jaw, cheeks, eyes, brows and the movement of her head. It is the second way
she can be drawn in a call. The first, `avatar-gpu/`, redraws only her mouth on clips that were
filmed beforehand.

It exists because of one clip: eleven seconds of her saying a line in the app's own voice, made
by Seedance 2.5 on OpenArt. That model needs about four minutes for eleven seconds, so it cannot
run inside a call. This one keeps up with her voice on one rented GPU.

## What it is

- **Model:** SoulX-FlashHead, the Pro variant (github.com/Soul-AILab/SoulX-FlashHead, code
  Apache-2.0), with the Wan 2.1 video VAE. A streaming video model of 1.3 billion parameters: from
  one picture of her and the sound, four denoising steps per pass give 33 pictures, of which the
  first 5 repeat the end of the pass before, so her movement continues from one pass to the next.
- **Made fast enough for a call** in two ways, neither of which changes what she looks like at
  the size she is shown:
  - the square is drawn at 416 pixels instead of 512 (`FLASH_SIZE`). It is shown 300 pixels wide
    in the 960x720 frame.
  - the model's latents are turned into pictures by TAEHV (`taew2_1`, github.com/madebyollin/taehv,
    MIT), a decoder of 22 MB, instead of the full Wan decoder: 0.07 s a pass against 1.26 s. Its
    colours are fitted to the full decoder's once at start (a 3x4 matrix; what is left differs by
    1 part in 255).
- **Her picture:** one still, 4:3, mouth closed (`inputs/start.jpg`, 1664x1248). The model draws
  the 520x520 square around her head and shoulders (`FLASH_BOX`). The server lays that square back
  into the still with soft edges, so the room, her hands and the armchair are the photograph, and
  sends whole frames of 960x720.
- **One slice at a time:** her voice arrives in slices of 28 pictures (1.12 s). Each is answered
  with exactly those pictures as one silent fragmented MP4 (H.264, no B-frames, BT.709, the same
  settings as `avatar-gpu`, so the browser joins them the same way).
- **Silence:** a hiss far below hearing is mixed into what the model hears (never into what is
  played). With exact digital silence its sound features lose their scale and her lips stay
  parted. And every call begins from a pose she has already settled into for four seconds:
  started from the still alone, she opened her mouth for the first two seconds of a call.

## Measured (one L40S, 2026-11-23)

Fed recordings of the app's voice in real time, a slice at a time, the way a call does
(`test_client.py`):

| | |
|---|---|
| speed | 32 pictures a second (a call needs 25): 0.96 s of work for each 1.12 s slice |
| first sound of a slice spoken to its pictures being back | 2.08 s on the box itself |
| her voice is held back in the browser by | 2.45 s (through the tunnel) |
| size | about 930 kbit/s at 960x720 |
| lips fully closed on p, b and m | 8 of 8 and 24 of 24 (two lines; Seedance: 58 of 58 on three) |
| four minutes without a pause | no drift, no artefacts, lips closed in every silence |

The GPU is busy 86% of the time during a call, so **one call at a time** on an L40S, and nothing
else on that GPU while it runs (`avatar-gpu` on the same GPU would make her late).

By eye, next to the Seedance clips of the same lines: her own face and skin, sharp eyes and teeth,
lips that round and close on the sound, blinks and small movements of her head. What Seedance
has and this has not: her hands and shoulders do not move (they are the photograph), and the
pictures are drawn at 416 pixels, not 1248.

Settings that were tried and are worse:

- **The Lite variant** (`FLASH_MODEL=lite`): three times faster (91 pictures a second, slices of
  0.96 s, her voice held back 1.5 s), and by the numbers as good (mouth opening, blinks, head
  movement, lips closed on 49 of 54). By eye it is not: soft, pale, her eyes half closed.
- **Fewer steps** (`FLASH_STEPS=2` or `3`): her lips turn red and the picture gains contrast.
- **Shorter passes with Pro** (`FLASH_FRAMES=25`, slices of 0.8 s): coloured dots appear, and
  after about 25 seconds her face falls apart. 33 is the only length that held.
- **As the model is shipped** (`FLASH_TAE=0 FLASH_SIZE=512`): 10.5 pictures a second. With the
  small decoder at 512: 19. A call needs 25.
- Letting the model hear ahead (`FLASH_LOOK`), and making the voice louder (`FLASH_GAIN`): no
  gain in closed lips.

## Build and start

```
# copy this folder to the box (anywhere; /workspace/tts-2-lab/server/ survives a stop), then:
bash start.sh            # last line: FLASH_URL=https://....trycloudflare.com
bash stop.sh
```

`start.sh` builds what is missing first (`setup.sh`): the model and its weights once, on the
persistent storage (`/workspace/tts-2-lab`, 17 GB, about three minutes), and Python with its
packages on every new box, on the box's own disk (`/opt/tts-2-lab`, 8 GB, about two minutes; kept
on the persistent storage, the first import on a new box took more than ten minutes). It then
starts the server on 127.0.0.1:8100 and its own cloudflared tunnel, waits for `/health`, and POSTs
`{"url": "<tunnel url>"}` with the header `x-avatar-key` to `<site>/api/avatar/flash/register`
for every site the lip-sync box registers with (`/workspace/avatar-gpu/register_urls.txt`) or
those in `FLASH_REGISTER_URLS`. The key is the app's `AVATAR_GPU_KEY` (read from
`/workspace/avatar-gpu/key.txt`; `FLASH_KEY_FILE` names another file). It touches nothing of
`avatar-gpu`.

Unlike `avatar-gpu` it has no keeper: nothing restarts it, and it does not stop the box when
nobody calls. Stop it, or the box, by hand.

### On your own GPU

```
bash home.sh https://<a running copy of the app>      # last line: APP_URL=https://....trycloudflare.com
bash home.sh --stop
```

The same thing on a machine of your own, with nothing rented: one NVIDIA card about as fast as an
RTX 4080 or better with 12 GB or more, on Linux or on Ubuntu under WSL2. Everything goes under
`~/tts-2-lab` (27 GB; ten minutes the first time). It checks the card, the disk and that the other
copy of the app answers, then runs `preview.sh` below. The link works from any phone for as long
as the machine and the program run.

`start.sh` draws her at the largest size this card keeps up with: it starts at 416 pixels, reads
from `/health` how long one slice takes, and goes down to 384, 352 and 320 while the GPU would be
busy more than nine tenths of the time (`FLASH_SIZES`, `FLASH_BUSY_MOST`; `FLASH_SIZE` fixes one
size). `setup.sh` tries flash-attention on the card once and leaves it out where it does not run
(a card newer than the package): the model then uses PyTorch's own attention.

Several cards help one call only inside one machine (the model can split a pass across them, see
`inference_script_multi_gpu_pro.sh` in its repository; not set up here). Cards in different
machines cannot share a call: each pass sends gigabytes between them.

Not run yet on anything but a rented L40S.

### Trying a branch before it is deployed

```
bash preview.sh [branch]      # last line: APP_URL=https://....trycloudflare.com
bash preview.sh --stop
```

Builds and runs the app itself on the GPU box (its own disk, `/opt/tts-2-preview`), behind its own
link, and starts the video server for it. The page, her clips and the whole-face video come from
the box. The routes that need the OpenAI key (the call, Play, transcripts) are passed on to a copy
of the app that has it (`PREVIEW_UPSTREAM`, or else the first site in `register_urls.txt`; see
`TTS_UPSTREAM` in `next.config.ts`), so no key is put on the box. The link lives as long as the
box does.

## API

Every request needs the header `x-avatar-key` or, for `/say` from a browser, `t=<expires>.<hex
HMAC-SHA256 of expires under the key>` in the address (the token the app's `/api/avatar/status`
hands out). Anything else is answered 401.

### `GET /health`

`{"ok": true, "model": "SoulX-FlashHead pro, 4 steps, TAEHV", "fps": 25, "slice_frames": 28, "look_frames": 0,
"width": 960, "height": 720, "square": [300, 0, 300], "size": 416, "work_seconds": 0.96,
"speed": {...the last slice, milliseconds per stage}, "sessions": n,
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

`FLASH_MODEL` (`pro`; `lite`), `FLASH_STEPS` (4), `FLASH_SIZE` (416 for pro, 512 for lite; a
multiple of 16), `FLASH_TAE` (1: the small decoder, pro only), `FLASH_FRAMES` (33), `FLASH_LOOK`
(0), `FLASH_PICTURE` (`inputs/start.jpg`), `FLASH_BOX`
(`520,0,520`: left, top and size of the square in the picture's own pixels; it should land on
whole pixels of the output), `FLASH_OUT` (`960x720`), `FLASH_FEATHER` (0.09) and
`FLASH_FEATHER_BOTTOM` (0.14: the fade at the square's edges as a share of its size),
`FLASH_NOISE_FLOOR` (0.0005), `FLASH_GAIN` (1), `FLASH_SEED` (42), `FLASH_X264_PRESET` (faster),
`FLASH_X264_CRF` (20), `FLASH_KBPS` (1600), `FLASH_MAX_SESSIONS` (3), `FLASH_SESSION_IDLE` (45 s),
`FLASH_COMPILE` (0; 1 needs a C compiler on the box), `FLASH_PORT` (8100).

## In the app

`src/lib/avatar/flashTalk.ts` uses it in a live call whenever `/api/avatar/status` reports one
(`flash`): her voice is held back about 2.5 s, cut into slices and sent in order all through the
call, her silences too; the answers are joined and a clock keeps the picture on the sound being
heard. Between calls, and whenever a slice is late or the server stops answering, the filmed
clips show; the stream is started again after 2, 5 and 10 seconds. If it never produces a picture
in a call, her lips are drawn the older way. The Play button still uses the lip video.

Checked on the real page, built and served on the GPU box by `preview.sh`, against this server
(`avatar-build/measure/flash_call.mjs`, 2026-11-23):

- **Her voice played by a second peer in the page** (the reference line, twice), as a desktop and
  as a phone-sized page: the stream is on screen from 2.7 s after "Call her" and all the time she
  speaks, 27 of 28 slices joined when the call was ended, none late, no failures, her voice held
  back 2.5 s.
- **A real call** (the voice model, through the live site's `/api/call`; the caller is a
  recording): she answers in Urdu, 52 of 53 slices joined, none late, no failures.
- **When the caller talks over her**, what she had not yet been heard to say is dropped and the
  filmed clip shows until the sound from then on is due, about 2.6 s each time. A caller who
  never stops (the recording talks for 26 s) kept the clip on screen for 17 s.

Seen in the films of those calls: her own face, sharp, lips and jaw on the words. Where the
stream and a filmed clip change places there is a cross-fade of a few pictures in which both
show (the clip is sharper and has more contrast, and her head sits a little differently).

Checked earlier without a GPU, with `flash_standin.py`: when the server dies mid-call her voice
goes on and the stream returns by itself once the server is back.

Not yet done: a call from a real phone, and a deployed site (the preview lives as long as the
box). During a call her hands do not move, and the room is a still picture.

## Files

| file | what |
|---|---|
| `setup.sh` | builds what is missing: the model on the storage, Python on the box |
| `server.py` | the server |
| `start.sh`, `stop.sh` | run it, with its tunnel, and tell the app |
| `preview.sh` | run a branch of the app on the box, with the server, behind its own link |
| `home.sh` | the same on a machine of your own: checks it, then runs `preview.sh` under `~/tts-2-lab` |
| `test_client.py` | feeds it a recording the way a call does; writes the film and the timings |
