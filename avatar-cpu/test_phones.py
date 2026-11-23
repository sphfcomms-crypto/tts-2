import unittest
from threading import BoundedSemaphore, local
from unittest.mock import Mock

import numpy as np

from phones import (A, E, FV, I, MBP, NEUTRAL, O, PHONES, REST, S, U,
                    PhoneModel, _articulation_map, _features, _mouth, _project_articulation)


class AcousticTests(unittest.TestCase):
    def setUp(self):
        self.model = PhoneModel.__new__(PhoneModel)
        self.model._model = Mock()
        self.model._request = local()
        self.model._accurate = None
        self.model._accurate_slots = BoundedSemaphore(2)
        self.model._retry_at = 0
        groups = np.zeros((4, len(PHONES)), np.float32)
        groups[[1, 2, 3], [MBP, I, NEUTRAL]] = 1
        self.model._groups = groups

    def test_visible_articulation_not_language_orthography(self):
        for symbol, shape in (("m", MBP), ("pʰ", MBP), ("b̤", MBP), ("f", FV),
                              ("ʋ", FV), ("ɑː", A), ("ɛ", E), ("iː", I),
                              ("ɔ", O), ("uː", U), ("ʃ", S), ("ɽ", NEUTRAL)):
            self.assertEqual(_mouth(symbol), shape)

    def test_silent_render_interval_with_voiced_context_never_runs_classifier(self):
        self.model._accurate = Mock()
        x = np.r_[np.full(3200, .15), np.zeros(6400), np.full(1600, .1)].astype(np.float32)
        w = self.model.weights(x, 3200, 10)
        np.testing.assert_array_equal(w[:, REST], 1)
        self.model._model.run.assert_not_called()
        self.model._accurate.run.assert_not_called()
        self.assertEqual(self.model.last_backend, "rest")
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

    def test_sparse_seal_open_vowel_and_quiet_fricative_remain_distinct(self):
        # CTC landmarks measured in two overlapping 200/400/100ms call chunks.
        centers = 3200 + 640 * np.arange(10) + 320
        first = np.zeros((34, len(PHONES)), np.float32)
        first[26, A], first[30, MBP] = .49, .97
        a = _project_articulation(first, centers, np.ones(10))
        self.assertGreater(a[9, MBP], .97)
        self.assertGreater(a[7, A], .75)
        second = np.zeros_like(first)
        second[10, MBP], second[14, S], second[19, A], second[28, FV] = .98, .98, .37, .92
        activity = np.ones(10)
        activity[9] = .03
        b = _project_articulation(second, centers, activity)
        self.assertGreater(b[5, A], .90)
        self.assertGreater(b[9, FV], .90)
        np.testing.assert_allclose(b.sum(axis=1), 1, atol=1e-6)
        activity[9] = 0
        self.assertEqual(_project_articulation(second, centers, activity)[9, REST], 1)

    def test_accurate_backend_busy_or_failed_uses_compact_on_same_request(self):
        vocab = {"<pad>": 0, "m": 1, "i": 2, "k": 3}
        accurate = self.model._accurate = Mock()
        self.model._accurate_groups = _articulation_map(vocab)
        x = np.sin(np.arange(6400) * .08).astype(np.float32) * .2
        accurate.run.return_value = [np.tile([[[0., 0., 8., 0.]]], (1, 19, 1))]
        def compact(_, inputs):
            return [np.tile([[[0., 0., 8., 0.]]], (len(inputs["mfcc"]), 1, 1))]
        self.model._model.run.side_effect = compact
        self.assertTrue(np.all(self.model.weights(x, 0, 10).argmax(axis=1) == I))
        self.assertEqual(self.model.last_backend, "wav2vec2+uni2005")
        with self.model._accurate_slots, self.model._accurate_slots:
            self.model.weights(x, 0, 10)
            self.assertEqual(self.model.last_backend, "uni2005")
        accurate.run.side_effect = RuntimeError("offline")
        with self.assertLogs(level="ERROR"):
            self.model.weights(x, 0, 10)
        self.assertEqual(self.model.last_backend, "uni2005")
        self.model.weights(x, 0, 10)
        self.assertEqual(accurate.run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
