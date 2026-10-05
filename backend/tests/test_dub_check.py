import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import numpy as np
import soundfile as sf
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.database.db import Base
from backend.database.models import Project, Segment
from backend.services import dub_check as dc
from backend.services.review import flagged_lines, review_project
from backend.services.series_memory import SeriesMemory

WORDS = "សួស្តីបងប្អូនទាំងអស់គ្នា"       # 24 Khmer letters


def line(id, start, seconds=None, text=WORDS, db=-20.0, clipped=0.0, end=None, **more):
    """A caption; with `seconds`, one whose voice file measures that long."""
    seg = SimpleNamespace(id=id, start_time=start, end_time=end if end is not None else start + 2.0, text=text,
                          original_text="", speaker="A", voice_profile="male", audio_url=f"/v/{id}.mp3" if seconds is not None else "", **more)
    seg.info = None if seconds is None else {"seconds": seconds, "db": db, "clipped": clipped}
    return seg


def measured(segments):
    by_path = {f"v/{s.id}.mp3": s.info for s in segments}
    return lambda path: by_path.get(path)


def kinds(found):
    return {kind: [seg.id for seg, _ in lines] for kind, lines in found.items() if lines}


class MeasureTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()

    def wav(self, name, samples):
        path = os.path.join(self.folder, name)
        sf.write(path, np.asarray(samples, dtype="float32"), 16000)
        return path

    def test_length_loudness_and_clipping_are_read_from_the_file(self):
        tone = 0.3 * np.sin(np.linspace(0, 2000, 16000))
        info = dc.measure(self.wav("tone.wav", tone))
        self.assertAlmostEqual(info["seconds"], 1.0, places=2)
        self.assertTrue(-20 < info["db"] < -10)
        self.assertEqual(info["clipped"], 0.0)
        self.assertLess(dc.measure(self.wav("silence.wav", np.zeros(8000)))["db"], dc.SILENT_DB)
        self.assertGreater(dc.measure(self.wav("loud.wav", np.clip(tone * 10, -1, 1)))["clipped"], dc.CLIPPED_SHARE)

    def test_a_file_that_is_missing_or_not_sound_measures_as_nothing(self):
        self.assertIsNone(dc.measure(os.path.join(self.folder, "missing.wav")))
        bad = os.path.join(self.folder, "bad.wav")
        open(bad, "wb").close()
        self.assertIsNone(dc.measure(bad))

    def test_a_file_is_measured_again_only_when_it_changes(self):
        path = self.wav("a.wav", np.zeros(16000))
        first = dc.measure(path)
        self.assertIs(dc.measure(path), first)
        sf.write(path, np.zeros(32000, dtype="float32"), 16000)
        os.utime(path, (os.path.getmtime(path) + 5,) * 2)
        self.assertAlmostEqual(dc.measure(path)["seconds"], 2.0, places=2)


class DubCheckTest(unittest.TestCase):
    def normal(self, n=8):
        return [line(f"n{i}", i * 10.0, 2.0) for i in range(n)]

    def check(self, segments):
        segments = sorted(segments, key=lambda s: s.start_time)
        return kinds(dc.check_dub(segments, measure=measured(segments)))

    def test_a_good_dub_raises_nothing(self):
        self.assertEqual(self.check(self.normal()), {})

    def test_silent_and_empty_voices_are_found(self):
        found = self.check(self.normal() + [line("quiet", 100, 2.0, db=-70), line("empty", 110, 0.05)])
        self.assertEqual(found, {"silent": ["quiet", "empty"]})

    def test_rushed_and_cut_short_are_judged_against_the_rest_of_the_episode(self):
        found = self.check(self.normal() + [line("fast", 100, 1.2), line("cut", 110, 0.5), line("short", 120, 0.3, text="ហេ!")])
        self.assertEqual(found, {"rushed": ["fast"], "cut_short": ["cut"]})     # "ហេ!" is too short to judge

    def test_a_voice_still_speaking_into_the_next_line_is_found(self):
        segments = self.normal(8) + [line("long", 100, 2.0), line("next", 101.2, 2.0)]
        self.assertEqual(self.check(segments), {"runs_over": ["long"]})

    def test_distortion_and_unreadable_files(self):
        segments = self.normal() + [line("loud", 100, 2.0, clipped=0.02), line("unread", 110, 2.0)]
        segments[-1].info = None
        self.assertEqual(self.check(segments), {"distorted": ["loud"]})

    def test_the_project_review_holds_an_export_for_a_silent_voice(self):
        segments = self.normal() + [line("quiet", 100, 2.0, db=-70)]
        result = review_project(segments, "km", 200.0, file_exists=lambda path: True, measure=measured(segments))
        silent = next(i for i in result["issues"] if i["key"] == "silent")
        self.assertEqual((silent["severity"], silent["segment_ids"]), ("problem", ["quiet"]))


