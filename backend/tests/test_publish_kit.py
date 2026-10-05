import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from backend.services import publish_kit as pk

GOOD = {
    "titles": [{"style": "curiosity", "text": "ចំណងជើងទីមួយ"}, {"style": "reveal", "text": "ចំណងជើងទីពីរ"}, "ចំណងជើងទីមួយ"],
    "hook": "តើគាត់ជានរណា?",
    "description": "បន្ទាត់ទីមួយ\n\nសាច់រឿង #movierecap #viral",
    "short_caption": "ខ្លី #fyp",
    "facebook_caption": "ហ្វេសប៊ុក",
    "hashtags": ["សម្រាយរឿង", "#movie recap", "#សម្រាយរឿង", ""],
    "seo_keywords": ["#សម្រាយរឿង", "movie recap khmer", "Movie Recap Khmer"],
    "pinned_comment": "តើអ្នកគិតយ៉ាងណា?",
    "thumbnail_texts": [{"angle": "shock", "main": "ម្ដាយលក់កូន", "highlight": "លក់", "sub": "គាត់ជាកូនប្រុសពិត"}, {"text": "ការពិត"}, "ម្ដាយលក់កូន",
                        {"angle": "versus", "main": "កូន vs ឪពុក", "highlight": "ប្អូន", "sub": "កូន vs ឪពុក"}],
}


class PromptTest(unittest.TestCase):
    def test_the_instructions_describe_no_particular_story(self):
        prompt = pk.build_prompt("Lin: 你好", "New", "km", "viral", "all")
        for leftover in ("គូយានសិន", "Wall Street", "សិនអៅ", "Gu Yanshen", "Tang Bohu"):
            self.assertNotIn(leftover, prompt)
        self.assertIn("Do not invent plot", prompt)
        self.assertIn("Say something the title does NOT already say", prompt)
        self.assertIn("Open a gap and leave it open", prompt)
        self.assertIn("every option must be true to the transcript", prompt)
        for angle, _ in pk.THUMBNAIL_ANGLES:                       # each angle is told what its job is
            self.assertIn(f'"{angle}": {pk.THUMBNAIL_JOBS[angle]}', prompt)
        self.assertNotIn("The project is called", prompt)          # a placeholder name is not a title
        self.assertIn("The project is called: 穿越古代", pk.build_prompt("x", "穿越古代", "km", "viral", "all"))

    def test_a_part_of_a_series_is_written_up_as_a_part(self):
        series = {"series_name": "ទាយមួយដង បង្ហាញឫទ្ធិ ២", "part": "12", "total_parts": 87, "premise": "A poor man inherits Taoist divination."}
        prompt = pk.build_prompt("Lin: 你好", "EP12", "km", "viral", "all", series)
        self.assertIn("It is part 12 of 87 of the series “ទាយមួយដង បង្ហាញឫទ្ធិ ២”.", prompt)
        self.assertIn("ONLY this part", prompt)
        self.assertIn("“ភាគ 12”", prompt)
        self.assertIn("This is not the ending", prompt)
        self.assertIn("A poor man inherits Taoist divination.", prompt)
        last = pk.build_prompt("x", "EP87", "km", "viral", "all", {**series, "part": 87})
        self.assertIn("This is the final part", last)
        self.assertNotIn("This is not the ending", last)
        # a video that is not part of anything is told nothing about series
        self.assertNotIn("PART OF A SERIES", pk.build_prompt("x", "Film", "km", "viral", "all", {"part": "", "premise": " "}))

    def test_the_part_number_is_found_in_a_project_name(self):
        for name, part in (("一卦显圣2 EP12", 12), ("show_087.mp4", 87), ("第3集", 3), ("ភាគ ១២", 12), ("Episode-5 final", 5), ("My film", 0)):
            self.assertEqual(pk.guess_part(name), part, name)
        self.assertEqual(pk.clean_series({"part": "abc", "total_parts": "87 ", "series_name": "  A   B "}),
                         {"series_name": "A B", "part": 0, "total_parts": 87, "premise": ""})

    def test_a_long_transcript_keeps_its_middle_and_end(self):
        lines = [f"line {i} " + "x" * 80 for i in range(1000)]
        sampled = pk.sample_transcript(lines, 6000)
        self.assertLess(len(sampled), 6200)
        self.assertIn("line 0 ", sampled)
        self.assertIn("line 999 ", sampled)
        self.assertIn("[… later …]", sampled)


class CleanTest(unittest.TestCase):
    def test_the_answer_is_tidied(self):
        kit = pk.clean_kit(GOOD)
        self.assertEqual([t["text"] for t in kit["titles"]], ["ចំណងជើងទីមួយ", "ចំណងជើងទីពីរ"])   # the repeat is dropped
        self.assertEqual(kit["titles"][0]["label"], "Curiosity gap")
        self.assertEqual(kit["hashtags"], ["#សម្រាយរឿង", "#movierecap"])
        self.assertEqual(kit["seo_keywords"], ["សម្រាយរឿង", "movie recap khmer"])
        self.assertEqual(kit["description"], "បន្ទាត់ទីមួយ\n\nសាច់រឿង")                          # tags live in their own list
        self.assertEqual(kit["thumbnail_texts"], [
            {"angle": "shock", "label": "Shock", "main": "ម្ដាយលក់កូន", "sub": "គាត់ជាកូនប្រុសពិត", "highlight": "លក់"},
            {"angle": "", "label": "", "main": "ការពិត", "sub": "", "highlight": ""},   # an older, plain answer still works
            # a second line that only repeats is dropped, and so is a highlight that is not in the line
            {"angle": "versus", "label": "Versus", "main": "កូន vs ឪពុក", "sub": "", "highlight": ""},
        ])

    def test_no_titles_is_not_an_answer(self):
        with self.assertRaises(ValueError):
            pk.clean_kit({"titles": [], "hook": "x"})


class GenerateTest(unittest.IsolatedAsyncioTestCase):
    async def run_kit(self, replies):
        with patch("backend.services.gemini_client._configure_genai", AsyncMock()), \
             patch("backend.services.gemini_client._generate_with_fallback", AsyncMock(side_effect=replies)) as ask:
            return await pk.generate_publish_kit(["Lin: 你好"], "Film", "km", "viral", "all"), ask

    async def test_a_bad_answer_is_asked_for_once_more(self):
        kit, ask = await self.run_kit([SimpleNamespace(text="not json"), SimpleNamespace(text=json.dumps(GOOD, ensure_ascii=False))])
        self.assertEqual(ask.await_count, 2)
        self.assertEqual(len(kit["titles"]), 2)

    async def test_failure_is_reported_not_papered_over_with_a_stock_package(self):
        with self.assertRaisesRegex(RuntimeError, "could not be reached"):
            await self.run_kit([RuntimeError("503"), RuntimeError("503")])
        with self.assertRaisesRegex(RuntimeError, "request limit"):
            await self.run_kit([RuntimeError("429 quota exceeded")])


if __name__ == "__main__":
    unittest.main()
