"""Run from the prepared GPU service directory with venv/bin/python test_mouth_rest.py."""
import unittest
import tempfile
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np

from server import Bilabials, Engine, articulation_timing, bilabial_gate, silence_gate, source_lip_rest


class MouthRestTest(unittest.TestCase):
    def test_bilabial_contact_straddles_chunk_boundary(self):
        # Identical acoustic spike viewed at different offsets inside the context.
        peak = 5 * 640 + 200
        full = bilabial_gate([peak], 0, 10)
        np.testing.assert_allclose(full, [0, 0, 0, .36, .985, .40, 0, 0, 0, 0])
        np.testing.assert_array_equal(bilabial_gate([peak], 0, 5), full[:5])
        np.testing.assert_array_equal(bilabial_gate([peak - 3 * 640], 2 * 640, 5), full[5:])
        self.assertIsNone(bilabial_gate([peak], 10 * 640, 1))

    def test_terminal_or_quiet_audio_needs_no_phone_inference(self):
        detector = Bilabials.__new__(Bilabials)
        self.assertIsNone(detector.gate(np.full(639, .4, np.float32), 0, 1))
        self.assertIsNone(detector.gate(np.full(16_000, .001, np.float32), 0, 25))

    def test_optional_phone_model_can_be_unavailable(self):
        self.assertIsNone(Bilabials.load("", "cuda"))
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(Bilabials, "__init__", side_effect=OSError("incomplete model")):
                self.assertIsNone(Bilabials.load(folder, "cuda"))

    def test_optional_model_failure_preserves_the_current_and_later_calls(self):
        engine = Engine.__new__(Engine)
        detector = Mock()
        engine.bilabials = detector
        detector.gate.side_effect = RuntimeError("device unavailable")
        job = SimpleNamespace(wav16=None, voice_start=320, n_frames=2, gate=np.array([0.0, 1.0]))
        self.assertIs(engine.mouth_gate(job), job.gate)
        self.assertIs(engine.mouth_gate(job), job.gate)
        detector.gate.assert_called_once_with(None, 320, 2)
        self.assertIsNone(engine.bilabials)

    def test_contact_preserves_original_pause_strength(self):
        engine = Engine.__new__(Engine)
        engine.bilabials = Mock()
        engine.bilabials.gate.return_value = np.array([0.0, .985, .40])
        job = SimpleNamespace(wav16=None, voice_start=0, n_frames=3, gate=np.array([1., 0., .5]))
        np.testing.assert_allclose(engine.mouth_gate(job), [1., .985, .5])
        np.testing.assert_array_equal(job.gate, [1., 0., .5])

    def test_calibration_uses_recorded_context_across_a_chunk_join(self):
        x = np.full(640 * 17, 0.09, np.float32)
        x[640 * 2:640 * 10] = 0
        steps, gate = articulation_timing(x, 0, 17, 1)
        self.assertEqual(steps, -2)
        self.assertEqual(gate[0], 1)
        # The middle of a chunk and its tail must have the same positions
        # and gates as the same recording submitted as a single clip.
        steps, mid = articulation_timing(x[640:640 * 16], 4 * 640, 8, 1)
        self.assertEqual(steps, 6)
        np.testing.assert_array_equal(mid, gate[5:13])
        self.assertEqual(gate[6], 1)
        self.assertEqual(articulation_timing(x[:643], 320, 1, 1)[0], -1)

    def test_optional_calibration_and_one_frame_terminal_audio(self):
        x = np.full(619, 0.1, np.float32)
        self.assertEqual(articulation_timing(x, 0, 1, 1), (0, None))
        voice = np.pad(x, (640, 0))
        steps, gate = articulation_timing(voice, 640, 1, 0)
        self.assertEqual(steps, 2)
        np.testing.assert_array_equal(gate, silence_gate(voice, 640, 1))

    def test_calibration_preserves_partial_final_frame_body_and_sound(self):
        x = np.linspace(-0.2, 0.2, 7311, dtype=np.float32)
        clip = SimpleNamespace(cycle=240)
        def make(delay):
            with patch("server.ARTICULATION_DELAY", delay):
                return Engine.make_job(None, clip, 247, x, 24000, 120, 47, True, None, 0)
        original, corrected = make(0), make(1)
        self.assertEqual(corrected.start, original.start)
        self.assertEqual(corrected.n_frames, original.n_frames)
        self.assertEqual(corrected.seconds, original.seconds)
        self.assertEqual(corrected.lead_steps, original.lead_steps - 2)
        np.testing.assert_array_equal(corrected.wav16, original.wav16)
        np.testing.assert_array_equal(corrected.pcm48, original.pcm48)

    def test_tilt_does_not_change_the_measured_gap(self):
        lm = np.zeros((3, 68, 2), dtype=np.float32)
        lm[:, 54] = [40, 0]
        lm[1, 67] = [0, 4]  # one side of the source mouth is visibly open
        lm[2, 54] = [0, 0]  # missing face
        rot = np.array([[0.8, -0.6], [0.6, 0.8]], dtype=np.float32)
        np.testing.assert_allclose(source_lip_rest(lm @ rot), [1, 0, 0])

    def test_rising_onset_and_a_short_inner_word_gap(self):
        samples = np.full(640 * 12, 0.08, np.float32)
        samples[:320] = 0.001
        samples[4 * 640:6 * 640] = 0
        gate = silence_gate(samples, 0, 12)
        with_lead = np.pad(samples, (5 * 640, 0))
        np.testing.assert_array_equal(silence_gate(with_lead, 5 * 640, 12), gate)
        self.assertGreater(gate[0], 0.9)
        np.testing.assert_array_equal(gate[1:], 0)
        self.assertIsNone(silence_gate(samples, 640, 11))

    def test_gentle_release_is_limited_to_the_quiet_rising_frame(self):
        samples = np.full(640 * 8, 0.08, np.float32)
        samples[:320] = 0.001
        samples[320:640] = 0.006
        samples[640:1280] = 0.012
        gate = silence_gate(samples, 0, 8)
        self.assertGreater(gate[0], gate[1])
        self.assertGreater(gate[1], 0)
        self.assertLess(gate[1], 0.6)
        np.testing.assert_array_equal(gate[2:], 0)

    def test_pause_returns_to_rest_without_spending_context_frames(self):
        samples = np.full(640 * 14, 0.08, np.float32)
        samples[3 * 640:10 * 640] = 0
        full = silence_gate(samples, 0, 14)
        chunk = silence_gate(samples, 640, 10)
        self.assertEqual(full[6], 1)
        np.testing.assert_array_equal(chunk, full[1:11])


if __name__ == "__main__":
    unittest.main()
