import unittest
from unittest.mock import AsyncMock, patch
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from backend.database.db import Base
from backend.database.models import Project, Segment
from backend.api.routes.ai_content import generate_movie_recap, get_movie_recap
from backend.services.movie_recap import RecapOptions, summarize_transcript, parse_external_transcript, RecapSection
from fastapi import HTTPException


class MovieRecapTests(unittest.IsolatedAsyncioTestCase):
    async def test_transcript_source_and_saved_summary(self):
        engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        try:
            async with async_sessionmaker(engine, expire_on_commit=False)() as db:
                db.add(Project(id='p', name='Film'))
                await db.commit()
                with self.assertRaises(HTTPException) as error:
                    await generate_movie_recap('p', RecapOptions(), db)
                self.assertEqual(error.exception.status_code, 400)
                db.add_all([
                    Segment(id='line', project_id='p', index=0, start_time=0, end_time=5, speaker='Hero', original_text='Original dialogue', text='Translation'),
                    Segment(id='hook', project_id='p', index=1, start_time=0, end_time=3, speaker='Intro Hook', text='Invented hook'),
                ])
                await db.commit()
                with patch('backend.api.routes.ai_content.summarize_transcript', new_callable=AsyncMock) as generate:
                    generate.return_value = {'title': 'Story', 'summary': 'Summary', 'key_events': ['Event']}
                    recap = await generate_movie_recap('p', RecapOptions(language='en'), db)
                    source = generate.call_args.args[0]
                    self.assertEqual(len(source), 1)
                    self.assertEqual(source[0]['text'], 'Original dialogue')
                    saved = await get_movie_recap('p', db)
                    # the GET enriches the stored recap with freshness fields
                    self.assertEqual({k: saved[k] for k in recap}, recap)
                    self.assertFalse(saved['stale'])
                    self.assertEqual(saved['current_segments'], 1)
        finally:
            await engine.dispose()

    async def test_long_transcript_keeps_every_part(self):
        payload = '{"title":"Notes","summary":"Story notes","key_events":[],"sections":[{"start_time":null,"end_time":null,"script":"Narration"}]}'
        with patch('backend.services.movie_recap._get_active_keys', AsyncMock(return_value=['test'])), patch('backend.services.movie_recap.generate_text_inline', AsyncMock(return_value=payload)) as generate:
            await summarize_transcript([{'text': 'FIRST' + 'a' * 24000}, {'text': 'LAST'}], RecapOptions())
            # two parts, one combined recap, and one more ask because that recap came back thin
            self.assertEqual(generate.await_count, 4)
            prompts = [call.args[2] for call in generate.call_args_list]
            self.assertIn('PREVIOUS ATTEMPT WAS TOO SHORT', prompts[3])
            self.assertIn('FIRST', prompts[0])
            self.assertIn('LAST', prompts[1])
            self.assertIn('CHRONOLOGICAL TRANSCRIPT NOTES', prompts[2])


class ExternalTranscriptTests(unittest.TestCase):
    def test_srt_and_vtt_keep_source_times(self):
        text = '1\n00:00:05,000 --> 00:00:09,500\nHello\nWorld\n\n2\n00:00:12,000 --> 00:00:14,000\nEnding\n'
        rows = parse_external_transcript('movie.srt', text)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['start'], 5)
        self.assertEqual(rows[0]['end'], 9.5)
        self.assertIn('World', rows[0]['text'])
        rows = parse_external_transcript('movie.vtt', 'WEBVTT\n\n00:05.000 --> 00:09.000\nHello\n')
        self.assertEqual(rows[0]['start'], 5)

    def test_json_and_untimed_text(self):
        rows = parse_external_transcript('movie.json', '[{"start_time":2,"end_time":4,"text":"Hello"}]')
        self.assertEqual(rows[0]['end'], 4)
        self.assertIsNone(parse_external_transcript('movie.txt', 'Hello')[0]['start'])
        with self.assertRaises(ValueError):
            parse_external_transcript('movie.srt', 'not captions')
        with self.assertRaises(ValueError):
            RecapSection(start_time=5, end_time=2, script='Invalid')


class RecapFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_busy_model_uses_fallback(self):
        payload = '{"title":"Story","summary":"Summary","sections":[{"start_time":0,"end_time":5,"script":"Narration"}],"key_events":[]}'
        with patch('backend.services.movie_recap._get_active_keys', AsyncMock(return_value=['test'])), patch('backend.services.movie_recap.generate_text_inline', AsyncMock(side_effect=[RuntimeError('503 busy'), payload])) as generate:
            result = await summarize_transcript([{'start': 0, 'end': 5, 'text': 'Dialogue'}], RecapOptions())
            self.assertEqual(len(result['sections']), 1)
            self.assertNotEqual(generate.call_args_list[0].args[1], generate.call_args_list[1].args[1])

    async def test_busy_error_does_not_blame_keys(self):
        with patch('backend.services.movie_recap._get_active_keys', AsyncMock(return_value=['test'])), patch('backend.services.movie_recap.generate_text_inline', AsyncMock(side_effect=RuntimeError('503 busy'))):
            with self.assertRaisesRegex(RuntimeError, 'temporarily unavailable'):
                await summarize_transcript([{'text': 'Dialogue'}], RecapOptions())


class SummaryDetailTests(unittest.IsolatedAsyncioTestCase):
    def test_detailed_asks_for_more_than_standard_and_scales_with_the_dialogue(self):
        from backend.services.movie_recap import summary_plan
        small, big = summary_plan(16, 'detailed'), summary_plan(200, 'detailed')
        self.assertGreater(small['paragraphs'], summary_plan(16, 'standard')['paragraphs'])
        self.assertGreater(small['scenes'], summary_plan(16, 'standard')['scenes'])
        self.assertGreater(big['paragraphs'], small['paragraphs'])
        self.assertLessEqual(big['paragraphs'], 14)

    async def test_a_full_answer_is_kept_with_its_characters_scenes_and_ending(self):
        import json
        payload = json.dumps({
            'title': 'Story', 'summary': 'x' * 2000, 'key_events': ['a'],
            'characters': [{'name': 'Hero', 'description': 'A farmer'}], 'ending': 'He leaves.',
            'sections': [
                {'title': 'Opening', 'start_time': 0, 'end_time': 5, 'script': 'He wakes.'},
                {'title': 'Drifts past the end', 'start_time': 4, 'end_time': 9, 'script': 'He goes.'},
            ],
        })
        with patch('backend.services.movie_recap._get_active_keys', AsyncMock(return_value=['test'])), patch('backend.services.movie_recap.generate_text_inline', AsyncMock(return_value=payload)) as generate:
            result = await summarize_transcript([{'start': 0, 'end': 6, 'text': 'Dialogue'}], RecapOptions(length='detailed'))
        self.assertEqual(generate.await_count, 1)          # long enough: no second ask
        self.assertIn('EVERY exchange', generate.call_args.args[2])
        self.assertEqual(result['characters'][0]['name'], 'Hero')
        self.assertEqual(result['ending'], 'He leaves.')
        self.assertEqual(result['sections'][0]['title'], 'Opening')
        self.assertEqual(result['sections'][1]['end_time'], 6)   # pulled back inside the transcript
        self.assertFalse(result['summary_expanded'])
