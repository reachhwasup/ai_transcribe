import json
import os
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.api.routes import settings as st
from backend.database.db import Base
from backend.database.models import AppSetting, Project, Segment
from backend.services.tts_service import says_word


class SaysWordTest(unittest.TestCase):
    def test_a_latin_word_needs_its_own_edges_and_khmer_does_not(self):
        self.assertTrue(says_word("សួស្តី Tang មក", "tang"))
        self.assertFalse(says_word("Tangerine", "Tang"))
        self.assertTrue(says_word("លោកថាងមក", "ថាង"))
        self.assertFalse(says_word("", "ថាង"))


class StaleDubTest(unittest.IsolatedAsyncioTestCase):
    """A dub made before a word's spoken form was set still says it the old way."""

    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.folder = tempfile.mkdtemp()
        self.old, self.new = os.path.join(self.folder, "old.wav"), os.path.join(self.folder, "new.wav")
        for path, age in ((self.old, 3600), (self.new, -60)):
            open(path, "wb").close()
            os.utime(path, (time.time() - age, time.time() - age))
        # stored the way the app stores them: a path from the working folder, with a leading slash
        self.old_url, self.new_url = ("/" + os.path.relpath(path) for path in (self.old, self.new))
        async with self.sessions() as db:
            db.add_all([Project(id="p", name="One"), Project(id="q", name="Two")])
            db.add_all([
                Segment(id="stale", project_id="p", index=0, start_time=0, end_time=1, text="Wukong មក", audio_url=self.old_url),
                Segment(id="fresh", project_id="p", index=1, start_time=1, end_time=2, text="Wukong ទៅ", audio_url=self.new_url),
                Segment(id="other", project_id="p", index=2, start_time=2, end_time=3, text="សួស្តី", audio_url=self.old_url),
                Segment(id="undubbed", project_id="q", index=0, start_time=0, end_time=1, text="Wukong", audio_url=""),
                Segment(id="gone", project_id="q", index=1, start_time=1, end_time=2, text="Wukong", audio_url="/missing.wav"),
            ])
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_saving_stamps_new_and_changed_words_only(self):
        async with self.sessions() as db:
            db.add(AppSetting(key="pronunciations", value=json.dumps([{"word": "Tang", "say_as": "ថាង"}, {"word": "Wukong", "say_as": "វូខុង"}])))
            await db.commit()
            with patch("backend.services.tts_service.set_pronunciations"):
                saved = await st.save_pronunciations([
                    st.PronunciationEntry(word="Tang", say_as="ថាង"), st.PronunciationEntry(word="Wukong", say_as="អ៊ូខុង"),
                    st.PronunciationEntry(word=" ", say_as="x")], db)
        self.assertEqual([e.word for e in saved], ["Tang", "Wukong"])
        self.assertEqual(saved[0].changed_at, 0.0)       # as it was, and its time is not known
        self.assertGreater(saved[1].changed_at, time.time() - 5)

    async def test_only_dubs_older_than_the_change_are_stale(self):
        async with self.sessions() as db:
            db.add(AppSetting(key="pronunciations", value=json.dumps([
                {"word": "Wukong", "say_as": "វូខុង", "changed_at": time.time() - 600}, {"word": "សួស្តី", "say_as": "x"}])))
            await db.commit()
            self.assertEqual(await st.stale_pronunciations(db), {"lines": 1, "projects": 1, "words": {"Wukong": 1}})

    async def test_redub_clears_them_and_queues_the_project(self):
        from backend.api.routes import pipeline
        async with self.sessions() as db:
            db.add(AppSetting(key="pronunciations", value=json.dumps([{"word": "Wukong", "say_as": "វូខុង", "changed_at": time.time() - 600}])))
            await db.commit()
            with patch.object(pipeline, "add_to_pipeline", AsyncMock()) as queue:
                result = await st.redub_stale_pronunciations(db)
            self.assertEqual(result, {"lines": 1, "projects": 1, "queued": 1, "busy": 0})
            self.assertEqual(queue.await_args.args[0], "p")
            self.assertFalse(queue.await_args.args[1].captions)
            self.assertEqual((await db.get(Segment, "stale")).audio_url, "")
            self.assertEqual((await db.get(Segment, "fresh")).audio_url, self.new_url)
            self.assertTrue(os.path.exists(self.old))       # kept, for undo
            self.assertEqual((await st.stale_pronunciations(db))["lines"], 0)


if __name__ == "__main__":
    unittest.main()
