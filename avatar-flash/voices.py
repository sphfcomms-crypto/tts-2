"""Her voice from text, for the live page (server.py POST /tts).

Three engines, chosen by the voice's name:
  - ElevenLabs (saira, reva, reva-soft, or el:<voice id>): native Urdu voices from ElevenLabs'
    voice library on its newest model; needs an ElevenLabs key (ELEVENLABS_API_KEY, or the file
    named by FLASH_ELEVEN_KEY_FILE). The most natural of the three.
  - OpenAI's speech model (marin, coral, shimmer, ...), spoken in the manner of a news anchor;
    needs an OpenAI key (OPENAI_API_KEY, or the file named by FLASH_OPENAI_KEY_FILE).
  - Microsoft's free neural voices (ur-PK-UzmaNeural, ...): through edge-tts; no key.
All need the internet. Nothing here touches the GPU.

A speech model now and then leaves out the end of what it was given (OpenAI's most often: a
closing "shukriya" or "Allah hafiz"). So the text is spoken in pieces of a sentence or two, and,
when there is an OpenAI key, each piece is heard back by OpenAI's transcriber and made again if its
last words are not in it. The comparison is of rough consonant skeletons, because the transcriber
writes Urdu speech in Urdu or in Hindi letters as it likes. FLASH_TTS_CHECK=0 turns this off.
"""
import difflib
import json
import os
import re
import struct
import sys
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
from array import array
from concurrent.futures import ThreadPoolExecutor

RATE24 = 24000       # every engine's voice here: 16-bit mono PCM at 24 kHz
OPENAI_VOICES = {"marin", "cedar", "coral", "shimmer", "sage", "alloy", "ash", "ballad", "echo", "fable",
                 "nova", "onyx", "verse"}
OPENAI_MODEL = os.environ.get("FLASH_TTS_MODEL", "gpt-4o-mini-tts")
ANCHOR_STYLE = ("Speak fluent, natural Urdu like a warm, confident Pakistani TV news anchor. Human pacing "
                "with small natural pauses, clear pronunciation, calm and friendly, never robotic. Read the "
                "text exactly as written, every word to the very last one; never skip, shorten or add anything.")
# Native Urdu voices from ElevenLabs' voice library (shared by their owners for anyone to use).
ELEVEN_VOICES = {"saira": "hA0RyxVmITMttngSpcOF", "reva": "UT6USLtoAlXHj5k4sOLY", "reva-soft": "o85TqPN3F4P7dWae2paA"}
ELEVEN_ID = re.compile(r"el:([A-Za-z0-9]{16,40})")
ELEVEN_MODEL = os.environ.get("FLASH_ELEVEN_MODEL", "eleven_v4")
EDGE_VOICE = re.compile(r"[a-z]{2,3}-[A-Z]{2,4}-[A-Za-z]+Neural")
RATE = re.compile(r"[+-][0-9]{1,2}%")
CHECK = os.environ.get("FLASH_TTS_CHECK", "1") != "0"
HEARER = os.environ.get("FLASH_TTS_CHECK_MODEL", "gpt-4o-transcribe")
PIECE = 220          # characters spoken at a time
PAUSE = 0.32         # seconds of quiet between pieces (each ends a sentence)
TRIES = {"openai": 3, "eleven": 2}        # tries per piece when its end is not heard (ElevenLabs costs more)
WORKERS = {"openai": 4, "eleven": 3}      # pieces made at once (ElevenLabs' Starter plan allows three)
LOG = None           # server.py sets its log here: LOG(event=..., ...)


def _key(env, file_env):
    key = os.environ.get(env, "").strip()
    path = os.environ.get(file_env, "")
    if not key and path and os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            key = f.read().strip()
    return key


def openai_key():
    return _key("OPENAI_API_KEY", "FLASH_OPENAI_KEY_FILE")


def eleven_key():
    return _key("ELEVENLABS_API_KEY", "FLASH_ELEVEN_KEY_FILE")


def engine(voice):
    """Which engine speaks with this voice: "eleven", "openai", "edge", or None."""
    if voice in ELEVEN_VOICES or ELEVEN_ID.fullmatch(voice):
        return "eleven"
    if voice in OPENAI_VOICES:
        return "openai"
    if EDGE_VOICE.fullmatch(voice):
        return "edge"
    return None


