import json
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from backend.database.db import Base
from backend.database.models import Project, Segment
from backend.api.routes.voice_generation import generate_voice_segments_stream, GenerateSegmentVoiceRequest


class VoiceGenerationStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_voice_fx_survives_selected_and_all_segment_streams(self):
        engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        try:
            async with sessions() as db:
                db.add(Project(id='project', name='Test', language='km'))
                db.add(Segment(id='line', project_id='project', index=0, text='Hello', start_time=0, end_time=2, voice_profile='male', voice_fx='robot'))
                await db.commit()
                for ids in (None, ['line']):
                    with (
                        patch('backend.database.db.async_session', sessions),
                        patch('backend.api.routes.settings._get_custom_voice_profiles', AsyncMock(return_value=[])),
                        patch('backend.services.tts_service.generate_fitted_segment_audio', AsyncMock(return_value=('uploads/test-audio.mp3', 1.5))) as synthesize,
                    ):
                        response = await generate_voice_segments_stream('project', GenerateSegmentVoiceRequest(segment_ids=ids, skip_existing=False, voice_fx='dream' if ids else None), db)
                        events = [json.loads(chunk.removeprefix('data: ').strip()) async for chunk in response.body_iterator]
                    self.assertEqual(events[-1]['type'], 'done')
                    self.assertEqual(events[-1]['failed'], 0)
                    self.assertEqual(events[-1]['completed'], 1)
                    self.assertEqual(synthesize.call_args.kwargs['voice_fx'], 'dream' if ids else 'robot')
                    await db.refresh(await db.get(Segment, 'line'))
                    if ids:
                        self.assertEqual((await db.get(Segment, 'line')).voice_fx, 'dream')
        finally:
            await engine.dispose()

    async def test_overlapping_batches_are_rejected_and_cancel_releases_project(self):
        from fastapi import HTTPException
        from backend.api.routes.voice_generation import _active_voice_streams

        engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        try:
            async with sessions() as db:
                db.add(Project(id='concurrent-project', name='Test', language='km'))
                db.add(Segment(id='line', project_id='concurrent-project', index=0, text='Hello', start_time=0, end_time=2))
                await db.commit()
                with patch('backend.api.routes.settings._get_custom_voice_profiles', AsyncMock(return_value=[])):
                    # Both responses are prepared before either stream starts.
                    first = await generate_voice_segments_stream('concurrent-project', GenerateSegmentVoiceRequest(), db)
                    second = await generate_voice_segments_stream('concurrent-project', GenerateSegmentVoiceRequest(), db)
                    try:
                        start = await anext(first.body_iterator)
                        self.assertIn('"type": "start"', start)
                        events = [json.loads(chunk.removeprefix('data: ').strip()) async for chunk in second.body_iterator]
                        self.assertEqual(events[0]['type'], 'error')
                        self.assertEqual(len(events), 1)
                        with self.assertRaises(HTTPException) as raised:
                            await generate_voice_segments_stream('concurrent-project', GenerateSegmentVoiceRequest(), db)
                        self.assertEqual(raised.exception.status_code, 409)
                    finally:
                        await first.body_iterator.aclose()
                    self.assertNotIn('concurrent-project', _active_voice_streams)
                    third = await generate_voice_segments_stream('concurrent-project', GenerateSegmentVoiceRequest(), db)
                    try:
                        self.assertIn('"type": "start"', await anext(third.body_iterator))
                    finally:
                        await third.body_iterator.aclose()
        finally:
            _active_voice_streams.discard('concurrent-project')
            await engine.dispose()
