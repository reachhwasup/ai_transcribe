import unittest
from types import SimpleNamespace

from backend.services.review import review_project


def line(i, text="សួស្តីអ្នកទាំងអស់គ្នា", start=None, seconds=3.0, speaker="Lin", profile="female", audio="/uploads/tts/a.mp3"):
    start = i * 4.0 if start is None else start
    return SimpleNamespace(id=f"s{i}", text=text, start_time=start, end_time=start + seconds,
                           speaker=speaker, voice_profile=profile, audio_url=audio)


def keys(result):
    return {issue["key"]: issue for issue in result["issues"]}


class ReviewTest(unittest.TestCase):
    def review(self, segments):
        return review_project(segments, "km", 200.0, file_exists=lambda path: "gone" not in path)

    def test_a_finished_project_has_nothing_to_report(self):
        out = self.review([line(i) for i in range(5)])
        self.assertEqual((out["issues"], out["problems"], out["voiced"]), ([], 0, 5))

    def test_lines_without_a_voice_are_a_problem_once_dubbing_has_started(self):
        segs = [line(0), line(1, audio=""), line(2, audio="")]
        self.assertEqual(keys(self.review(segs))["unvoiced"]["count"], 2)
        # captions only, nothing dubbed yet: that is a subtitle export, not a half-finished dub
        self.assertNotIn("unvoiced", keys(self.review([line(i, audio="") for i in range(3)])))

    def test_missing_files_untranslated_text_and_no_captions(self):
        out = keys(self.review([line(0, audio="/uploads/tts/gone.mp3"), line(1, text="你来了"), line(2, text="12:30")]))
        self.assertEqual(out["audio_missing"]["segment_ids"], ["s0"])
        self.assertEqual(out["untranslated"]["segment_ids"], ["s1"])        # digits alone are not a language
        self.assertEqual(self.review([])["issues"][0]["key"], "no_captions")

    def test_things_worth_a_look_are_checks_not_problems(self):
        segs = [
            line(0, text="ក" * 120, seconds=2.0),                           # far too much text for 4s of room
            line(1, start=4.0, seconds=5.0),                                # runs over the next line
            line(2, start=8.0, speaker="Qin", profile="male"),
            line(3, start=12.0, speaker="Qin", profile="female"),           # the same man, dubbed as a woman
        ]
        out = self.review(segs)
        found = keys(out)
        self.assertEqual({k: v["severity"] for k, v in found.items()},
                         {"too_long": "check", "overlap": "check", "too_brief": "check", "mixed_voice": "check"})
        self.assertEqual((out["problems"], out["checks"]), (0, 4))      # 120 letters in 2 s cannot be read either
        self.assertEqual(found["mixed_voice"]["title"], "1 character is dubbed as both a man and a woman")


if __name__ == "__main__":
    unittest.main()
