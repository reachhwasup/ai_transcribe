import json
import unittest
from collections import Counter
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from backend.services import cast as c


def line(speaker, profile, text="台词"):
    return {"speaker": speaker, "voice_profile": profile, "text": text, "original_text": text}


class ChooseProfileTest(unittest.TestCase):
    def test_majority_decides_when_nothing_else_is_known(self):
        self.assertEqual(c.choose_profile(Counter({"male": 19, "female": 1})), "male")

    def test_the_decided_gender_wins_over_a_wrong_majority(self):
        # 21 lines heard as a man, 37 as a woman — but he is a man
        self.assertEqual(c.choose_profile(Counter({"male": 21, "female": 37}), "male"), "male")

    def test_age_follows_the_characters_own_lines(self):
        self.assertEqual(c.choose_profile(Counter({"grandpa": 5, "female": 2}), "male"), "grandpa")
        self.assertEqual(c.choose_profile(Counter({"female": 4}), "male", "elderly"), "grandpa")


class DecideCastTest(unittest.IsolatedAsyncioTestCase):
    lines = [line("Gu Yanshen", "female")] * 5 + [line("Gu Yanshen", "male")] * 3 + [line("តួអង្គប្រុស (Male)", "male")] * 4

    async def test_default_labels_are_not_characters(self):
        cast = await c.decide_cast(self.lines, use_ai=False)
        self.assertEqual(list(cast), ["Gu Yanshen"])
        self.assertEqual(cast["Gu Yanshen"]["profile"], "female")       # majority, with no other evidence
        self.assertEqual(cast["Gu Yanshen"]["decided_by"], "majority")

    async def test_the_dialogue_can_overrule_the_majority(self):
        reply = SimpleNamespace(text=json.dumps({"characters": [{"name": "Gu Yanshen", "gender": "male", "age": "adult"}]}))
        with patch("backend.services.gemini_client._configure_genai", AsyncMock()), \
             patch("backend.services.gemini_client._generate_with_fallback", AsyncMock(return_value=reply)):
            cast = await c.decide_cast(self.lines)
        self.assertEqual(cast["Gu Yanshen"]["profile"], "male")
        self.assertEqual(cast["Gu Yanshen"]["decided_by"], "dialogue")

    async def test_a_failed_request_falls_back_to_the_majority(self):
        with patch("backend.services.gemini_client._configure_genai", AsyncMock()), \
             patch("backend.services.gemini_client._generate_with_fallback", AsyncMock(side_effect=RuntimeError("quota"))):
            cast = await c.decide_cast(self.lines)
        self.assertEqual(cast["Gu Yanshen"]["decided_by"], "majority")


class ApplyCastTest(unittest.TestCase):
    cast = {"Gu Yanshen": {"profile": "male"}}

    def seg(self, profile, voice, audio):
        return SimpleNamespace(speaker="Gu Yanshen", voice_profile=profile, voice_name=voice, audio_url=audio)

    def test_wrong_lines_get_the_right_voice_and_lose_the_wrong_dub(self):
        wrong = self.seg("female", "km-KH-SreymomNeural", "/uploads/tts/a.mp3")
        right = self.seg("male", "km-KH-PisethNeural", "/uploads/tts/b.mp3")
        self.assertEqual(c.apply_cast_to_segments([wrong, right], self.cast), (1, 1))
        self.assertEqual((wrong.voice_profile, wrong.voice_name, wrong.audio_url), ("male", "km-KH-PisethNeural", ""))
        self.assertEqual(right.audio_url, "/uploads/tts/b.mp3")

    def test_a_captured_voice_is_a_choice_and_is_left_alone(self):
        cloned = self.seg("female", "My captured voice", "/uploads/tts/c.mp3")
        self.assertEqual(c.apply_cast_to_segments([cloned], self.cast), (1, 0))
        self.assertEqual((cloned.voice_name, cloned.audio_url), ("My captured voice", "/uploads/tts/c.mp3"))


if __name__ == "__main__":
    unittest.main()


class CastChangesTest(unittest.TestCase):
    """What the cast panel does: one change, every line of that character."""

    VOICES = {"male": "km-KH-PisethNeural", "female": "km-KH-SreymomNeural", "grandpa": "km-KH-PisethNeural"}

    def lines(self):
        def seg(speaker, profile, voice, audio=""):
            return SimpleNamespace(speaker=speaker, voice_profile=profile, voice_name=voice, audio_url=audio, audio_speed=1.2)
        return [
            seg("Young Man", "female", "km-KH-SreymomNeural", "/uploads/tts/a.mp3"),
            seg("Qin Feng", "male", "km-KH-PisethNeural", "/uploads/tts/b.mp3"),
            seg("Young Man", "female", "km-KH-SreymomNeural"),
            seg("Mother", "female", "km-KH-SreymomNeural", "/uploads/tts/c.mp3"),
        ]

    def apply(self, segs, changes):
        from backend.api.routes.transcripts import apply_cast_changes
        return apply_cast_changes(segs, changes, self.VOICES)

    def test_a_voice_type_moves_every_line_to_the_right_voice_and_drops_the_wrong_dubs(self):
        segs = self.lines()
        out = self.apply(segs, [{"name": "Young Man", "voice_profile": "male"}])
        self.assertEqual(out, {"lines": 2, "renamed": 0, "voices_cleared": 1})
        self.assertEqual([(s.voice_profile, s.voice_name, s.audio_url) for s in segs if s.speaker == "Young Man"],
                         [("male", "km-KH-PisethNeural", ""), ("male", "km-KH-PisethNeural", "")])
        self.assertEqual(segs[3].audio_url, "/uploads/tts/c.mp3")        # other characters untouched

    def test_renaming_merges_two_names_for_one_person_and_keeps_their_dubs(self):
        segs = self.lines()
        out = self.apply(segs, [{"name": "Young Man", "new_name": "Qin Feng"}])
        self.assertEqual((out["renamed"], out["voices_cleared"]), (2, 0))
        self.assertEqual([s.speaker for s in segs], ["Qin Feng", "Qin Feng", "Qin Feng", "Mother"])
        self.assertEqual(segs[0].audio_url, "/uploads/tts/a.mp3")

    def test_a_chosen_voice_is_set_and_blank_means_the_default_for_the_type(self):
        segs = self.lines()
        self.apply(segs, [{"name": "Mother", "voice_name": "My captured voice"}])
        self.assertEqual((segs[3].voice_name, segs[3].audio_url), ("My captured voice", ""))
        out = self.apply(segs, [{"name": "Mother", "voice_name": ""}])
        self.assertEqual(segs[3].voice_name, "km-KH-SreymomNeural")
        self.assertEqual(out["voices_cleared"], 0)                       # already cleared; nothing to lose

    def test_nothing_changes_when_the_character_already_matches(self):
        segs = self.lines()
        out = self.apply(segs, [{"name": "Qin Feng", "voice_profile": "male", "voice_name": "km-KH-PisethNeural"}])
        self.assertEqual(out, {"lines": 0, "renamed": 0, "voices_cleared": 0})
        self.assertEqual(segs[1].audio_url, "/uploads/tts/b.mp3")
