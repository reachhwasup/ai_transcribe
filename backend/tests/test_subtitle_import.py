import unittest

from backend.services.subtitle_import import SubtitleError, decode, guess_language, parse_subtitles


def read(name, text, encoding="utf-8"):
    return parse_subtitles(name, text.encode(encoding))


class FormatTest(unittest.TestCase):
    def test_srt_with_and_without_numbers_and_short_timecodes(self):
        srt = "1\n00:00:01,000 --> 00:00:03,500\nHello\nthere\n\n00:05.2 --> 00:07.25\nNo number, short time\n"
        cues = read("a.srt", srt)["cues"]
        self.assertEqual([(c["start"], c["end"], c["text"]) for c in cues],
                         [(1.0, 3.5, "Hello there"), (5.2, 7.25, "No number, short time")])

    def test_webvtt_with_header_notes_settings_and_voice_tags(self):
        vtt = ("WEBVTT\n\nNOTE made by a tool\n\n00:01.000 --> 00:03.000 line:90% align:center\n<v Roger>Where is <i>she</i>?\n\n"
               "intro\n00:00:04.000 --> 00:00:05.000\n<v Anna>Here.\n")
        out = read("a.vtt", vtt)
        self.assertEqual(out["format"], "WebVTT")
        self.assertEqual([(c["speaker"], c["text"]) for c in out["cues"]], [("Roger", "Where is she?"), ("Anna", "Here.")])

    def test_ass_reads_the_name_column_and_drops_tags_comments_and_drawings(self):
        ass = ("[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\n\n[Events]\n"
               "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
               "Dialogue: 0,0:00:01.00,0:00:03.50,Default,秦风,0,0,0,,{\\an8\\fs40}粗糙是粗糙，\\N能成都行\n"
               "Comment: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,a note\n"
               "Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\n")
        out = read("a.ass", ass)
        self.assertEqual(out["format"], "ASS")
        self.assertEqual(out["cues"], [{"start": 1.0, "end": 3.5, "text": "粗糙是粗糙， 能成都行", "speaker": "秦风"}])

    def test_the_apps_own_json_keeps_original_text_and_speakers(self):
        out = read("a.json", '{"segments": [{"start_time": 1, "end_time": 2, "text": "សួស្តី", "original_text": "你好", "speaker": "Lin"}]}')
        self.assertEqual((out["cues"][0]["original"], out["cues"][0]["speaker"]), ("你好", "Lin"))

    def test_a_file_with_no_timings_says_so(self):
        with self.assertRaisesRegex(SubtitleError, "no timings"):
            read("a.txt", "just some lines\nof text\n")


class EncodingTest(unittest.TestCase):
    def test_chinese_windows_files_are_not_turned_into_gibberish(self):
        srt = "1\n00:00:01,000 --> 00:00:02,000\n粗糙是粗糙，能成都行。\n"
        out = read("a.srt", srt, "gb18030")
        self.assertEqual(out["cues"][0]["text"], "粗糙是粗糙，能成都行。")
        self.assertIn("GB18030", out["encoding"])

    def test_utf16_and_bom(self):
        srt = "1\n00:00:01,000 --> 00:00:02,000\nសួស្តី\n"
        self.assertEqual(read("a.srt", srt, "utf-16")["cues"][0]["text"], "សួស្តី")
        self.assertEqual(decode(b"\xef\xbb\xbfabc"), ("abc", "UTF-8"))

    def test_a_western_file_is_not_mistaken_for_chinese(self):
        text, encoding = decode("Café déjà vu — voilà".encode("cp1252"))
        self.assertEqual((text, encoding), ("Café déjà vu — voilà", "Windows-1252"))


class CleanupTest(unittest.TestCase):
    def cue(self, n, start, text):
        return f"{n}\n00:00:{start:02d},000 --> 00:00:{start + 2:02d},000\n{text}\n\n"

    def test_speaker_prefixes_are_used_only_when_the_file_makes_a_habit_of_them(self):
        habit = "".join(self.cue(i, i * 3, t) for i, t in enumerate(
            ["Lin: Where were you?", "Chen: At the market.", "Lin: All day?", "Chen: Yes.", "[Narrator] Later that night"]))
        out = read("a.srt", habit)
        self.assertEqual([(c["speaker"], c["text"]) for c in out["cues"][:2]], [("Lin", "Where were you?"), ("Chen", "At the market.")])
        self.assertEqual(out["speakers"], ["Chen", "Lin"])          # a name used once is not a pattern

        once = self.cue(1, 0, "Note: he left at 5:30") + self.cue(2, 3, "She stayed.") + self.cue(3, 6, "Nobody spoke.")
        self.assertEqual(read("a.srt", once)["cues"][0], {"start": 0.0, "end": 2.0, "text": "Note: he left at 5:30", "speaker": ""})

    def test_music_empty_backwards_and_doubled_cues_are_dropped_and_counted(self):
        srt = (self.cue(1, 0, "[Music]") + self.cue(2, 3, "Real line") + self.cue(3, 3, "Real line")
               + "4\n00:00:09,000 --> 00:00:08,000\nBackwards\n\n" + self.cue(5, 12, "<i></i>"))
        out = read("a.srt", srt)
        self.assertEqual([c["text"] for c in out["cues"]], ["Real line"])
        self.assertEqual(out["dropped"], {"empty": 1, "music": 1, "bad_time": 1, "duplicate": 1})

    def test_language_is_guessed_from_the_script(self):
        self.assertEqual(guess_language("粗糙是粗糙，能成都行。就是现在。"), "zh")
        self.assertEqual(guess_language("សួស្តី តើអ្នកសុខសប្បាយទេ"), "km")
        self.assertEqual(guess_language("12 34"), "")


