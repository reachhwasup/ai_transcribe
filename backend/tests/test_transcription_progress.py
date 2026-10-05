import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from backend.services import gemini_service as service
from backend.services.gemini_client import CHUNK_DURATION, CHUNK_THRESHOLD


class TranscriptionProgressTests(unittest.IsolatedAsyncioTestCase):
    async def collect(self, duration, chunks, transcribe):
        with (
            patch.object(service, '_configure_genai', AsyncMock()),
            patch.object(service, '_get_video_duration', AsyncMock(return_value=duration)),
            patch.object(service, '_split_video_chunks', AsyncMock(return_value=(chunks, None))),
            patch.object(service, '_transcribe_span', transcribe),
        ):
            return [event async for event in service.transcribe_video_streaming('test.mp4')]

    def assert_progress(self, events):
        percentages = [event['percent'] for event in events if '_progress' in event]
        self.assertEqual(percentages, sorted(percentages))
        self.assertEqual(percentages[-1], 99)
        self.assertTrue(all(0 <= percent < 100 for percent in percentages))

    async def test_short_clip_progress_never_goes_backwards(self):
        events = await self.collect(30, [('audio', 0)], AsyncMock(return_value=[
            {'start_time': 0, 'end_time': 1, 'text': 'Hello'},
        ]))
        self.assert_progress(events)
        self.assertEqual(len([e for e in events if 'text' in e]), 1)

    async def test_parallel_parts_keep_caption_order(self):
        later_finished = asyncio.Event()

        async def transcribe(path, offset, *args):
            if offset == 0:
                await later_finished.wait()
                await asyncio.sleep(0.01)
            else:
                later_finished.set()
            return [{'start_time': offset, 'end_time': offset + 1, 'text': path}]

        events = await self.collect(240, [('first', 0), ('second', 116)], transcribe)
        self.assert_progress(events)
        self.assertEqual([e['text'] for e in events if 'text' in e], ['first', 'second'])
        self.assertTrue(any(e.get('current_chunk') == 1 for e in events))

    async def test_failed_part_keeps_warning_and_finishes_below_100(self):
        async def transcribe(path, offset, duration, prompt, tmp_dir, failed):
            if offset:
                failed.append((offset, offset + duration, 'test failure'))
                return []
            return [{'start_time': 0, 'end_time': 1, 'text': 'Saved'}]

        events = await self.collect(240, [('first', 0), ('second', 116)], transcribe)
        self.assert_progress(events)
        self.assertTrue(any('_warning' in e for e in events))

    def test_chunk_threshold_matches_splitter(self):
        self.assertEqual(CHUNK_DURATION, 120)
        self.assertEqual(CHUNK_THRESHOLD, CHUNK_DURATION * 1.15)
