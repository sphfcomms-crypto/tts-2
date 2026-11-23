"""Audio-driven weights for the filmed MuseTalk mouth atlas, at 25 fps."""
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort
from scipy.fft import dct, rfft
from scipy.signal import resample_poly


PHONES = ("REST", "MBP", "FV", "A", "E", "I", "O", "U", "S", "neutral")
REST, MBP, FV, A, E, I, O, U, S, NEUTRAL = range(len(PHONES))
FRAME = 640  # original mono 16 kHz samples in a 25 fps frame
MODEL_FILE = "uni2005-int8.onnx"


def _mouth(symbol):
    # IPA place of articulation. Tongue-only movements take the base shape.
    # Aspirated, long, and breathy stops share their visible lip contact.
    c = symbol[0]
    if c in "mpbɓ" or symbol == "ŋ͡m":
        return MBP
    if c in "fvʋɱ":
        return FV
    if c in "aɑɐäæʌḁ":
        return A
    if c in "eɛ":
        return E
    if c in "iɪɨj":
        return I
    if c in "oɔɒɵøœ":
        return O
    if c in "uʊʉyʏwɥ":
        return U
    if c in "szʃʒɕʑʂʐθð" or symbol.startswith(("ts", "tʂ", "tʃ", "tɕ", "t͡", "dʒ", "d͡")):
        return S
    return NEUTRAL


def _mel_bank():
    # 40 triangular filters between 40 and 3800 Hz in the model's 8 kHz audio.
    freq = np.fft.rfftfreq(256, 1 / 8000)
    mel = 1127 * np.log1p(freq / 700)
    knots = np.linspace(1127 * np.log1p(40 / 700), 1127 * np.log1p(3800 / 700), 42)
    up = (mel[:, None] - knots[:-2]) / np.diff(knots)[:-1]
    down = (knots[2:] - mel[:, None]) / np.diff(knots)[1:]
    return np.maximum(0, np.minimum(up, down)).astype(np.float32)


_MEL = _mel_bank()
_WINDOW = np.hanning(200).astype(np.float32) ** .85
_LIFTER = (1 + 11 * np.sin(np.pi * np.arange(40) / 22)).astype(np.float32)


def _features(samples):
    audio = resample_poly(samples, 1, 2) * 32768
    if len(audio) < 200:
        audio = np.pad(audio, (0, 200 - len(audio)))
    frames = np.lib.stride_tricks.sliding_window_view(audio, 200)[::80].copy()
    frames -= frames.mean(axis=1, keepdims=True)
    frames[:, 1:] -= .97 * frames[:, :-1]
    frames[:, 0] *= .03
    power = np.abs(rfft(frames * _WINDOW, n=256)) ** 2
    # Zero-energy filters in the reference frontend take log(machine epsilon).
    banks = power @ _MEL
    features = dct(np.log(np.where(banks > 0, banks, np.finfo(float).eps)),
                   type=2, axis=1, norm="ortho").astype(np.float32)
    features *= _LIFTER
    features -= features.mean(axis=0)
    features /= np.maximum(features.std(axis=0), 1e-5)
    stack = np.concatenate((np.roll(features, 1, axis=0), features,
                            np.roll(features, -1, axis=0)), axis=1)
    return np.ascontiguousarray(stack[:, None, :], dtype=np.float32)


