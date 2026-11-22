"""Run from the prepared GPU service directory with venv/bin/python test_mouth_rest.py."""
import unittest

import numpy as np

from server import silence_gate, source_lip_rest


class MouthRestTest(unittest.TestCase):
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

    def test_pause_returns_to_rest_without_spending_context_frames(self):
        samples = np.full(640 * 14, 0.08, np.float32)
        samples[3 * 640:10 * 640] = 0
        full = silence_gate(samples, 0, 14)
        chunk = silence_gate(samples, 640, 10)
        self.assertEqual(full[6], 1)
        np.testing.assert_array_equal(chunk, full[1:11])


if __name__ == "__main__":
    unittest.main()
