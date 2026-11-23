# TTS

An Urdu voice app: text to speech in a young woman's voice, live dictation, a
two-way live voice call, and file in / file out. Everything runs on the OpenAI
API; a small router picks the model for each job and fails over between models.

Built on [openai/openai-fm](https://github.com/openai/openai-fm) (MIT), the
demo for OpenAI's speech API.

## What it does

- **Play**: speaks the script. Roman Urdu, Hinglish or Urdu script goes in;
  it is first rewritten in Urdu script, in a young woman's words, with grammar
  and punctuation fixed ("Urdu fix"), then spoken. The app can stream sentences
  in order. When the avatar video needs buffering, Play waits for the picture
  and voice to be ready together.
- **Mic**: dictate the script. Speech is transcribed live and always arrives
  in Urdu script.
- **Live call**: talk with her in real time (WebRTC straight to the voice
  model; the server only brokers the connection, so the API key stays on it).
- **Upload**: a text file (.txt, .md, .srt), a Word file (.docx), a PDF, a
  photo of a page, or a voice recording becomes the script.
- **Voice / Text**: save the audio (.wav) or the spoken text (.txt).
- **Settings**: voice, vibe (speaking style) and a few on/off options,
  remembered in the browser.

## Models

| Job | First choice | Then |
| --- | --- | --- |
| Urdu fix | gpt-6.2-luna or gpt-6.2-terra when the key has them | gpt-6.2-sol |
| Voice | gpt-audio-mini | gpt-audio-1.5, gpt-4o-mini-tts, tts-1-hd, tts-1 |
| Mic | gpt-transcribe | gpt-live-transcribe, gpt-4o-transcribe, per-turn transcription |
| Live call | gpt-live-1.1 | gpt-live-1 |
| Reading pages (PDF, photos) | gpt-6.2-sol | gpt-6.2-astra, gpt-6.1-terra |

The order comes from measurements, recorded in comments next to each list in
`src/lib/router/`. Two of them are worth knowing:

- The audio models garble the first word of a recording, so every piece is
  recorded with a throwaway warm-up sentence that is cut off afterwards, and
  each piece is transcribed and re-recorded if it does not say the text.
- The text stored inside an Urdu PDF has the letters of each word in a
  scrambled order, so Urdu PDFs are read from pictures of their pages, and
  the stored letters are used to check the reading.

The text jobs (Urdu fix, script conversion, reading pages) use only the
gpt-6 reasoning models, through the Responses API, and every answer comes
back as a forced tool call (`src/lib/router/responses.ts`).

Scans and photos may be old, torn, faded or blurred. Each one is sent to the
reader twice: enlarged as it is, and as a cleaned copy with the paper's
colour and uneven light removed (`src/lib/pageImages.ts`). The reader writes
`[…]` for a word it cannot make out instead of guessing, the app says so, and
the voice pauses there. On seven damaged test pages gpt-6.2-sol found 88 to
100% of the words on six; the seventh, blurred past what a person can read,
came back as unreadable rather than as made-up text.

## Her on screen

"Show her" in Settings puts her at the top of the page, in the best of three
forms that can be shown at that moment.

**On video (photo-real), while a GPU box is running.** She is a fictional
woman, filmed (generated) in short clips of body language: listening,
nodding, an open-hand gesture, a hand on her chest, a shrug, a wave, a
thoughtful look (`public/avatar/video/units/`). Every clip starts and ends
in the same seated pose, so any one can follow any other.

- The browser selects listening, thinking and speaking clips. During live
  speech, a greeting, question or thanks can cue a gesture when the matching
  clip is available. The GPU uses MuseTalk 1.5 to draw the mouth from the
  actual voice on the selected source frames. The speaking picture includes
  her face, head and shoulders in one frame.
- On a fast connection, the browser schedules short video pieces against the
  speaker output clock. When the direct GPU connection is too slow for Play,
  a compatible browser prepares the script as a single movie before starting.
  It fetches the pictures through the app relay and places the entire recording
  on one continuous audio track. Replay can reuse the prepared movie.
- During a live call, a slow connection can leave the voice audible before
  the first rendered frame arrives. If the renderer misses its deadlines,
  the browser switches to on-device facial animation for that call and
  continues using the same voice connection.
- The rented GPU registers with the app when it starts. See
  `avatar-gpu/README.md` for setup and `avatar-build/measure/README.md` for
  browser recordings. The measurement report counts how much audible speech
  had a visible lip frame and separately measures timing where a matching
  frame arrived. To assess mouth shapes, teeth or head motion, inspect the
  rendered picture with the spoken line.

**Her whole face drawn live, in a call, while a whole-face server is
running.** A second program on the GPU box (`avatar-flash/`, SoulX-FlashHead)
draws her head and shoulders new for every picture from her voice alone:
lips, teeth, jaw, cheeks, eyes, brows and the movement of her head, the way
an offline video model does and a lip-only model cannot. The page
(`src/lib/avatar/flashTalk.ts`) holds her voice back about a second and a
half, sends it a slice at a time all through the call, and keeps the picture
on the sound being heard. The filmed clips show between calls and whenever
the stream is late or down. The target it is measured against is an
eleven-second Seedance 2.5 clip of her; how close it comes, and where it
falls short, is in `avatar-flash/README.md`.

**As a photo-real 3D head, when no box is running.** The same woman, made
from one picture of her by LAM (a model that turns a portrait into a head of
"Gaussian splats": about twenty thousand soft dots, which is why it looks
like the photograph and not like a mesh). It is one 4 MB file,
`public/avatar/head/avatar.zip`, drawn by the browser itself with LAM's
WebGL renderer (`src/components/HeadAvatar.tsx`): no server, no credits.

- Her face is driven by `src/lib/avatar/face.ts`: fifty-two face shapes,
  sixty times a second. During Play, each generated phrase arrives with its audio. The browser
  estimates word and sound boundaries from pronunciation, pauses and changes
  in the recording, and uses the playback clock to animate them. In a call
  it uses transcript fragment timestamps when available and follows the
  voice directly when text cues are missing. Her eyes, brows and head
  respond to listening, thinking, questions and speech emphasis.
- It is a head and neck only: no hands, no body language. Her skin is a
  little softer than the photograph, and her earrings smear when she turns.
- It was built on the PC's own graphics card (`avatar-build/lam/`: how LAM
  was installed there, and `make_avatar.sh <picture> <out.zip>` to make
  another in about a minute and a half).

