"""Checks of voices.py that need no key and no internet: the voice services are stood in for.

    python3 avatar-flash/test_voices.py
"""
import array
import json
import os
import struct
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
for name in ("OPENAI_API_KEY", "ELEVENLABS_API_KEY", "FLASH_OPENAI_KEY_FILE", "FLASH_ELEVEN_KEY_FILE", "FLASH_TTS_CHECK"):
    os.environ.pop(name, None)
import voices  # noqa: E402

NEWS = ("السلام علیکم۔ آپ دیکھ رہے ہیں ہمارا خبرنامہ۔ سب سے پہلے موسم کا حال۔ آج زیادہ تر علاقوں میں موسم خشک اور "
        "خوشگوار رہنے کی توقع ہے، جبکہ شام کے وقت ہلکی ہوا چل سکتی ہے۔ یہ تھیں آج کی اہم خبریں۔ ہمارے ساتھ رہنے کا "
        "شکریہ۔ اللہ حافظ۔")


def tone(seconds, level=8000):
    """A loud square wave with a little quiet before and after: stands in for a piece of her voice."""
    n = int(seconds * voices.RATE24)
    quiet = array.array("h", [0] * 2400)
    return (quiet + array.array("h", [level, -level] * (n // 2)) + quiet).tobytes()


def test_chunks():
    text = " ".join(f"یہ جملہ نمبر {i} ہے۔" for i in range(200))
    parts = voices.chunks(text, 120)
    assert all(len(p) <= 120 for p in parts), max(map(len, parts))
    assert " ".join(parts).split() == text.split()
    assert all(p.endswith("۔") for p in parts)
    # A sentence longer than a piece is cut after a comma, else between words, never inside a word.
    long = "، ".join(["یہ ایک لمبا جملہ ہے"] * 30) + "۔"
    parts = voices.chunks(long, 100)
    assert all(len(p) <= 100 for p in parts) and " ".join(parts).split() == long.split(), parts[:2]
    words = " ".join(["word"] * 100)
    assert all(len(p) <= 50 and not p.startswith(" ") for p in voices.chunks(words, 50))
    assert " ".join(voices.chunks(words, 50)).split() == words.split()
    assert [len(p) for p in voices.chunks("x" * 260, 100)] == [100, 100, 60]
    assert voices.chunks("  ") == [] and voices.chunks("Hello. World!") == ["Hello. World!"]
    # A short closing line never stands alone, and no piece is far shorter than the rest.
    parts = voices.chunks(NEWS)
    assert " ".join(parts).split() == NEWS.split() and all(len(p) <= voices.PIECE for p in parts)
    assert parts[-1].endswith("اللہ حافظ۔") and len(parts[-1]) > 40, parts
    assert voices.chunks("ایک۔ " * 3) == ["ایک۔ ایک۔ ایک۔"]


def test_engine_and_keys():
    assert voices.engine("saira") == "eleven" and voices.engine("el:hA0RyxVmITMttngSpcOF") == "eleven"
    assert voices.engine("marin") == "openai" and voices.engine("ur-PK-UzmaNeural") == "edge"
    for bad in ("x; rm -rf", "ur-PK-Uzma", "el:short", "el:../../etc", "", "SAIRA"):
        assert voices.engine(bad) is None and not voices.known(bad), bad
    for voice, name in (("saira", "ElevenLabs"), ("marin", "OpenAI")):
        try:
            voices.speech("hi", voice)
            raise AssertionError("spoke without a key")
        except RuntimeError as err:
            assert name in str(err) and "live.sh --key" in str(err)


def test_said():
    good = [("اگلی میٹنگ پیر کی صبح دس بجے ہوگی۔ شکریہ۔", "अगली मीटिंग पीर की सुबह दस बजे होगी। शुक्रिया।"),
            ("ہر ہفتے پیش رفت کا جائزہ لیا جائے گا۔ تیسرا نکتہ: ذمہ داریاں۔", "हर हफ़्ते पेशरफ़्त का जायज़ा लिया जाएगा। तीसरा नुक्ता: ज़िम्मेदारियां।"),
            ("یہ تھیں آج کی اہم خبریں۔ ہمارے ساتھ رہنے کا شکریہ۔ اللہ حافظ۔", "ये थी आज की अहम खबरें। हमारे साथ रहने का शुक्रिया। अल्लाह हाफ़िज़।"),
            ("Today's meeting starts at ten. Thank you.", "Today's meeting starts at 10. Thank you.")]
    bad = [("اگلی میٹنگ پیر کی صبح دس بجے ہوگی۔ شکریہ۔", "अगली मीटिंग पीर की सुबह दस बजे होगी।"),
           ("ہر ہفتے پیش رفت کا جائزہ لیا جائے گا۔ تیسرا نکتہ: ذمہ داریاں۔", "ہر ہفتے پیش رفت کا جائزہ لیا جائے گا۔ Dizyanokta."),
           ("یہ تھیں آج کی اہم خبریں۔ ہمارے ساتھ رہنے کا شکریہ۔ اللہ حافظ۔", "یہ تھیں آج کی اہم خبریں۔ ہمارے ساتھ رہنے کا شکریہ۔"),
           ("Today's meeting starts at ten. Thank you.", "Today's meeting starts at 10."),
           ("یہ تھیں آج کی اہم خبریں۔", "")]
    bad += [("سب سے پہلے موسم کا حال۔", "سب سے پہلے موسم"),              # two short words left out
            ("آج زیادہ تر علاقوں میں موسم خشک رہے گا۔", "آج زیادہ تر علاقوں میں موسم خشک")]
    good += [("سب سے پہلے موسم کا حال۔", "सब से पहले मौसम का हाल।"),
             ("اگلی میٹنگ پیر کی صبح دس بجے ہوگی۔", "اگلی میٹنگ پیر کی صبح دس بجے ہو گی۔")]
    ok = lambda t, h: voices.score(t, h) >= 1
    assert all(ok(t, h) for t, h in good), [(round(voices.score(t, h), 2), voices.said(t, h)) for t, h in good]
    assert not any(ok(t, h) for t, h in bad), [(round(voices.score(t, h), 2), voices.said(t, h)) for t, h in bad]
    assert voices.said("", "anything") == (1.0, 1.0, 1.0)


def test_wav_trim_language():
    pcm = bytes(range(10)) * 100
    w = voices.wav(pcm)
    assert w[:4] == b"RIFF" and w[8:16] == b"WAVEfmt " and w[36:40] == b"data"
    assert struct.unpack("<I", w[4:8])[0] == len(w) - 8 and struct.unpack("<I", w[24:28])[0] == 24000
    loud = tone(0.5)
    trimmed = voices._trim(bytes(48000) + loud + bytes(48000))
    assert len(loud) - 2 * 4800 <= len(trimmed) <= len(loud) + 2 * 2 * int(0.06 * 24000) + 480, len(trimmed)
    assert voices._trim(bytes(4800)) == bytes(4800)
    assert voices._language("یہ اردو ہے") == "ur" and voices._language("यह हिंदी है") == "hi"
    assert voices._language("hello there") is None


class Fake:
    """Stands in for ElevenLabs, OpenAI's voice and its transcriber; counts what was asked."""

    def __init__(self, drop_first=()):
        self.drop_first = set(drop_first)     # pieces whose first making leaves out the last words
        self.lock = threading.Lock()
        self.made, self.bodies, self.heard = {}, [], 0

    def piece_text(self, body):
        return body.get("text") or body.get("input")

    def make(self, body):
        text = self.piece_text(body)
        with self.lock:
            self.bodies.append(body)
            n = self.made[text] = self.made.get(text, 0) + 1
        short = text in self.drop_first and n == 1
        return (text.rsplit(" ", 2)[0] if short else text, tone(0.2 + 0.001 * len(text)))   # last words left out

    def install(self):
        spoken = {}

        def eleven(key, voice_id, body):
            assert key == "el-key" and voice_id == voices.ELEVEN_VOICES["saira"]
            words, pcm = self.make(body)
            spoken[pcm] = words
            return pcm

        def openai(key, body):
            assert key == "oa-key"
            words, pcm = self.make(body)
            spoken[pcm] = words
            return pcm

        def heard(key, pcm, language):
            assert key == "oa-key" and language == "ur"
            with self.lock:
                self.heard += 1
            return spoken[pcm]

        voices._eleven, voices._openai, voices._heard = eleven, openai, heard


def run_speech(voice, keys, drop_first=(), rate="+0%", check=True):
    saved = (voices._eleven, voices._openai, voices._heard, voices.CHECK)
    env = dict(os.environ)
    try:
        os.environ.update(keys)
        voices.CHECK = check
        fake = Fake(drop_first)
        fake.install()
        out = voices.speech(NEWS, voice, rate)
        return fake, out
    finally:
        voices._eleven, voices._openai, voices._heard, voices.CHECK = saved
        os.environ.clear()
        os.environ.update(env)


def test_speech_pieces_in_order():
    pieces = voices.chunks(NEWS)
    assert len(pieces) >= 2, pieces
    fake, out = run_speech("saira", {"ELEVENLABS_API_KEY": "el-key", "OPENAI_API_KEY": "oa-key"})
    assert out[:4] == b"RIFF" and struct.unpack("<I", out[24:28])[0] == 24000
    assert sorted(fake.made) == sorted(pieces) and all(v == 1 for v in fake.made.values())
    assert fake.heard == len(pieces)
    # Pieces come back in the text's order: each piece's tone is longer by its length.
    first = [b for b in fake.bodies if b["text"] == pieces[0]][0]
    assert first["model_id"] == voices.ELEVEN_MODEL and first["language_code"] == "ur"
    assert "previous_text" not in first and first["next_text"] == pieces[1][:300]
    last = [b for b in fake.bodies if b["text"] == pieces[-1]][0]
    assert last["previous_text"] == pieces[-2][-300:] and "next_text" not in last
    assert "voice_settings" not in first
    pause = int(voices.PAUSE * 24000)
    x = array.array("h", out[44:])
    runs, inside, start = [], False, 0
    for i in range(0, len(x), 240):
        loud = any(abs(v) > 1000 for v in x[i:i + 240])
        if loud and not inside:
            inside, start = True, i
        elif not loud and inside:
            inside = False
            runs.append(i - start)
    if inside:
        runs.append(len(x) - start)
    assert len(runs) == len(pieces), (len(runs), len(pieces))
    expect = [int((0.2 + 0.001 * len(p)) * 24000) for p in pieces]
    assert all(abs(r - e) <= 480 for r, e in zip(runs, expect)), (runs, expect)
    assert pause > 0


def test_speech_retries_a_piece_missing_its_end():
    pieces = voices.chunks(NEWS)
    fake, _ = run_speech("saira", {"ELEVENLABS_API_KEY": "el-key", "OPENAI_API_KEY": "oa-key"}, drop_first=[pieces[-1]])
    assert fake.made[pieces[-1]] == 2 and all(fake.made[p] == 1 for p in pieces[:-1])
    fake, _ = run_speech("marin", {"OPENAI_API_KEY": "oa-key"}, drop_first=[pieces[0]], rate="-10%")
    assert fake.made[pieces[0]] == 2
    body = fake.bodies[0]
    assert body["speed"] == 0.9 and "slower" in body["instructions"] and body["response_format"] == "pcm"


def test_speech_without_hearing():
    pieces = voices.chunks(NEWS)
    # ElevenLabs alone (no OpenAI key): no hearing, so no retries.
    fake, _ = run_speech("saira", {"ELEVENLABS_API_KEY": "el-key"}, drop_first=pieces)
    assert fake.heard == 0 and all(v == 1 for v in fake.made.values())
    fake, _ = run_speech("saira", {"ELEVENLABS_API_KEY": "el-key", "OPENAI_API_KEY": "oa-key"}, drop_first=pieces, check=False)
    assert fake.heard == 0 and all(v == 1 for v in fake.made.values())
    fake, _ = run_speech("saira", {"ELEVENLABS_API_KEY": "el-key"}, rate="+10%")
    assert all(b["voice_settings"] == {"speed": 1.1} for b in fake.bodies)


def test_eleven_leaves_out_a_refused_field():
    asked = []

    def post(request, timeout, who):
        body = json.loads(request.data)
        asked.append(sorted(body))
        assert request.get_header("Xi-api-key") == "el-key" and "pcm_24000" in request.full_url
        if "previous_text" in body:
            raise RuntimeError('ElevenLabs answered 400: {"detail": "previous_text is not supported for this model"}')
        return b"\x01\x02\x03"
    saved = voices._post
    voices._post = post
    try:
        pcm = voices._eleven("el-key", "abc", {"text": "x", "model_id": "m", "previous_text": "y"})
    finally:
        voices._post = saved
    assert pcm == b"\x01\x02" and asked == [["model_id", "previous_text", "text"], ["model_id", "text"]]


def test_no_key_in_errors():
    """A refused request's message carries the service's answer, never the key itself."""
    import urllib.error
    import io

    def refuse(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 401, "no", {}, io.BytesIO(b'{"detail": "invalid_api_key"}'))
    saved = voices.urllib.request.urlopen
    voices.urllib.request.urlopen = refuse
    try:
        for call in (lambda: voices._eleven("FAKE-KEY-VALUE-1", "abc", {"text": "x", "model_id": "m"}),
                     lambda: voices._openai("FAKE-KEY-VALUE-2", {"input": "x"})):
            try:
                call()
                raise AssertionError("no error")
            except RuntimeError as err:
                assert "FAKE-KEY" not in str(err) and "401" in str(err), str(err)
    finally:
        voices.urllib.request.urlopen = saved


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} checks of voices.py pass")
