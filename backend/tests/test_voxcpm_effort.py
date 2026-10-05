import asyncio
import unittest
from unittest.mock import patch

from backend.services import tts_service as t


class VoxcpmEffortTest(unittest.IsolatedAsyncioTestCase):
    """Cloned voices ask less of the machine: fewer retakes when light, memory freed when idle."""

    def setUp(self):
        self.saved = (t._voxcpm_model, t._voxcpm_in_use, t._voxcpm_unload_timer)
        self.addCleanup(self.restore)

    def restore(self):
        if t._voxcpm_unload_timer is not None and t._voxcpm_unload_timer is not self.saved[2]:
            t._voxcpm_unload_timer.cancel()
        t._voxcpm_model, t._voxcpm_in_use, t._voxcpm_unload_timer = self.saved

    def test_the_light_setting_allows_one_retake_and_the_others_two(self):
        self.assertEqual([t.voxcpm_takes(n) for n in (6, 10, 15, 30)], [2, 2, 3, 3])

    def test_the_model_is_let_go_only_when_nothing_is_using_it(self):
        t._voxcpm_model, t._voxcpm_in_use = object(), 1
        self.assertFalse(t.unload_voxcpm())
        self.assertIsNotNone(t._voxcpm_model)
        t._voxcpm_in_use = 0
        self.assertTrue(t.unload_voxcpm())
        self.assertIsNone(t._voxcpm_model)
        self.assertFalse(t.unload_voxcpm())          # nothing left to free

    async def test_each_use_restarts_the_idle_countdown(self):
        t._voxcpm_model, t._voxcpm_in_use, t._voxcpm_unload_timer = object(), 0, None

        async def take(*args):
            self.assertEqual(t._voxcpm_in_use, 1)     # counted as in use while it speaks
            return "voice.wav"
        with patch.object(t, "_voxcpm_take", take), patch.object(t, "VOXCPM_IDLE_SECONDS", 0.05):
            self.assertEqual(await t._generate_voxcpm_audio("សួស្តី"), "voice.wav")
            first = t._voxcpm_unload_timer
            await t._generate_voxcpm_audio("សួស្តី")
            self.assertTrue(first.cancelled())
            self.assertIsNotNone(t._voxcpm_model)     # still within the countdown
            await asyncio.sleep(0.12)
        self.assertIsNone(t._voxcpm_model)

    async def test_a_failed_take_still_counts_the_use_as_over(self):
        t._voxcpm_in_use = 0

        async def boom(*args):
            raise RuntimeError("out of memory")
        with patch.object(t, "_voxcpm_take", boom):
            with self.assertRaises(RuntimeError):
                await t._generate_voxcpm_audio("សួស្តី")
        self.assertEqual(t._voxcpm_in_use, 0)


if __name__ == "__main__":
    unittest.main()
