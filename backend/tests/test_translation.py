import json
import re
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from backend.services import gemini_service as gs
from backend.api.routes.transcripts import _translation_lines


def line(i, text, speaker="Tang", profile="male", start=None):
    start = i * 3.0 if start is None else start
    return {"id": f"s{i}", "text": text, "speaker": speaker, "voice_profile": profile,
            "start_time": start, "end_time": start + 2.0}


def reply(payload):
    return SimpleNamespace(text=json.dumps(payload, ensure_ascii=False))


def numbered_lines(prompt):
    return re.findall(r"^(\d+)\. ", prompt.split("Lines to translate:")[1], flags=re.M)


class PromptTest(unittest.TestCase):
    def test_each_line_carries_its_time_and_a_length_to_aim_for(self):
        prompt = gs._build_translation_prompt([line(0, "你好")], "km", "Khmer")
        self.assertIn("1. (2.0s, about 32 characters) [Tang]: 你好", prompt)

    def test_the_heard_voice_is_named_only_when_asked(self):
        seg = [line(0, "你好", profile="female")]
        self.assertIn("[Tang, woman]", gs._build_translation_prompt(seg, "km", "Khmer", with_gender=True))
        self.assertIn("[Tang]:", gs._build_translation_prompt(seg, "km", "Khmer"))

    def test_neighbours_and_glossary_reach_the_translator(self):
        before = [dict(line(0, "唐兄"), translation="បងថាង")]
        prompt = gs._build_translation_prompt([line(1, "你好")], "km", "Khmer", glossary="唐伯虎 = តាំង ប៉ូហ៊ូ", before=before)
        self.assertIn("唐伯虎 = តាំង ប៉ូហ៊ូ", prompt)
        self.assertIn("- [Tang]: 唐兄  =>  បងថាង", prompt)
        self.assertEqual(numbered_lines(prompt), ["1"])   # the neighbour is not a line to translate


class TranslateTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        gs._translation_cache.clear()
        gs._glossary_cache.clear()

    async def run_translate(self, segments, replies, context=None):
        calls = []

        async def fake(prompt, generation_config=None, **_):
            calls.append(prompt)
            return replies(prompt)

        with patch.object(gs, "_configure_genai", AsyncMock()), patch.object(gs, "_generate_with_fallback", fake):
            return await gs.translate_segments(segments, "km", context), calls

    async def test_a_retry_asks_only_for_the_missing_lines(self):
        segments = [line(i, f"第{i}句") for i in range(3)]
        seen = []

        def replies(prompt):
            seen.append(numbered_lines(prompt))
            if len(seen) == 1:
                return reply([{"index": 1, "text": "មួយ"}, {"index": 3, "text": "បី"}])
            return reply([{"index": 1, "text": "ពីរ"}])

        out, _ = await self.run_translate(segments, replies)
        self.assertEqual(seen, [["1", "2", "3"], ["1"]])
        self.assertEqual([s["text"] for s in out], ["មួយ", "ពីរ", "បី"])

    async def test_a_long_dialogue_gets_one_glossary_used_by_every_batch(self):
        segments = [line(i, f"唐伯虎说第{i}句", profile="male" if i % 2 else "female") for i in range(40)]

        def replies(prompt):
            if "preparing a film's dialogue" in prompt:
                return reply({"terms": [{"source": "唐伯虎", "target": "តាំង ប៉ូហ៊ូ"}], "notes": "Tang is a man."})
            return reply([{"index": int(n), "text": f"ខ្មែរ{n}"} for n in numbered_lines(prompt)])

        out, calls = await self.run_translate(segments, replies)
        batches = [c for c in calls if "preparing a film's dialogue" not in c]
        self.assertEqual(len(calls) - len(batches), 1)
        self.assertEqual(len(batches), 2)
        for prompt in batches:
            self.assertIn("唐伯虎 = តាំង ប៉ូហ៊ូ", prompt)
            self.assertIn("Notes: Tang is a man.", prompt)
        # the second batch sees the end of the first as context
        self.assertIn("EARLIER LINES", batches[1])
        self.assertIn("唐伯虎说第29句  =>  ខ្មែរ30", batches[1])
        self.assertIn("唐伯虎说第29句", batches[1].split("Lines to translate:")[0])
        self.assertTrue(all(s["text"].startswith("ខ្មែរ") for s in out))

    async def test_mixed_script_is_retried_without_deleting_source_words(self):
        answers = iter([reply([{"index": 1, "text": "សួស្តី 唐伯虎"}]),
                        reply([{"index": 1, "text": "សួស្តី តាំង ប៉ូហ៊ូ"}])])
        out, calls = await self.run_translate([line(0, "你好唐伯虎")], lambda _: next(answers))
        self.assertEqual(len(calls), 2)
        self.assertEqual(out[0]["text"], "សួស្តី តាំង ប៉ូហ៊ូ")

    async def test_invalid_translation_keeps_source_after_retries(self):
        out, _ = await self.run_translate([line(0, "你好")],
            lambda _: reply([{"index": 1, "text": "Hello"}]))
        self.assertEqual(out[0]["text"], "你好")

    async def test_translation_carries_on_when_the_glossary_fails(self):
        segments = [line(i, f"第{i}句") for i in range(15)]

        def replies(prompt):
            if "preparing a film's dialogue" in prompt:
                raise RuntimeError("quota")
            return reply([{"index": int(n), "text": f"ខ្មែរ{n}"} for n in numbered_lines(prompt)])

        out, _ = await self.run_translate(segments, replies)
        self.assertTrue(all(s["text"].startswith("ខ្មែរ") for s in out))

    async def test_one_line_is_translated_with_the_lines_around_it(self):
        story = [dict(line(i, f"第{i}句"), translation="" if i == 5 else f"បន្ទាត់{i}") for i in range(10)]

        def replies(prompt):
            return reply([{"index": 1, "text": "ថ្មី"}])

        _, calls = await self.run_translate([story[5]], replies, context=story)
        prompt = calls[-1]
        self.assertEqual(numbered_lines(prompt), ["1"])
        self.assertIn("第4句  =>  បន្ទាត់4", prompt)
        self.assertIn("第6句  =>  បន្ទាត់6", prompt)


