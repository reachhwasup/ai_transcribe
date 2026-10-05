import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import soundfile as sf

from backend.services import video_service as vs


class MaxBgmCleanupTests(unittest.TestCase):
    def test_missed_speech_is_suppressed_without_restoring_it_as_an_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sr = 16000
            times = np.arange(sr * 2) / sr
            music = 0.2 * np.sin(2 * np.pi * 110 * times)
            voice = 0.3 * np.sin(2 * np.pi * 1000 * times)
            sf.write(root / 'bgm.flac', music + 0.3 * voice, sr, subtype='PCM_16')
            sf.write(root / 'vocals.flac', voice, sr, subtype='PCM_16')
            original = (root / 'bgm.flac').read_bytes()
            # Simulate a voice region entirely missed by VAD.
            (root / 'stems.json').write_text(json.dumps({'bgm_clean': 'off', 'speech': [], 'keep_effects': True}))
            vs.clean_bgm(folder, 'strong', keep_effects=False)
            strong, _ = sf.read(root / 'bgm.flac')
            vs.clean_bgm(folder, 'max', keep_effects=True)
            maximum, actual_sr = sf.read(root / 'bgm.flac')
            self.assertEqual(actual_sr, sr)
            self.assertEqual(len(maximum), len(music))
            self.assertTrue(np.isfinite(maximum).all())
            self.assertFalse(vs.bgm_keeps_effects(folder))
            freqs = np.fft.rfftfreq(sr, 1 / sr)
            voice_bin = np.argmin(abs(freqs - 1000))
            music_bin = np.argmin(abs(freqs - 110))
            strong_fft = abs(np.fft.rfft(strong[sr // 2:sr + sr // 2]))
            max_fft = abs(np.fft.rfft(maximum[sr // 2:sr + sr // 2]))
            self.assertLess(max_fft[voice_bin], strong_fft[voice_bin] * 0.1)
            self.assertGreater(max_fft[music_bin], strong_fft[music_bin] * 0.8)
            vs.clean_bgm(folder, 'off', keep_effects=False)
            self.assertEqual((root / 'bgm.flac').read_bytes(), original)


class MaxKeepsTheEffectsChoiceTests(unittest.TestCase):
    def test_leaving_max_brings_sound_effects_back(self):
        import json
        import os
        import numpy as np
        import soundfile as sf
        from backend.services import video_service as vs

        folder = tempfile.mkdtemp()
        sr = 44100
        tone = (0.05 * np.sin(2 * np.pi * 110 * np.arange(sr * 2) / sr))[:, None].repeat(2, 1).astype(np.float32)
        sf.write(os.path.join(folder, "bgm.flac"), tone, sr, subtype="PCM_16")
        sf.write(os.path.join(folder, "vocals.flac"), tone * 0.5, sr, subtype="PCM_16")
        with open(os.path.join(folder, "stems.json"), "w") as f:
            json.dump({"bgm_clean": "off", "speech": [[0.0, 0.5]]}, f)

        vs.clean_bgm(folder, "light", keep_effects=True)
        vs.clean_bgm(folder, "max")
        self.assertFalse(vs.bgm_keeps_effects(folder))   # off while on Max
        vs.clean_bgm(folder, "light")
        self.assertTrue(vs.bgm_keeps_effects(folder))    # the choice made before Max is back
