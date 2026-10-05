import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from backend.database.db import Base
from backend.database.models import Project, Segment
from backend.services.series_memory import (SeriesMemory, scope, prompt_memory, translation_flags, apply_voices,
    known_cast, learn_cast, locked_misses, suggest_terms, voice_settings, style_block, VOICE_STYLES, readable_speakers, speaker_label)
from backend.api.routes.series import (save_memory, get_memory, review_translation, ScanRequest,
    learn_cast_from_series, fix_spellings, check_spellings, FixRequest)


class MemoryRulesTest(unittest.TestCase):
    def test_group_keys_do_not_mix_folders_or_unrelated_projects(self):
        def project(id, batch='', root=''):
            return SimpleNamespace(id=id, batch_id=batch, source_project_id=root)
        self.assertEqual(scope(project('a', 'series')), scope(project('b', 'series')))
        self.assertNotEqual(scope(project('a', 'one')), scope(project('b', 'two')))
        self.assertEqual(scope(project('a', root='root')), scope(project('root')))
        self.assertNotEqual(scope(project('a')), scope(project('b')))

    def test_ambiguous_cast_and_blank_terms_rejected(self):
        with self.assertRaises(ValueError):
            SeriesMemory(terms=[{'source': ' ', 'target': 'word'}])
        with self.assertRaises(ValueError):
            SeriesMemory(characters=[{'source': 'A', 'target': 'B'}, {'source': 'C', 'target': 'B'}])

    def test_memory_is_target_specific(self):
        memory = SeriesMemory(terms=[{'source': '唐', 'target': 'ថាង'}])
        self.assertIn('USER-APPROVED', prompt_memory(memory, 'km'))
        self.assertEqual(prompt_memory(memory, 'en'), '')

    def test_mixed_script_and_glossary_mismatch_flagged(self):
        memory = SeriesMemory(terms=[{'source': '唐', 'target': 'ថាង'}])
        rows = [SimpleNamespace(id='bad', original_text='唐你好', text='សួស្តី Tang'),
                SimpleNamespace(id='good', original_text='唐你好', text='សួស្តី ថាង')]
        flags = translation_flags(rows, memory, 'km')
        self.assertEqual([f['id'] for f in flags], ['bad'])
        self.assertEqual(len(flags[0]['reasons']), 2)


def line(speaker='', profile='female', source='', text='', id='x'):
    return SimpleNamespace(id=id, speaker=speaker, voice_profile=profile, original_text=source, text=text)


class SharedCastTest(unittest.TestCase):
    """The cast is learned from the episodes and kept across them."""

    def test_new_speakers_are_learned_with_the_voice_most_of_their_lines_have(self):
        memory = SeriesMemory()
        added = learn_cast(memory, [line('Thug Leader', 'male'), line('Thug Leader', 'male'), line('Thug Leader', 'female'),
                                    line('Miss Zhao', 'female'), line('', 'male'), line('Speaker 1', 'male')])
        self.assertEqual(added, ['Thug Leader', 'Miss Zhao'])     # most lines first; unnamed left out
        self.assertEqual(known_cast(memory), {'Thug Leader': 'male', 'Miss Zhao': 'female'})

    def test_people_already_in_the_cast_are_left_as_they_are(self):
        memory = SeriesMemory(characters=[{'source': '赵小姐', 'target': 'កញ្ញា ចាវ', 'aliases': ['Miss Zhao'], 'voice_profile': 'grandma'}])
        self.assertEqual(learn_cast(memory, [line('Miss Zhao', 'female'), line('កញ្ញា ចាវ', 'female')]), [])
        self.assertEqual(memory.characters[0].voice_profile, 'grandma')

    def test_a_cast_member_is_shown_by_a_name_the_editor_can_read(self):
        memory = SeriesMemory(characters=[
            {'source': '肖峰', 'target': 'ស៊ាវ ហ្វុង', 'aliases': ['肖少', 'Xiao Feng'], 'voice_profile': 'male'},
            {'source': '柳冰', 'target': 'លីវ ប៊ីង'}, {'source': 'Thug Leader', 'target': 'Thug Leader', 'voice_profile': 'male'}])
        self.assertEqual([speaker_label(c) for c in memory.characters], ['Xiao Feng', '柳冰', 'Thug Leader'])
        self.assertEqual(known_cast(memory), {'Xiao Feng': 'male', '柳冰': 'unknown', 'Thug Leader': 'male'})
        lines = [line('肖峰'), line('肖少'), line('Xiao Feng'), line('柳冰'), line('Stranger'), line('')]
        self.assertEqual(readable_speakers(memory, lines), 2)
        self.assertEqual([l.speaker for l in lines], ['Xiao Feng', 'Xiao Feng', 'Xiao Feng', '柳冰', 'Stranger', ''])
        self.assertEqual(learn_cast(memory, lines), ['Stranger'])      # the renamed lines are still that cast member

    def test_learning_twice_adds_nothing_new(self):
        memory = SeriesMemory()
        lines = [line('Feifei', 'child_girl')]
        learn_cast(memory, lines)
        self.assertEqual(learn_cast(memory, lines), [])
        self.assertEqual(len(memory.characters), 1)

    def test_a_learned_name_says_nothing_to_the_translator_or_the_checks(self):
        memory = SeriesMemory()
        learn_cast(memory, [line('Thug Leader', 'male')])
        self.assertEqual(prompt_memory(memory, 'km'), '')
        self.assertEqual(locked_misses([line(source='Thug Leader came', text='មេក្រុម')], memory, 'km'), [])
        self.assertEqual(translation_flags([line(source='Thug Leader came', text='មេក្រុមមក')], memory, 'km'), [])

    def test_the_translator_is_told_the_spellings_are_locked_and_not_the_voices(self):
        memory = SeriesMemory(characters=[{'source': '唐', 'target': 'ថាង', 'voice_profile': 'male', 'voice_name': 'chosen'}])
        told = prompt_memory(memory, 'km')
        self.assertIn('LOCKED SPELLINGS', told)
        self.assertIn('ថាង', told)
        self.assertNotIn('chosen', told)