if __name__ == "__main__":
    unittest.main()


class ImportRouteTest(unittest.IsolatedAsyncioTestCase):
    """The whole path: a file, through the route, into a project."""

    async def asyncSetUp(self):
        from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
        from backend.database.db import Base
        from backend.database.models import Project, VideoClip

        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.db = async_sessionmaker(self.engine, expire_on_commit=False)()
        self.db.add(Project(id="p", name="Film", language="km", duration=120.0, video_path="film.mp4"))
        # the first minute of the file was cut from the timeline
        self.db.add(VideoClip(id="c", project_id="p", index=0, source_start=60.0, source_end=120.0))
        await self.db.commit()

    async def asyncTearDown(self):
        await self.db.close()
        await self.engine.dispose()

    def upload(self, name, text):
        import io
        from fastapi import UploadFile
        return UploadFile(filename=name, file=io.BytesIO(text.encode("utf-8")))

    SRT = ("1\n00:00:01,000 --> 00:00:03,000\nLin: 你来了\n\n2\n00:00:04,000 --> 00:00:06,000\nChen: 我来了\n\n"
           "3\n00:00:07,000 --> 00:00:09,000\nLin: 坐吧\n\n4\n00:01:30,000 --> 00:01:32,000\nChen: 太晚了\n")

    async def test_preview_says_what_would_happen_and_changes_nothing(self):
        from sqlalchemy import func, select
        from backend.api.routes.transcripts import preview_subtitle_import
        from backend.database.models import Segment

        out = await preview_subtitle_import("p", self.upload("ep.srt", self.SRT), self.db)
        self.assertEqual((out["lines"], out["beyond_timeline"], out["language"], out["needs_translation"]), (3, 1, "zh", True))
        self.assertEqual(out["speakers"], ["Chen", "Lin"])
        self.assertEqual((await self.db.execute(select(func.count(Segment.id)))).scalar(), 0)

    async def test_import_lands_on_the_visible_clip_with_its_speakers(self):
        from backend.api.routes.transcripts import import_srt

        segs = await import_srt("p", self.upload("ep.srt", self.SRT), "replace", self.db)
        self.assertEqual([(s.start_time, s.speaker, s.text) for s in segs],
                         [(61.0, "Lin", "你来了"), (64.0, "Chen", "我来了"), (67.0, "Lin", "坐吧")])
        self.assertEqual(segs[0].original_text, "你来了")

    async def test_a_second_file_becomes_the_translation_matched_by_time(self):
        from backend.api.routes.transcripts import import_srt

        await import_srt("p", self.upload("zh.srt", self.SRT), "replace", self.db)
        khmer = ("1\n00:00:01,100 --> 00:00:02,900\nអ្នកមកហើយ\n\n2\n00:00:04,200 --> 00:00:05,000\nខ្ញុំមក\n\n"
                 "3\n00:00:05,000 --> 00:00:06,000\nហើយ\n\n4\n00:00:20,000 --> 00:00:21,000\nគ្មានអ្នកណាទេ\n")
        segs = await import_srt("p", self.upload("km.srt", khmer), "translation", self.db)
        self.assertEqual([(s.original_text, s.text) for s in segs],
                         [("你来了", "អ្នកមកហើយ"), ("我来了", "ខ្ញុំមក ហើយ"), ("坐吧", "坐吧")])   # no line at 7s: left as it was
        self.assertEqual(segs[0].speaker, "Lin")                                               # the cast is kept

    async def test_an_unreadable_file_is_refused_with_a_reason(self):
        from fastapi import HTTPException
        from backend.api.routes.transcripts import import_srt

        with self.assertRaises(HTTPException) as caught:
            await import_srt("p", self.upload("notes.txt", "just words"), "replace", self.db)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("no timings", caught.exception.detail)