class RouteLinesTest(unittest.TestCase):
    def test_a_line_outside_the_run_keeps_its_translation_as_context(self):
        rows = [
            SimpleNamespace(id="a", start_time=0, end_time=2, text="សួស្តី", original_text="你好", speaker="Tang", voice_profile="male"),
            SimpleNamespace(id="b", start_time=2, end_time=4, text="再见", original_text="再见", speaker="Tang", voice_profile="male"),
        ]
        chosen, lines, story = _translation_lines(rows, ["b"])
        self.assertEqual([s.id for s in chosen], ["b"])
        self.assertEqual(lines[0]["text"], "再见")
        self.assertEqual(story[0]["translation"], "សួស្តី")
        self.assertEqual(story[1]["translation"], "")


if __name__ == "__main__":
    unittest.main()


class ShortenLinesTest(unittest.IsolatedAsyncioTestCase):
    async def test_each_line_is_asked_for_within_its_own_limit(self):
        seen = []

        async def fake(prompt, generation_config=None, **_):
            seen.append(prompt)
            return reply([{"index": 1, "text": "ខ្លី"}, {"index": 2, "text": ""}])

        items = [
            {"source": "你到底想怎么样", "text": "តើអ្នកចង់បានអ្វីពីខ្ញុំឱ្យប្រាកដ", "max_chars": 18},
            {"source": "", "text": "បន្ទាត់ទីពីរដែលវែងពេក", "max_chars": 12},
        ]
        with patch.object(gs, "_configure_genai", AsyncMock()), patch.object(gs, "_generate_with_fallback", fake):
            out = await gs.shorten_lines(items, "km")
        self.assertEqual(out, ["ខ្លី", ""])                    # no rewrite is reported as none
        self.assertIn("1. (limit 18 characters; now", seen[0])
        self.assertIn("original: 你到底想怎么样", seen[0])
        self.assertIn("2. (limit 12 characters; now", seen[0])

    async def test_a_failed_request_returns_nothing_rather_than_raising(self):
        with patch.object(gs, "_configure_genai", AsyncMock()), \
             patch.object(gs, "_generate_with_fallback", AsyncMock(side_effect=RuntimeError("quota"))):
            out = await gs.shorten_lines([{"source": "", "text": "វែង", "max_chars": 8}], "km")
        self.assertEqual(out, [""])


class LabelSpeakersTest(unittest.IsolatedAsyncioTestCase):
    async def test_lines_are_matched_back_by_their_label_and_names_carry_forward(self):
        lines = [
            {"id": "a", "start_time": 3.0, "end_time": 5.0, "text": "你来了"},
            {"id": "b", "start_time": 130.0, "end_time": 132.0, "text": "我来了"},
            {"id": "c", "start_time": 134.0, "end_time": 135.0, "text": "坐吧"},
        ]
        prompts = []

        async def fake(path, prompt):
            prompts.append(prompt)
            if len(prompts) == 1:
                return [{"text": "L1", "original_text": "L1", "speaker": "Mother", "voice_profile": "female", "emotion": "calm"}]
            # out of order, one unusable answer, one for a line that was not asked about
            return [
                {"text": "L2", "original_text": "L2", "speaker": "Mother", "voice_profile": "female", "emotion": "neutral"},
                {"text": "L1", "original_text": "L1", "speaker": "Qin Feng", "voice_profile": "male", "emotion": "serious"},
                {"text": "L9", "original_text": "L9", "speaker": "Nobody", "voice_profile": "male", "emotion": "neutral"},
            ]

        chunks = ([("c0.mp3", 0.0), ("c1.mp3", 116.0)], None)
        with patch.object(gs, "_configure_genai", AsyncMock()), \
             patch.object(gs, "_split_video_chunks", AsyncMock(return_value=chunks)), \
             patch.object(gs, "_transcribe_media_with_fallback", fake):
            out = await gs.label_speakers("film.mp4", lines)

        self.assertEqual({k: v["speaker"] for k, v in out.items()}, {"a": "Mother", "b": "Qin Feng", "c": "Mother"})
        self.assertEqual(out["b"]["voice_profile"], "male")
        self.assertIn("L1 [3.0s–5.0s] 你来了", prompts[0])
        # the second stretch starts at 116s, so 130s is 14s into its audio — and it is told who Mother is
        self.assertIn("L1 [14.0s–16.0s] 我来了", prompts[1])
        self.assertIn("- Mother (female)", prompts[1])

    async def test_a_stretch_that_fails_is_left_unlabelled_not_guessed(self):
        with patch.object(gs, "_configure_genai", AsyncMock()), \
             patch.object(gs, "_split_video_chunks", AsyncMock(return_value=([("c0.mp3", 0.0)], None))), \
             patch.object(gs, "_transcribe_media_with_fallback", AsyncMock(side_effect=RuntimeError("quota"))):
            out = await gs.label_speakers("film.mp4", [{"id": "a", "start_time": 1.0, "end_time": 2.0, "text": "你好"}])
        self.assertEqual(out, {})
