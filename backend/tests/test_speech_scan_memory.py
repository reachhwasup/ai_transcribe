import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import soundfile as sf
from backend.services import speech_align as speech


class SpeechScanMemoryTests(unittest.TestCase):
    def test_blocked_energy_and_activity_match_full_decode(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'voice.wav')
            sr = 8000
            rng = np.random.default_rng(42)
            # Cross a 30-second decode boundary and include an incomplete last frame.
            sf.write(path, rng.normal(0, 0.05, (sr * 91 + 37, 2)), sr)
            audio, _ = sf.read(path, dtype='float32', always_2d=True)
            hop = int(sr * speech.FRAME_SECONDS)
            mono = audio.mean(axis=1)
            frames = len(mono) // hop
            expected = 10 * np.log10((mono[:frames * hop].reshape(frames, hop) ** 2).mean(axis=1) + 1e-9)
            actual = speech._frame_energy_db(path)
            np.testing.assert_allclose(actual, expected, atol=1e-6)
            half = max(1, int(speech.FLOOR_WINDOW_SECONDS / speech.FRAME_SECONDS))
            floor = np.percentile(np.lib.stride_tricks.sliding_window_view(np.pad(expected, half, mode='edge'), 2 * half + 1)[:frames], 20, axis=1)
            np.testing.assert_array_equal(speech._frame_activity(path, actual), expected > floor + speech.ACTIVE_MARGIN_DB)
            with patch.object(speech, '_frame_energy_db', wraps=speech._frame_energy_db) as decode:
                speech.detect_speech_regions(path, 20)
                self.assertEqual(decode.call_count, 1)