class SeriesStyleTest(unittest.TestCase):
    """How the whole series is worded is told to the translator of every episode."""

    def test_a_style_alone_is_enough_to_be_told(self):
        told = prompt_memory(SeriesMemory(style='street'), 'km')
        self.assertIn('STYLE OF THE WHOLE SERIES', told)
        self.assertIn('អញ', told)                      # the Khmer forms, for a Khmer translation
        self.assertNotIn('USER-APPROVED', told)        # there is no glossary to speak of

    def test_forms_of_address_and_glossary_are_told_together_without_repeating_the_style(self):
        memory = SeriesMemory(style='formal', address='Zhao calls her father លោកឪពុក', terms=[{'source': '唐', 'target': 'ថាង'}])
        told = prompt_memory(memory, 'km')
        self.assertIn('លោកឪពុក', told)
        self.assertIn('LOCKED SPELLINGS', told)
        self.assertEqual(told.count('formal'), 0)      # the rule is written out, not the key dumped as data
        self.assertNotIn('អញ', style_block(memory, 'km'))

    def test_another_language_gets_the_rule_without_khmer_words(self):
        self.assertNotIn('អញ', style_block(SeriesMemory(language='en', style='street'), 'en'))
        self.assertEqual(style_block(SeriesMemory(), 'km'), '')


class CharacterVoiceTest(unittest.TestCase):
    """Each cast member has one pitch and pace, the same in every episode."""

    def cast(self, *rows):
        return SeriesMemory(characters=[dict(source=name, target=name, voice_profile=profile, voice_style=style, aliases=aliases)
                                        for name, profile, style, aliases in rows])

    def test_a_chosen_style_is_used_under_every_name_the_person_has(self):
        voices = voice_settings(self.cast(('Zhao', 'female', 'high', ['Miss Zhao'])))
        self.assertEqual(voices, {'Zhao': VOICE_STYLES['high'], 'Miss Zhao': VOICE_STYLES['high']})

    def test_people_without_a_style_are_given_different_ones_within_their_gender(self):
        voices = voice_settings(self.cast(('Hero', 'male', '', []), ('Thug', 'male', '', []), ('Elder', 'grandpa', '', []),
                                          ('Zhao', 'female', '', []), ('Feifei', 'child_girl', '', [])))
        self.assertEqual(voices['Hero'], VOICE_STYLES['natural'])            # the first keeps the natural voice
        self.assertEqual(len({voices['Hero'], voices['Thug'], voices['Elder']}), 3)
        self.assertEqual(voices['Zhao'], VOICE_STYLES['natural'])            # women are placed on their own
        self.assertNotEqual(voices['Feifei'], voices['Zhao'])

    def test_a_person_whose_voice_type_is_unknown_is_left_to_the_episode(self):
        self.assertEqual(voice_settings(self.cast(('Someone', '', '', []))), {})

    def test_the_translator_is_not_told_voice_styles(self):
        memory = SeriesMemory(characters=[{'source': '唐', 'target': 'ថាង', 'voice_style': 'deep'}])
        self.assertNotIn('deep', prompt_memory(memory, 'km'))


