# TTS

An Urdu voice app: text to speech in a young woman's voice, live dictation, a
two-way live voice call, and file in / file out. Everything runs on the OpenAI
API; a small router picks the model for each job and fails over between models.

Built on [openai/openai-fm](https://github.com/openai/openai-fm) (MIT), the
demo for OpenAI's speech API.

## What it does

- **Play**: speaks the script. Roman Urdu, Hinglish or Urdu script goes in;
  it is first rewritten in Urdu script, in a young woman's words, with grammar
  and punctuation fixed ("Urdu fix"), then spoken. Audio starts in about two
  seconds: the script is spoken in sentence-sized pieces, generated in
  parallel and streamed in order.
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

"Show her" in Settings puts her at the top of the page, in one of two forms.

**On video (photo-real), while a GPU box is running.** She is a fictional
woman, filmed (generated) in short clips of body language: listening,
nodding, an open-hand gesture, a hand on her chest, a shrug, a wave, a
thoughtful look (`public/avatar/video/units/`). Every clip starts and ends
in the same seated pose, so any one can follow any other.

- A director in the browser (`src/lib/avatar/director.ts`) plays the clips
  back to back and picks each next one by what she is doing: gestures while
  she talks, a wave with her first line of a call, a thoughtful look while
  an answer is being made, otherwise listening.
- Her lips are drawn by a GPU box (`avatar-gpu/`, MuseTalk 1.5) on the very
  frames that are playing (`src/lib/avatar/liveTalk.ts`): her voice, from
  Play or from a live call, is held back about a second and cut into 0.4 s
  chunks; each chunk comes back as silent video of her saying it on the
  clip and frames that will be on screen when it is heard, and a clock
  keeps the picture on the chunk being heard. The voice itself is not
  touched. Measured on the box's output, her mouth moves with the sound at
  an offset of 0 ms.
- The browser fetches the video from the box's own tunnel address with a
  short-lived signed token. It does not pass through this app, whose Funnel
  was measured to carry video slower than it plays.
- The box is rented by the hour and tells the app where it is when it
  starts (`POST /api/avatar/register`, secret `AVATAR_GPU_KEY`). To start
  one, see `avatar-gpu/README.md`.
- When she has finished speaking the page reports how the lip sync kept up
  on that device (pieces asked and joined, how late, the share of her
  speech that had lips) to `POST /api/avatar/report`, which writes one line
  to the server log.
- Her gestures are not chosen from the meaning of her words, and one
  begins only when the clip before it has ended (up to five seconds).

**As a 3D character, when no box is running.** `public/avatar/avatar.glb`
was built in Blender (MakeHuman base fitted to the same face, photo skin,
52 face shapes, skeleton, clothes) and is drawn by the browser with
three.js. Her mouth follows the sound of the voice; she breathes, blinks,
looks about, nods and gestures (`src/lib/avatar/`). It needs no server. It
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
