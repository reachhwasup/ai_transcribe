import os
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from backend.services import tts_service as tts


class VoiceEffectTests(unittest.IsolatedAsyncioTestCase):
    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg required')
    async def test_timeline_fitting_applies_effect_after_synthesis_for_both_engines(self):
        with tempfile.TemporaryDirectory() as folder:
            for engine in ('voxcpm', 'edge-tts'):
                source = os.path.join(folder, f'{engine}.wav')
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', source], check=True, capture_output=True)
                with (
                    patch.object(tts.settings, 'upload_dir', folder),
                    patch.object(tts, '_ensure_pronunciations', AsyncMock()),
                    patch.object(tts, 'generate_segment_audio', AsyncMock(return_value=source)) as synthesize,
                    patch.object(tts, '_build_tempo_cmd', wraps=tts._build_tempo_cmd) as fit,
                ):
                    path, duration = await tts.generate_fitted_segment_audio('Hello', 'male', 1.0, engine=engine, voice_fx='dream')
                self.assertFalse(synthesize.call_args.kwargs['apply_fx'])
                self.assertEqual(synthesize.call_args.kwargs['engine'], engine)
                self.assertEqual(fit.call_args.kwargs['voice_fx'], 'dream')
                self.assertGreater(os.path.getsize(path), 0)
                self.assertGreater(duration, 1.1)  # Dream's echo tail reached the rendered audio.
                self.assertAlmostEqual(duration, tts._probe_duration(shutil.which('ffmpeg'), path))

    async def test_settings_engine_governs_a_default_khmer_voice(self):
        """A plain km-KH-* name is the default voice, not a demand for Edge: the engine chosen
        in Settings decides, so switching to VoxCPM actually takes effect."""
        async def save(path):
            with open(path, 'wb') as audio:
                audio.write(b'test audio')
        for engine, expect_local in (('voxcpm', True), ('edge-tts', False)):
            with (
                tempfile.TemporaryDirectory() as folder,
                patch.object(tts.settings, 'upload_dir', folder),
                patch.object(tts, '_ensure_pronunciations', AsyncMock()),
                patch.object(tts, '_get_active_tts_engine', AsyncMock(return_value=engine)),
                patch.object(tts, '_generate_voxcpm_audio', AsyncMock(return_value='local.wav')) as local,
                patch('edge_tts.Communicate') as edge,
            ):
                edge.return_value.save = AsyncMock(side_effect=save)
                await tts.generate_segment_audio('Hello', voice_name='km-KH-PisethNeural', apply_fx=False)
                self.assertEqual(local.called, expect_local, engine)
                self.assertEqual(edge.called, not expect_local, engine)

    async def test_a_captured_voice_keeps_its_own_engine(self):
        """A profile the user made names the engine its sample was recorded for, and that wins
        over Settings; a built-in profile's engine is only a default."""
        self.assertEqual(tts.profile_engine({'engine': 'voxcpm', 'is_built_in': False}), 'voxcpm')
        self.assertEqual(tts.profile_engine({'engine': 'edge-tts', 'is_built_in': True}), '')
        self.assertEqual(tts.profile_engine({}), '')

    @unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg required')
    async def test_every_effect_renders_at_common_sample_rates(self):
        with tempfile.TemporaryDirectory() as folder:
            for rate in (24000, 44100):
                for style in tts.VOICE_FX_LABELS:
                    source = os.path.join(folder, f'{rate}-{style}.wav')
                    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'sine=frequency=440:sample_rate={rate}:duration=1', source], check=True, capture_output=True)
                    output = await tts._apply_voice_filters(source, 'male', 'neutral', style)
                    self.assertGreater(os.path.getsize(output), 0)
                    duration = tts._probe_duration(shutil.which('ffmpeg'), output)
                    self.assertTrue(0.9 <= duration <= 1.6, (style, rate, duration))

    async def test_voxcpm_passes_effect_to_postprocessing(self):
        with (
            patch.object(tts, '_ensure_pronunciations', AsyncMock()),
            patch.object(tts, '_get_active_tts_engine', AsyncMock(return_value='voxcpm')),
            patch.object(tts, '_generate_voxcpm_audio', AsyncMock(return_value='voice.wav')),
            patch.object(tts, '_apply_voice_filters', AsyncMock(return_value='filtered.wav')) as filters,
        ):
            output = await tts.generate_segment_audio('Hello', voice_fx='phone', emotion='neutral')
        self.assertEqual(output, 'filtered.wav')
        self.assertEqual(filters.call_args.args[-1], 'phone')