def known(voice):
    return engine(voice) is not None


def chunks(text, limit=PIECE):
    """The text in pieces of at most `limit` characters, cut only after the end of a sentence
    where it can be (else after a comma, else between words), and as even as can be: a short
    closing line ("Allah hafiz") goes with the sentences before it rather than alone, where a
    speech model is most likely to garble it."""
    parts = []
    for sentence in re.split(r"(?<=[۔.!?؟\n])\s+", text.strip()):
        sentence = sentence.strip()
        while len(sentence) > limit:
            head = sentence[:limit]
            cut = max(head.rfind("، "), head.rfind(", "), head.rfind("; "))
            cut = cut + 1 if cut > limit // 2 else head.rfind(" ")
            if cut <= limit // 2:
                cut = limit
            parts.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if sentence:
            parts.append(sentence)
    # Line breaking, as in setting text: the pieces whose summed squared shortfall from `limit` is
    # least, so that no piece is much shorter than the others.
    n = len(parts)
    best = [0.0] + [float("inf")] * n
    start = [0] * (n + 1)
    for j in range(1, n + 1):
        size = -1
        for i in range(j - 1, -1, -1):
            size += len(parts[i]) + 1
            if size > limit and i < j - 1:
                break
            cost = best[i] + (limit - min(size, limit)) ** 2
            if cost < best[j]:
                best[j], start[j] = cost, i
    out, j = [], n
    while j > 0:
        out.append(" ".join(parts[start[j]:j]))
        j = start[j]
    return out[::-1]


def wav(pcm, rate=RATE24):
    """16-bit mono PCM -> a WAV file."""
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm)) + pcm)


def _note(**fields):
    if LOG:
        LOG(**fields)
    else:
        print(json.dumps(fields, ensure_ascii=False), file=sys.stderr)


def _post(request, timeout, who):
    """One call to a voice service, tried again after a moment if the line or the service stumbles
    (not if it refuses)."""
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as answer:
                return answer.read()
        except urllib.error.HTTPError as err:
            said = err.read()[:300].decode(errors="replace")
            if err.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"{who} answered {err.code}: {said}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            if attempt < 2:
                time.sleep(1.0)
                continue
            raise RuntimeError(f"{who} could not be reached: {err}") from None
    raise RuntimeError(f"{who} did not answer")


def _even(pcm):
    return pcm[: len(pcm) - len(pcm) % 2]


def _openai(key, body):
    """OpenAI's voice for one piece, as 16-bit PCM at 24 kHz."""
    def ask(b):
        return _post(urllib.request.Request("https://api.openai.com/v1/audio/speech", data=json.dumps(b).encode(),
                                            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"}),
                     120, "OpenAI")
    try:
        return _even(ask(body))
    except RuntimeError as err:
        if "speed" not in body or " 400:" not in str(err):
            raise
        return _even(ask({k: v for k, v in body.items() if k != "speed"}))   # a model that takes no speed


def _eleven(key, voice_id, body):
    """ElevenLabs' voice for one piece, as 16-bit PCM at 24 kHz. A field the model does not take
    (a 400 or 422 naming it) is left out and the piece asked for once more."""
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=pcm_24000"
    for _ in range(4):
        request = urllib.request.Request(url, data=json.dumps(body).encode(),
                                         headers={"xi-api-key": key, "Content-Type": "application/json"})
        try:
            return _even(_post(request, 120, "ElevenLabs"))
        except RuntimeError as err:
            text = str(err)
            drop = [k for k in ("previous_text", "next_text", "voice_settings", "language_code")
                    if k in body and (" 400:" in text or " 422:" in text) and k in text]
            if not drop:
                raise
            body = {k: v for k, v in body.items() if k not in drop}
    raise RuntimeError("ElevenLabs refused every form of the request")


def _heard(key, pcm, language):
    """What OpenAI's transcriber hears in her voice (a second of quiet around it helps it)."""
    boundary = uuid.uuid4().hex
    fields = {"model": HEARER, **({"language": language} if language else {})}
    body = b"".join(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
                    for k, v in fields.items())
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"her.wav\"\r\n"
             f"Content-Type: audio/wav\r\n\r\n").encode()
    body += wav(bytes(RATE24) + pcm + bytes(2 * RATE24)) + f"\r\n--{boundary}--\r\n".encode()
    request = urllib.request.Request("https://api.openai.com/v1/audio/transcriptions", data=body,
                                     headers={"Authorization": f"Bearer {key}",
                                              "Content-Type": f"multipart/form-data; boundary={boundary}"})
    return json.loads(_post(request, 90, "OpenAI")).get("text", "")


