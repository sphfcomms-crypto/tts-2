import unittest
from unittest.mock import Mock

import numpy as np

from phones import A, E, FV, I, MBP, NEUTRAL, O, PHONES, REST, S, U, PhoneModel, _features, _mouth


class AcousticTests(unittest.TestCase):
    def setUp(self):
        self.model = PhoneModel.__new__(PhoneModel)
        self.model._model = Mock()
        groups = np.zeros((4, len(PHONES)), np.float32)
        groups[[1, 2, 3], [MBP, I, NEUTRAL]] = 1
        self.model._groups = groups

    def test_visible_articulation_not_language_orthography(self):
        for symbol, shape in (("m", MBP), ("pʰ", MBP), ("b̤", MBP), ("f", FV),
                              ("ʋ", FV), ("ɑː", A), ("ɛ", E), ("iː", I),
                              ("ɔ", O), ("uː", U), ("ʃ", S), ("ɽ", NEUTRAL)):
            self.assertEqual(_mouth(symbol), shape)

    def test_silent_render_interval_with_voiced_context_never_runs_classifier(self):
        x = np.r_[np.full(3200, .15), np.zeros(6400), np.full(1600, .1)].astype(np.float32)
        w = self.model.weights(x, 3200, 10)
        np.testing.assert_array_equal(w[:, REST], 1)
        self.model._model.run.assert_not_called()
        self.assertEqual(self.model.weights(np.empty(0), 0, 0).shape, (0, len(PHONES)))

    def test_arbitrary_lead_and_short_final_frame(self):
        def vowel(_, inputs):
            n = len(inputs["mfcc"])
            logits = np.zeros((n, 1, 4), np.float32)
            logits[:, :, 2] = 10
            return [logits]
        self.model._model.run.side_effect = vowel
        x = np.sin(np.arange(3200) * .08).astype(np.float32) * .2
        weights = self.model.weights(x, 1573, 3)
        self.assertEqual(weights.shape, (3, len(PHONES)))
        np.testing.assert_allclose(weights.sum(1), 1, atol=1e-6)
        self.assertTrue(np.all(weights.argmax(1) == I))
        self.assertTrue(np.isfinite(_features(np.array([.03], np.float32))).all())
        with self.assertRaises(ValueError):
            self.model.weights(np.array([np.nan]), 0, 1)


if __name__ == "__main__":
    unittest.main()
