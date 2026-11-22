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