# ---------------------------------------------------------------- did she say all of it?
_URDU = {"ب": "b", "پ": "p", "ت": "t", "ٹ": "t", "ث": "s", "ج": "j", "چ": "c", "خ": "k", "د": "d", "ڈ": "d", "ذ": "j",
         "ر": "r", "ڑ": "r", "ز": "j", "ژ": "j", "س": "s", "ش": "s", "ص": "s", "ض": "j", "ط": "t", "ظ": "j", "غ": "g",
         "ف": "p", "ق": "k", "ک": "k", "ك": "k", "گ": "g", "ل": "l", "م": "m", "ن": "n", "ں": "n"}
_DEVA = {"क": "k", "ख": "k", "ग": "g", "घ": "g", "ङ": "n", "च": "c", "छ": "c", "ज": "j", "झ": "j", "ञ": "n", "ट": "t",
         "ठ": "t", "ड": "d", "ढ": "d", "ण": "n", "त": "t", "थ": "t", "द": "d", "ध": "d", "न": "n", "प": "p", "फ": "p",
         "ब": "b", "भ": "b", "म": "m", "र": "r", "ल": "l", "श": "s", "ष": "s", "स": "s", "ं": "n", "ँ": "n",
         "क़": "k", "ख़": "k", "ग़": "g", "ज़": "j", "ड़": "r", "ढ़": "r", "फ़": "p"}
_NUKTA = {"ड": "r", "ढ": "r", "ज": "j", "फ": "p", "क": "k", "ख": "k", "ग": "g"}
_LATIN2 = [("ch", "c"), ("sh", "s"), ("kh", "k"), ("gh", "g"), ("ph", "p"), ("th", "t"), ("dh", "d"), ("bh", "b"), ("jh", "j")]
_LATIN = {"b": "b", "c": "k", "d": "d", "f": "p", "g": "g", "j": "j", "k": "k", "l": "l", "m": "m", "n": "n", "p": "p",
          "q": "k", "r": "r", "s": "s", "t": "t", "x": "ks", "z": "j"}


def skeleton(text):
    """Urdu, Hindi or Latin letters to one rough skeleton of consonants: vowels, h, w and y are
    left out, and sounds the scripts write differently (z/j, f/p, q/k, the t's and d's) are one."""
    text = unicodedata.normalize("NFC", text).lower()
    for a, b in _LATIN2:
        text = text.replace(a, b)
    out = []
    for i, ch in enumerate(text):
        if ch == "़":                       # a nukta changes the letter before it
            if out and i and text[i - 1] in _NUKTA:
                out[-1] = _NUKTA[text[i - 1]]
            continue
        out.append(_URDU.get(ch) or _DEVA.get(ch) or _LATIN.get(ch) or (ch if ch.isdigit() else ""))
    return "".join(out)


