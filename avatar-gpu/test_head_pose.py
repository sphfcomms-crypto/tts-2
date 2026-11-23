"""Run with the GPU service's Python or an environment with OpenCV and NumPy."""
from pathlib import Path
import tempfile
import unittest

import numpy as np

from head_pose import apply_angles, geometry_for


class HeadPoseTest(unittest.TestCase):
    def setUp(self):
        random = np.random.default_rng(17)
        self.yuv = random.integers(0, 256, size=(1080, 960), dtype=np.uint8)
        self.points = np.array([470., 140., 122., 181., 219.], dtype=np.float32)

    def test_zero_and_nonfinite_pose_leave_all_planes_bit_exact(self):
        original = self.yuv.copy()
        for angles in ([0, 0, 0], [np.nan, 0., 1.], [0., np.inf, 0.]):
            self.assertFalse(apply_angles(self.yuv, self.points, np.array(angles)))
        np.testing.assert_array_equal(self.yuv, original)

    def test_rigid_head_moves_and_torso_keeps_original_luma_and_chroma(self):
        original = self.yuv.copy()
        self.assertTrue(apply_angles(self.yuv, self.points, np.array([1., 2., 1.])))
        self.assertTrue(np.any(self.yuv[50:200, 440:505] != original[50:200, 440:505]))
        np.testing.assert_array_equal(self.yuv[325:720], original[325:720])
        for before, after in zip(original[720:].reshape(2, 360, 480), self.yuv[720:].reshape(2, 360, 480)):
            self.assertTrue(np.any(before[25:100, 220:252] != after[25:100, 220:252]))
            np.testing.assert_array_equal(after[165:], before[165:])

    def test_angles_are_bounded(self):
        original = self.yuv.copy()
        apply_angles(original, self.points, np.array([20., -30., 99.]))
        apply_angles(self.yuv, self.points, np.array([2.4, -2.4, 2.4]))
        np.testing.assert_array_equal(self.yuv, original)

    def test_geometry_is_bound_to_the_same_take_frame_count_and_image_size(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / "test.npz"
            points = np.tile(self.points, (6, 1))
            np.savez(archive, oa1_talk_ask=points, oa1_talk_ask_sha256="original")
            meta = dict(name="oa1_talk_ask", width=960, height=720, frames=6, source_sha256="original")
            np.testing.assert_array_equal(geometry_for(meta, archive), points)
            for override in (dict(source_sha256="stale"), dict(frames=5), dict(width=720), dict(name="talk")):
                self.assertIsNone(geometry_for({**meta, **override}, archive))
            archive.write_bytes(b"PK\x03\x04" + bytes(32))
            self.assertIsNone(geometry_for(meta, archive))


if __name__ == "__main__":
    unittest.main()