**As a 3D character, when the head cannot be drawn.** `public/avatar/avatar.glb`
was built in Blender (MakeHuman base fitted to the same face, photo skin,
52 face shapes, skeleton, clothes) and is drawn by the browser with
three.js. Its lip, jaw, teeth and tongue shapes follow the same speech cues
as the photo-real head. She breathes, blinks, looks about, nods and gestures (`src/lib/avatar/`). It needs no server. It
looks like a good 3D character, not like a person on video.

The build scripts and references for both are in `avatar-build/`.

## Run it

Needs Node.js 22 or newer.

```bash
cp .env.example .env    # then put your key after OPENAI_API_KEY=
npm install
npm run dev             # http://localhost:3000
```

Settings in `.env`:

| Name | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | Required. |
| `APP_PASSWORD` | Optional. Locks the production site behind this password. |
| `LIMIT_*`, `CALL_MAX_MINUTES`, `USAGE_LIMITS` | Optional usage caps for a public server; see `.env.example`. |

A production build that does not disturb the dev server:
`run-prod.bat` (Windows, port 3080).

## Deploy

`deploy/deploy.sh` uploads the code to a Linux server over SSH, builds it
there, runs it as a systemd service and publishes it with Tailscale Funnel
(public HTTPS, no changes to any web server already on the machine). The
build happens before the switch, so a failed build leaves the running site
untouched.

```bash
bash deploy/deploy.sh --with-env   # first time, or after changing .env
bash deploy/deploy.sh              # code only
```

The server address, SSH key and ports are at the top of the script and can be
overridden with `TTS_SERVER`, `TTS_SSH_KEY`, `TTS_PORT`, `TTS_FUNNEL_PORT`.

A public server spends money on your OpenAI key for every visitor. The
production build caps usage per visitor and per day (`src/lib/usage.ts`), and
each live call ends after ten minutes; set `APP_PASSWORD` to lock the site.

## Limits

- A script is at most 3000 characters (about three minutes of speech).
  Longer files are loaded up to that point, and the app says so.
- Voice uploads up to 25 MB. PDFs: the first pages, up to eight.
- Reading Urdu from a picture is about 95% accurate, not exact. Check names
  and numbers.
- Old `.doc` files are not read; save them as `.docx`.

## License

MIT, as the project it is built on. See [LICENSE](LICENSE).