class FlaggedLinesTest(unittest.TestCase):
    def test_every_reason_is_listed_per_line_in_time_order(self):
        segments = [line(f"n{i}", i * 10.0, 2.0) for i in range(8)] + [
            line("novoice", 100), line("english", 110, 2.0, text="Hello there friend"),
            line("gone", 120, 2.0), line("quiet", 130, 2.0, db=-70)]
        segments[-2].audio_url = "/v/lost.mp3"
        found = flagged_lines(segments, "km", 400.0, file_exists=lambda path: "lost" not in path, measure=measured(segments))
        self.assertEqual([(f["segment"].id, f["kind"]) for f in found],
                         [("novoice", "unvoiced"), ("english", "untranslated"), ("gone", "audio_missing"), ("quiet", "silent")])
        self.assertEqual([f["redub"] for f in found], [True, False, True, True])

    def test_locked_spellings_are_checked_when_the_series_memory_is_given(self):
        seg = line("s", 0, text="សួស្តី តាំង")
        seg.original_text = "唐你好"
        memory = SeriesMemory(terms=[{"source": "唐", "target": "ថាង"}])
        found = flagged_lines([seg], "km", 10.0, memory=memory)
        self.assertEqual([(f["kind"], f["detail"]) for f in found], [("spelling", "Expected 唐 → ថាង")])
        self.assertEqual(flagged_lines([seg], "km", 10.0), [])

    def test_a_caption_that_flashes_by_is_found_and_one_given_its_time_is_not(self):
        flash = line("flash", 0, end=0.6)                       # 24 letters need about 1.5 s
        fine = line("fine", 10, end=11.4)
        short = line("short", 20, text="ហេ!", end=20.8)        # needs 1.2 s; shown 0.8
        found = flagged_lines([flash, fine, short], "km", 60.0)
        self.assertEqual([(f["segment"].id, f["kind"]) for f in found if f["kind"] == "too_brief"], [("flash", "too_brief"), ("short", "too_brief")])
        self.assertIn("1.5 s to read", found[0]["detail"])
        review = review_project([flash, fine, short], "km", 60.0)
        self.assertEqual(next(i for i in review["issues"] if i["key"] == "too_brief")["segment_ids"], ["flash", "short"])

    def test_an_undubbed_project_is_not_a_list_of_missing_voices(self):
        self.assertEqual(flagged_lines([line("a", 0), line("b", 10)], "km", 30.0), [])


class SeriesReviewRouteTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as db:
            db.add_all([Project(id="a", name="S - Episode 001", batch_id="s", batch_index=0, language="km", duration=60),
                        Project(id="b", name="S - Episode 002", batch_id="s", batch_index=1, language="km", duration=60),
                        Project(id="z", name="Other", batch_id="o", language="km", duration=60)])
            db.add_all([
                Segment(id="a1", project_id="a", index=0, start_time=0, end_time=2, text="សួស្តី", audio_url="/v/a1.mp3"),
                Segment(id="b1", project_id="b", index=0, start_time=0, end_time=2, text="សួស្តី", audio_url="/v/b1.mp3"),
                Segment(id="b2", project_id="b", index=1, start_time=5, end_time=7, text="Hello friend", audio_url="/v/b2.mp3"),
                Segment(id="b3", project_id="b", index=2, start_time=9, end_time=11, text="សួស្តី", audio_url=""),
                Segment(id="z1", project_id="z", index=0, start_time=0, end_time=2, text="Hello", audio_url="/v/z1.mp3"),
            ])
            await db.commit()

    async def asyncTearDown(self):
        await self.engine.dispose()

    async def test_the_queue_lists_the_series_lines_with_their_episode(self):
        from backend.api.routes.series import series_review
        async with self.sessions() as db:
            result = await series_review("a", db)        # none of the voice files exist on disk
        self.assertEqual((result["episodes_checked"], result["episodes_flagged"], result["total"]), (2, 2, 5))
        self.assertEqual([(i["episode"], i["segment_id"], i["kind"]) for i in result["items"]],
                         [(1, "a1", "audio_missing"), (2, "b1", "audio_missing"), (2, "b2", "audio_missing"),
                          (2, "b2", "untranslated"), (2, "b3", "unvoiced")])
        self.assertEqual(list(result["kinds"]), ["unvoiced", "audio_missing", "untranslated"])
        self.assertEqual(result["kinds"]["audio_missing"], {"label": "Voice file missing", "severity": "problem", "redub": True, "count": 3})

    async def test_redub_clears_only_this_series_lines_and_queues_their_episodes(self):
        from backend.api.routes import pipeline
        from backend.api.routes.series import RedubRequest, redub_lines
        async with self.sessions() as db:
            with patch.object(pipeline, "add_to_pipeline", AsyncMock()) as queue:
                result = await redub_lines("a", RedubRequest(segment_ids=["a1", "b1", "z1", "nope"]), db)
            self.assertEqual(result, {"lines": 2, "episodes": 2, "queued": 2, "busy": 0})
            self.assertEqual(sorted(call.args[0] for call in queue.await_args_list), ["a", "b"])
            self.assertEqual((await db.get(Segment, "a1")).audio_url, "")
            self.assertEqual((await db.get(Segment, "z1")).audio_url, "/v/z1.mp3")

    async def test_fix_all_corrects_spellings_and_queues_only_episodes_with_something_to_repair(self):
        from backend.api.routes import pipeline, series
        async with self.sessions() as db:
            with patch.object(pipeline, "add_to_pipeline", AsyncMock()) as queue, \
                 patch.object(series, "fix_spellings", AsyncMock(return_value={"found": 3, "fixed": 2})):
                result = await series.fix_series("a", db)
        self.assertEqual(result, {"spellings_found": 3, "spellings_fixed": 2, "spelling_error": "", "queued": 2, "busy": 0})
        options = queue.await_args_list[0].args[1]
        self.assertEqual((options.captions, options.repair, options.dub, options.export), (False, True, True, False))

    async def test_an_episode_with_only_untranslated_lines_is_not_queued(self):
        from backend.api.routes import pipeline, series
        async with self.sessions() as db:
            for seg_id in ("a1", "b1", "b2"):
                (await db.get(Segment, seg_id)).audio_url = ""
            await db.delete(await db.get(Segment, "b3"))
            await db.commit()
            with patch.object(pipeline, "add_to_pipeline", AsyncMock()) as queue, \
                 patch.object(series, "fix_spellings", AsyncMock(return_value={"found": 0, "fixed": 0})):
                result = await series.fix_series("a", db)
        self.assertEqual(result["queued"], 0)
        queue.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
