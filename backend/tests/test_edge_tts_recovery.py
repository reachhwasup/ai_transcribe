import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from edge_tts.exceptions import NoAudioReceived
from backend.services import tts_service as tts


class EdgeRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = str(Path(self.temp.name) / 'speech.mp3')
        self.options = dict(rate='+5%', pitch='+7Hz', volume='+0%')

    async def save(self, text='សួស្តី'):
        await tts._save_edge_audio(text, tts.KHMER_MALE, self.path, **self.options)

    async def test_retry_preserves_voice_and_delivery_and_removes_partial_audio(self):
        attempts = 0

        async def write(path):
            nonlocal attempts
            attempts += 1
            self.assertFalse(Path(path).exists())
            Path(path).write_bytes(b'partial' if attempts < 3 else b'complete')
            if attempts < 3:
                raise NoAudioReceived('no audio')

        with patch('edge_tts.Communicate') as factory, patch.object(tts.asyncio, 'sleep', new_callable=AsyncMock) as sleep:
            factory.return_value.save = AsyncMock(side_effect=write)
            await self.save()
            self.assertEqual(factory.call_count, 3)
            for call in factory.call_args_list:
                self.assertEqual(call.args, ('សួស្តី', tts.KHMER_MALE))
                self.assertEqual(call.kwargs, self.options)
            self.assertEqual([call.args[0] for call in sleep.call_args_list], [1, 2])
            self.assertEqual(Path(self.path).read_bytes(), b'complete')

    async def test_empty_audio_exhausts_bounded_retries(self):
        with patch('edge_tts.Communicate') as factory, patch.object(tts.asyncio, 'sleep', new_callable=AsyncMock):
            factory.return_value.save = AsyncMock(side_effect=lambda path: Path(path).touch())
            with self.assertRaisesRegex(RuntimeError, 'after 4 attempts'):
                await self.save()
            self.assertEqual(factory.call_count, 4)
            self.assertFalse(Path(self.path).exists())

    async def test_non_speech_never_calls_service(self):
        with patch('edge_tts.Communicate') as factory:
            for text in ['...', '\u200b', '\x00\t', '🎵', '។៕']:
                with self.assertRaisesRegex(ValueError, 'no spoken words'):
                    await self.save(text)
            factory.assert_not_called()

    async def test_untranslated_chinese_is_rejected_before_calling_khmer_voice(self):
        with patch('edge_tts.Communicate') as factory:
            with self.assertRaisesRegex(ValueError, 'Translate it to Khmer'):
                await self.save('队长，我们现在该怎么办？')
            factory.assert_not_called()

    async def test_mixed_khmer_dialogue_is_not_rejected_as_untranslated(self):
        with patch('edge_tts.Communicate') as factory:
            factory.return_value.save = AsyncMock(side_effect=lambda path: Path(path).write_bytes(b'audio'))
            await self.save('សួស្តី 刘阳')
            self.assertEqual(factory.call_count, 1)

    async def test_cancellation_removes_partial_audio_without_retry(self):
        async def cancel(path):
            Path(path).write_bytes(b'partial')
            raise asyncio.CancelledError()

        with patch('edge_tts.Communicate') as factory:
            factory.return_value.save = AsyncMock(side_effect=cancel)
            with self.assertRaises(asyncio.CancelledError):
                await self.save()
            self.assertEqual(factory.call_count, 1)
            self.assertFalse(Path(self.path).exists())

    async def test_invalid_parameters_fail_without_retry(self):
        with patch('edge_tts.Communicate', side_effect=ValueError('invalid rate')) as factory:
            with self.assertRaisesRegex(ValueError, 'invalid rate'):
                await self.save()
            self.assertEqual(factory.call_count, 1)

    async def test_concurrent_requests_are_limited(self):
        active = peak = 0
        release = asyncio.Event()
        started = asyncio.Event()

        async def write(path):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            if active == 2:
                started.set()
            await release.wait()
            Path(path).write_bytes(b'audio')
            active -= 1

        with patch('edge_tts.Communicate') as factory:
            factory.return_value.save = AsyncMock(side_effect=write)
            tasks = [asyncio.create_task(tts._save_edge_audio(
                'សួស្តី', tts.KHMER_MALE, str(Path(self.temp.name) / f'{i}.mp3'), **self.options
            )) for i in range(5)]
            try:
                await asyncio.wait_for(started.wait(), 2)
                self.assertEqual(factory.call_count, 2)
            finally:
                release.set()
                await asyncio.gather(*tasks)
            self.assertEqual(peak, 2)
