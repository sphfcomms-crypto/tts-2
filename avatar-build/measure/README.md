# Measuring her on the live page

What the page really shows and plays, recorded at real speed and measured. (The Browser pane of
the desktop app draws about one picture a second while it is hidden, so nothing about timing can
be judged there.)

    npm install puppeteer-core            # once, in this folder
    node record.mjs out/play play 46      # press Play and record 46 s    (SITE=... for another address)
    node record.mjs out/idle idle 26
    node record.mjs out/call call 50 mic.wav   # a live call; mic.wav is what the "caller" says
    python sync.py out/play               # her lips against her voice, picture by picture
    python analyze.py out/play            # clips in order, stalls, joins, a film (review.mp4)

`record.mjs` drives the installed Chrome without a window. It saves every picture the page drew
with the time it was drawn, everything the page sent to the loudspeaker with the time each sample
is heard, and, sixty times a second, what each video element was doing.

`sync.py` uses the list the page keeps of every piece of lip video (`window.__talk.timeline()`):
which stretch of her voice a piece shows and where it sits in the joined video. With the recording
it gives, for every moment, the distance between the lips shown and the voice heard, and whether
the body under her lips is the clip and frame the lips were drawn on.

In `sync.json`, `audible_output_coverage.share` is the fraction of audible 20 ms windows
with a visible lip overlay. The script aligns each recorded mono WAV using its first sample
frame and the browser’s speaker output clock. A window is audible when its RMS exceeds 0.01
of full scale (−40 dBFS) on any recorded output. At the window midpoint it checks the last
logged picture for a lip video with a decoded frame and at least 50% opacity. Missing layers
and clips that never arrived count as uncovered. Record with other app sounds off to isolate
her voice. A silent recording has a null share. Older recordings without aligned PCM have
a null `audible_output_coverage`.

The separate `lips_vs_voice_ms` field measures timing on visible, matched video pieces.
A small offset can occur alongside low coverage. The older `lips_showing_share` field uses
only the periods covered by joined pieces. None of these measures grades pronunciation.

`analyze.py` needs `template.png` (her eyes and nose, cut from a recording) to find her face; it
makes one from picture 300 of the first recording it is run on. A call needs a 48 kHz mono WAV:
ten seconds of silence, a question, then silence.

## Her mouth against a reference clip

The tools above say whether the lip video arrived and sat in the right place. These two say what
her mouth did, in any video file: a recording of the live page, a clip from the GPU box, or a
clip from an offline video model that is used as the target.

    pip install mediapipe==0.10.21 opencv-python-headless soundfile    # Python 3.11 or 3.12
    python mouth_track.py reference.mp4 reference.json
    ffmpeg -i reference.mp4 -ac 1 reference.wav
    python mouth_stats.py reference.json reference.wav

`mouth_track.py` finds her face in every picture (MediaPipe Face Mesh on an enlarged crop of her
head) and writes how far her lips are apart, how wide her mouth is, her jaw, brows, eyelids and
head position. Every length is in units of the distance between her outer eye corners, so a
1664x1248 clip and a 960x720 one compare. `mouth_stats.py` turns that into a few numbers and, with
the sound, the delay at which her mouth follows the loudness of her voice best.

The target on 2026-11-23 is an eleven-second Seedance 2.5 clip of her saying a line in the app's
own voice (made on OpenArt from that recording; a clip takes that model about four minutes):

| | Seedance 2.5 target | `oa1_talk_explain` (filmed talking, silent) | `talk_open` (mouth closed) |
|---|---|---|---|
| lips apart, median / 95th percentile | 0.09 / 0.21 | 0.12 / 0.21 | 0.00 / 0.00 |
| mouth width, 5th to 95th percentile | 0.31 to 0.61 | 0.31 to 0.66 | 0.49 to 0.54 |
| blinks | 8 in 10.8 s | 4 in 5.4 s | 5 in 4.8 s |

In the target her mouth opens about a quarter of a second before each phrase is heard (she breathes
in and shapes the first sound), her eyes close on most phrase starts, and her whole face moves with
the words. Measure a recording of a live call the same way to see how far it is from that.

`mouth_compare.py reference.json test.json` prints the same numbers for two tracks side by side
and how closely one mouth follows the other. `lip_seal.py voice.wav track.json` asks the question
that matters most for lip sync and can be measured: when the voice says p, b or m, do her lips
close, and when? It finds those sounds with the phone recognizer the GPU box already has, so it
runs there. The Seedance clips close her lips on 58 of 58 such sounds, 63 to 100 ms before the
sound; the whole-face server (`avatar-flash/`) on 49 of 54, 12 to 32 ms before.

## The whole-face call on the real page, without a GPU

    python flash_standin.py voice.wav &        # stands in for avatar-flash/server.py on port 8100
    AVATAR_GPU_KEY=test AVATAR_FLASH_URL=http://127.0.0.1:8100 npm run dev      # in the project folder
    node flash_call.mjs out/flash 36           # needs playwright; INTERRUPT_AT=11 cuts her off then

`flash_call.mjs` presses "Call her" on the page. The page's request to start a call is answered
inside the page by a second peer connection that speaks `voice.wav` as her voice, so the page's
own call code runs unchanged on a real audio track, with no voice model and no key. The stand-in
server draws every picture as bright as the slice's sound is loud, so the script can compare the
brightness on screen with the loudness at the loudspeaker sixty times a second.

On 2026-11-23: 37 of 37 slices joined in order, none late; the picture agrees with the sound best
at a delay of 0 ms (0.94); the stream is on screen all the time she speaks; her voice is held back
1.5 s. Cut off mid-sentence, the filmed clip shows for 1.6 s and the stream returns. With the
stand-in killed for five seconds mid-call, her voice goes on, the filmed clip shows for nine
seconds, and the stream comes back by itself.