def _activity(samples, centers):
    # An empty or digitally silent frame remains the genuine shut-mouth take.
    # Use the same clock and amount of available sound at every chunk boundary.
    power = np.r_[0., np.cumsum(np.square(samples, dtype=np.float64))]
    left = np.clip(centers - FRAME // 2, 0, len(samples))
    right = np.clip(centers + FRAME // 2, 0, len(samples))
    rms = np.sqrt((power[right] - power[left]) / np.maximum(1, right - left))
    return np.clip((rms - .0015) / .0065, 0, 1).astype(np.float32)


class PhoneModel:
    def __init__(self, model_directory, threads=2):
        path = Path(model_directory) / MODEL_FILE
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, int(threads))
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self._model = ort.InferenceSession(str(path), sess_options=options,
                                           providers=["CPUExecutionProvider"])
        meta = self._model.get_modelmeta().custom_metadata_map
        labels = json.loads(meta["ipa"])
        if len(labels) != 230 or labels[0] != "<blank>":
            raise ValueError("unexpected uni2005 phone inventory")
        self._groups = np.zeros((len(labels), len(PHONES)), np.float32)
        for i, symbol in enumerate(labels[1:], 1):
            self._groups[i, _mouth(symbol)] = 1

    def weights(self, samples16k_float32, lead_samples, n_frames):
        """The first output is for [lead_samples, lead_samples + 640).

        Both real past and future context are in samples. No new leading audio
        is manufactured. A partial final video frame uses its available samples.
        """
        pcm = np.asarray(samples16k_float32, dtype=np.float32)
        if pcm.ndim != 1 or n_frames < 0 or not 0 <= lead_samples <= len(pcm):
            raise ValueError("invalid mono 16 kHz PCM, lead or frame count")
        if not np.isfinite(pcm).all():
            raise ValueError("non-finite PCM")
        out = np.zeros((n_frames, len(PHONES)), np.float32)
        out[:, REST] = 1
        if n_frames == 0 or not len(pcm) or np.max(np.abs(pcm)) < .0015:
            return out

        # Reserve the neighboring audio only once. For large /speak jobs the
        # recurrent recognizer and CMVN work on bounded sequences.
        for first in range(0, n_frames, 90):
            count = min(90, n_frames - first)
            start = int(lead_samples) + first * FRAME
            left = max(0, start - 3200)
            right = min(len(pcm), start + count * FRAME + 3200)
            if left < right:
                out[first:first + count] = self._block(pcm[left:right], start - left, count)
        return out

    def _block(self, samples, start, n):
        centers = start + FRAME * np.arange(n) + FRAME // 2
        activity = _activity(samples, centers)
        weights = np.zeros((n, len(PHONES)), np.float32)
        weights[:, REST] = 1
        if not np.any(activity):
            return weights
        # The trained recognizer sees one stacked window every 30 ms.
        # Run the three 10 ms phases so a very short b/p release cannot
        # disappear just because it is on the edge of the nominal stride.
        all_features = _features(samples)
        posterior = np.empty((len(all_features), len(self._groups)), np.float32)
        for phase in range(min(3, len(all_features))):
            x = np.ascontiguousarray(all_features[phase::3])
            logits = self._model.run(["logits"], {"mfcc": x})[0][:, 0]
            prob = np.exp(logits - logits.max(axis=1, keepdims=True))
            posterior[phase::3] = prob / prob.sum(axis=1, keepdims=True)
        groups = posterior @ self._groups
        stamp = np.arange(len(groups)) * 160 + 200
        # CTC blank often occupies the interval between two real sounds. Blend
        # nearby nonblank evidence through it instead of shutting the jaw there.
        distance = (centers[:, None] + 160 - stamp) / 460.
        influence = np.exp(-.5 * distance ** 2).astype(np.float32)
        shape = influence @ groups
        # With little acoustic evidence use the voiced natural mouth.
        shape[:, NEUTRAL] += .165
        # Limit simultaneous incompatible shapes, especially on visible teeth.
        best_two = np.argsort(shape, axis=1)[:, -2:]
        selected = np.zeros_like(shape)
        np.put_along_axis(selected, best_two, np.take_along_axis(shape, best_two, axis=1), axis=1)
        selected **= 1.45
        selected /= np.maximum(selected.sum(axis=1, keepdims=True), 1e-9)
        weights = selected * activity[:, None]
        weights[:, REST] += 1 - activity

        # A bilabial has already sealed before the acoustic release. Preserve
        # an actual brief contact even when it straddles two rendered requests.
        top_nonblank = 1 + posterior[:, 1:].argmax(axis=1)
        plausible = ((groups[:, MBP] >= .20) & (posterior[:, 0] < .65) &
                     (self._groups[top_nonblank, MBP] > 0))
        for i in np.flatnonzero((groups[:, MBP] >= .80) | plausible):
            contact = (int(stamp[i]) - start + FRAME // 2) // FRAME - 1
            # Nasals can be ambiguous, especially in 8-bit telephone audio.
            # Partial evidence brings the lips nearer without forcing a seal.
            strength = .99 if groups[i, MBP] >= .80 else .42 + .60 * groups[i, MBP]
            for frame, amount in ((contact - 1, .28 * strength),
                                  (contact, strength), (contact + 1, .32 * strength)):
                if 0 <= frame < n and activity[frame] > 0:
                    old = weights[frame, MBP]
                    if amount > old:
                        weights[frame] *= (1 - amount) / (1 - old)
                        weights[frame, MBP] = amount
        return weights
