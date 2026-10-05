import json
import subprocess
import tempfile
import unittest
import wave
from array import array
from pydantic import ValidationError
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from backend.database.db import Base
from backend.database.models import Project, Segment, AppSetting
from backend.api.routes.voice_generation import capture_voice, CaptureVoiceRequest
from backend.api.routes.settings import create_voice_group, VoiceGroupCreate, update_voice_profile, VoiceProfileUpdate, list_voice_groups
from backend.config import settings
from backend.services.voice_capture import voice_waveform, full_voice_waveform, extract_voice_sample, VoiceEQ


class CaptureVoiceTest(unittest.IsolatedAsyncioTestCase):
    async def test_capture_assign_and_reject_invalid_ranges(self):
        with tempfile.TemporaryDirectory() as tmp:
            movie = str(Path(tmp) / 'movie.wav')
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                            'sine=frequency=440:duration=6', movie], check=True)
            peaks = voice_waveform(movie, 1, 4)
            self.assertEqual(len(peaks), 600)
            overview = full_voice_waveform(movie, Path(movie).stat().st_mtime_ns, 6)
            self.assertEqual(len(overview), 1200)
            self.assertTrue(all(0 < peak <= 1 for peak in overview))
            self.assertTrue(all(0 < peak <= 1 for peak in peaks))
            engine = create_async_engine('sqlite+aiosqlite:///:memory:')
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            try:
                async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                    db.add(Project(id='movie', name='Movie', video_path=movie, duration=6))
                    db.add(Segment(id='line', project_id='movie', index=0, start_time=0,
                                   end_time=4, speaker='Hero', audio_url='/old.wav'))
                    await db.commit()
                    group = await create_voice_group(VoiceGroupCreate(name='Heroes'), db)
                    self.assertEqual((await list_voice_groups(db))[0]['id'], group['id'])
                    with self.assertRaises(HTTPException) as duplicate:
                        await create_voice_group(VoiceGroupCreate(name=' heroes '), db)
                    self.assertEqual(duplicate.exception.status_code, 409)
                    with patch.object(settings, 'upload_dir', tmp):
                        for start, end in [(0, 2), (-1, 4), (0, 7), (float('nan'), 4)]:
                            with self.assertRaises(HTTPException) as error:
                                await capture_voice('movie', CaptureVoiceRequest(
                                    name='Hero', start_time=start, end_time=end), db)
                            self.assertEqual(error.exception.status_code, 400)
                        result = await capture_voice('movie', CaptureVoiceRequest(
                            name='Hero', start_time=1, end_time=5, speaker='Hero', group_id=group['id'], eq=VoiceEQ(enabled=True, mud=-12)), db)
                    profile = result['profile']
                    self.assertEqual(result['assigned_segments'], 1)
                    self.assertEqual(profile['engine'], 'voxcpm')
                    self.assertEqual(profile['eq']['mud'], -12)
                    self.assertEqual(profile['group_id'], group['id'])
                    segment = await db.get(Segment, 'line')
                    self.assertEqual(segment.voice_name, profile['id'])
                    self.assertEqual(segment.audio_url, '')
                    saved = await db.get(AppSetting, 'custom_voice_profiles')
                    self.assertEqual(json.loads(saved.value)[0]['id'], profile['id'])
                    with self.assertRaises(HTTPException):
                        await update_voice_profile(profile['id'], VoiceProfileUpdate(group_id='missing'), db)
                    moved = await update_voice_profile(profile['id'], VoiceProfileUpdate(group_id=''), db)
                    self.assertEqual(moved['group_id'], '')
                    sample = Path(tmp) / profile['sample_audio_url'].removeprefix('/uploads/')
                    with wave.open(str(sample)) as wav:
                        eq_samples = array('h', wav.readframes(wav.getnframes()))
                        self.assertEqual(wav.getnchannels(), 1)
                        self.assertEqual(wav.getframerate(), 24000)
                        self.assertAlmostEqual(wav.getnframes() / wav.getframerate(), 4, places=1)
                    dry_path = str(Path(tmp) / 'dry.wav')
                    extract_voice_sample(movie, dry_path, 1, 5)
                    with wave.open(dry_path) as dry:
                        dry_samples = array('h', dry.readframes(dry.getnframes()))
                    self.assertLess(sum(v * v for v in eq_samples), sum(v * v for v in dry_samples) * 0.5)
                    for invalid in [float('nan'), float('inf'), 13]:
                        with self.assertRaises(ValidationError):
                            VoiceEQ(warmth=invalid)
            finally:
                await engine.dispose()


if __name__ == '__main__':
    unittest.main()