def said(text, heard):
    """How much of the text is in what was heard (0..1), how much of its last eight sounds, and how
    much of its last four (so that two short words left out at the end are noticed too)."""
    t, h = skeleton(text), skeleton(heard)
    if not t:
        return 1.0, 1.0, 1.0

    def found(part, within):
        return sum(b.size for b in difflib.SequenceMatcher(None, part, within, autojunk=False).get_matching_blocks()) / len(part)
    tail = h[-max(14, len(h) // 3):]
    return found(t, h), found(t[-8:], tail), found(t[-4:], h[-10:])


def score(text, heard):
    """1 or more when what was heard has all of the text, its end above all; less when not."""
    whole, last8, last4 = said(text, heard)
    return min(whole / 0.8, last8 / 0.7, last4 / 0.75)


def _language(text):
    urdu = sum("؀" <= c <= "ۿ" for c in text)
    hindi = sum("ऀ" <= c <= "ॿ" for c in text)
    latin = sum(c.isascii() and c.isalpha() for c in text)
    if urdu > max(hindi, latin):
        return "ur"
    return "hi" if hindi > latin else None


def _trim(pcm, margin=0.06, floor=0.006):
    """Her voice without the quiet before and after it (keeping a breath's margin)."""
    x = array("h", pcm)
    hop = RATE24 // 100
    loud = [i for i in range(0, len(x) - hop, hop)
            if (sum(v * v for v in x[i:i + hop]) / hop) ** 0.5 > floor * 32768]
    if not loud:
        return pcm
    keep = int(margin * RATE24)
    a, b = max(0, loud[0] - keep), min(len(x), loud[-1] + hop + keep)
    return x[a:b].tobytes()


# ---------------------------------------------------------------- her voice
def speech(text, voice, rate="+0%"):
    """Her voice (ElevenLabs or OpenAI) as one WAV at 24 kHz: the text spoken a piece at a time
    (several at once), each piece heard back and made again if its end is missing, and joined in
    order with a pause between."""
    kind = engine(voice)
    if kind not in ("eleven", "openai"):
        raise ValueError(f"not an ElevenLabs or OpenAI voice: {voice}")
    key = eleven_key() if kind == "eleven" else openai_key()
    if not key:
        name = "ElevenLabs" if kind == "eleven" else "OpenAI"
        raise RuntimeError(f"no {name} key here: run  bash live.sh --key  once, then  bash live.sh")
    hear_key = openai_key() if CHECK else ""
    pct = int(rate[:-1]) if RATE.fullmatch(rate) else 0
    language = _language(text)
    pieces = chunks(text)

    if kind == "eleven":
        voice_id = ELEVEN_VOICES.get(voice) or ELEVEN_ID.fullmatch(voice).group(1)
        speed = min(1.2, max(0.7, 1.0 + pct / 100.0))

        def make(n):
            body = {"text": pieces[n], "model_id": ELEVEN_MODEL}
            if language:
                body["language_code"] = language
            if abs(speed - 1.0) > 1e-6:
                body["voice_settings"] = {"speed": round(speed, 2)}
            # The words around a piece keep her voice going on from one piece to the next.
            if n > 0:
                body["previous_text"] = pieces[n - 1][-300:]
            if n + 1 < len(pieces):
                body["next_text"] = pieces[n + 1][:300]
            return _eleven(key, voice_id, body)
    else:
        style = ANCHOR_STYLE + (" Speak a little slower than usual." if pct < 0 else
                                " Speak a little faster than usual." if pct > 0 else "")
        speed = 1.0 + pct / 100.0

        def make(n):
            body = {"model": OPENAI_MODEL, "voice": voice, "input": pieces[n], "instructions": style, "response_format": "pcm"}
            if abs(speed - 1.0) > 1e-6:
                body["speed"] = round(speed, 2)
            return _openai(key, body)

    def one(n):
        best, best_score = b"", -1.0
        for attempt in range(1, TRIES[kind] + 1):
            pcm = make(n)
            if not hear_key:
                return _trim(pcm)
            try:
                heard = _heard(hear_key, pcm, language)
            except Exception as err:  # noqa: BLE001  (no hearing: her voice as it came)
                _note(event="tts_check_skipped", error=str(err)[:200])
                return _trim(pcm)
            mark = score(pieces[n], heard)
            if mark >= 1.0:
                return _trim(pcm)
            _note(event="tts_retry", engine=kind, attempt=attempt, score=round(mark, 2),
                  text=pieces[n][-60:], heard=heard[-60:])
            if mark > best_score:
                best, best_score = pcm, mark
        return _trim(best)

    with ThreadPoolExecutor(max_workers=WORKERS[kind]) as pool:
        spoken = list(pool.map(one, range(len(pieces))))
    pause = bytes(2 * int(PAUSE * RATE24))
    return wav(pause.join(spoken))


def openai_speech(text, voice, rate="+0%"):
    return speech(text, voice, rate)


def selftest(voice):
    """Two words in this voice: proves the key, the model and the line work. Seconds of voice."""
    data = speech("السلام علیکم", voice)
    return (len(data) - 44) / (2 * RATE24)


async def edge_speech(text, voice, rate="+0%"):
    """Her voice as MP3, from Microsoft's free neural voices."""
    import edge_tts
    out = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
        if chunk.get("type") == "audio":
            out += chunk["data"]
    return bytes(out)