class GlossaryLockTest(unittest.IsolatedAsyncioTestCase):
    def test_only_lines_that_miss_a_locked_spelling_are_found(self):
        memory = SeriesMemory(terms=[{'source': '唐', 'target': 'ថាង'}])
        rows = [line(source='唐你好', text='សួស្តី តាំង', id='bad'), line(source='唐你好', text='សួស្តី ថាង', id='good'),
                line(source='你好', text='សួស្តី', id='other'), line(source='唐', text='', id='empty')]
        self.assertEqual([seg.id for seg, _ in locked_misses(rows, memory, 'km')], ['bad'])
        self.assertEqual(locked_misses(rows, memory, 'en'), [])

    async def test_suggestions_keep_only_what_recurs_and_is_new(self):
        from backend.services import gemini_service as gs
        memory = SeriesMemory(terms=[{'source': '赵', 'target': 'ចាវ'}])
        rows = [line(source='唐来了', text='ថាង មកហើយ'), line(source='唐走了', text='ថាង ទៅហើយ'), line(source='赵在哪', text='ចាវ នៅឯណា'),
                line(source='赵来了', text='ចាវ មក'), line(source='李来了', text='លី មក')]
        reply = SimpleNamespace(text=json.dumps({'terms': [
            {'source': '唐', 'target': 'ថាង', 'kind': 'character'}, {'source': '赵', 'target': 'ចាវ', 'kind': 'character'},
            {'source': '李', 'target': 'លី', 'kind': 'character'}, {'source': '王', 'target': 'វ៉ាង'}, 'junk', {'source': '唐', 'target': 'ថាំង'}]}))
        with patch.object(gs, '_configure_genai', AsyncMock()), patch.object(gs, '_generate_with_fallback', AsyncMock(return_value=reply)):
            found = await suggest_terms(rows, memory, 'km')
        self.assertEqual(found, [{'source': '唐', 'target': 'ថាង', 'kind': 'character', 'count': 2}])


class SeriesPersistenceTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine('sqlite+aiosqlite:///:memory:')
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as db:
            db.add_all([Project(id='a', name='One', batch_id='family'), Project(id='b', name='Two', batch_id='family'), Project(id='c', name='Other', batch_id='other')])
            db.add_all([Segment(id='s', project_id='b', index=0, start_time=0, end_time=2, speaker='Tang', original_text='唐你好', text='សួស្តី Tang', voice_profile='female', voice_name='old', audio_url='old.wav'),
                        Segment(id='t', project_id='c', index=0, start_time=0, end_time=2, speaker='Tang', text='Other', voice_profile='female', audio_url='keep.wav')])
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_shared_save_reload_and_voice_invalidation_are_scoped(self):
        memory = SeriesMemory(characters=[{'source': '唐', 'target': 'ថាង', 'aliases': ['Tang'], 'voice_profile': 'male', 'voice_name': 'chosen'}])
        async with self.sessions() as db:
            await save_memory('a', memory, db)
        async with self.sessions() as db:
            result = await get_memory('b', db)
            self.assertEqual(result['projects'], 2)
            self.assertEqual(result['memory']['characters'][0]['target'], 'ថាង')
            with patch('backend.services.project_versions.auto_save', AsyncMock()) as saved:
                self.assertEqual(await apply_voices(db, 'b'), 1)
                self.assertEqual(await apply_voices(db, 'b'), 0)
                saved.assert_awaited_once()
            segment = await db.get(Segment, 's')
            self.assertEqual((segment.voice_profile, segment.voice_name, segment.audio_url), ('male', 'chosen', ''))
            other = await db.get(Segment, 't')
            self.assertEqual(other.audio_url, 'keep.wav')
            self.assertEqual((await get_memory('c', db))['memory']['characters'], [])

    async def test_semantic_failure_does_not_hide_basic_flags(self):
        from backend.services import gemini_service as gs
        async with self.sessions() as db:
            with patch.object(gs, '_configure_genai', AsyncMock()), patch.object(gs, '_generate_with_fallback', AsyncMock(side_effect=RuntimeError('quota'))):
                result = await review_translation('b', ScanRequest(semantic=True), db)
        self.assertEqual(result['issues'][0]['id'], 's')
        self.assertTrue(result['warnings'])

    async def test_semantic_review_maps_only_valid_indexes(self):
        from backend.services import gemini_service as gs
        reply = SimpleNamespace(text=json.dumps({'issues': [{'index': 1, 'reason': 'Possible negation lost'}, {'index': 999, 'reason': 'invalid'}]}))
        async with self.sessions() as db:
            with patch.object(gs, '_configure_genai', AsyncMock()), patch.object(gs, '_generate_with_fallback', AsyncMock(return_value=reply)):
                result = await review_translation('b', ScanRequest(semantic=True), db)
        self.assertEqual(len(result['issues']), 1)
        self.assertIn('AI suggestion: Possible negation lost', result['issues'][0]['reasons'])

    async def test_the_cast_is_learned_from_every_episode_of_the_series_only(self):
        async with self.sessions() as db:
            db.add(Segment(id='u', project_id='a', index=0, start_time=0, end_time=2, speaker='Miss Zhao', text='x', voice_profile='female'))
            await db.commit()
            result = await learn_cast_from_series('a', db)
        self.assertEqual(sorted(result['added']), ['Miss Zhao', 'Tang'])
        async with self.sessions() as db:
            self.assertEqual(len((await get_memory('b', db))['memory']['characters']), 2)
            self.assertEqual((await get_memory('c', db))['memory']['characters'], [])

    async def test_automatic_voice_does_not_clear_a_dub_made_with_the_built_in_voice(self):
        from backend.services.tts_service import DEFAULT_VOICE_MAP
        async with self.sessions() as db:
            seg = await db.get(Segment, 's')
            seg.voice_profile, seg.voice_name, seg.audio_url = 'male', DEFAULT_VOICE_MAP['male'], 'dub.wav'
            await db.commit()
            await save_memory('a', SeriesMemory(characters=[{'source': 'Tang', 'target': 'Tang', 'voice_profile': 'male'}]), db)
            with patch('backend.services.project_versions.auto_save', AsyncMock()):
                self.assertEqual(await apply_voices(db, 'b'), 0)
            self.assertEqual((await db.get(Segment, 's')).audio_url, 'dub.wav')

    async def test_wrong_spellings_are_translated_again_across_the_series(self):
        asked = []

        async def translate(project_id, body, db):
            asked.append((project_id, body['segment_ids']))
            (await db.get(Segment, 's')).text = 'សួស្តី ថាង'
        async with self.sessions() as db:
            await save_memory('a', SeriesMemory(terms=[{'source': '唐', 'target': 'ថាង'}]), db)
            self.assertEqual(await check_spellings('a', FixRequest(), db), {'lines': 1, 'episodes': 1, 'checked': 2})
            with patch('backend.api.routes.transcripts.translate_project_segments', translate), \
                 patch('backend.services.project_versions.auto_save', AsyncMock()) as kept:
                result = await fix_spellings('a', FixRequest(), db)
            kept.assert_awaited_once()
        self.assertEqual(asked, [('b', ['s'])])
        self.assertEqual((result['found'], result['fixed'], result['remaining'], result['episodes']), (1, 1, 0, 1))

    async def test_restyling_a_person_clears_their_dubs_and_nobody_elses(self):
        async with self.sessions() as db:
            db.add(Segment(id='z', project_id='b', index=1, start_time=3, end_time=5, speaker='Zhao', text='x', voice_profile='female', audio_url='zhao.wav'))
            seg = await db.get(Segment, 's')
            seg.voice_profile, seg.voice_name = 'male', ''
            await db.commit()
            await save_memory('a', SeriesMemory(characters=[
                {'source': 'Tang', 'target': 'Tang', 'voice_profile': 'male', 'voice_style': 'deep'},
                {'source': 'Zhao', 'target': 'Zhao', 'voice_profile': 'female'}]), db)
            with patch('backend.services.project_versions.auto_save', AsyncMock()):
                self.assertEqual(await apply_voices(db, 'b'), 0)                    # nothing changed: nothing cleared
                self.assertEqual(await apply_voices(db, 'b', ('Tang',)), 1)
            self.assertEqual((await db.get(Segment, 's')).audio_url, '')
            self.assertEqual((await db.get(Segment, 'z')).audio_url, 'zhao.wav')
