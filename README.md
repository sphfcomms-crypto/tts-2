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
