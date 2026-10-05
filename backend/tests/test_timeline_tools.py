import unittest
from types import SimpleNamespace

from backend.api.routes import timeline_sync as ts


def line(start, end, text="ក" * 20, speaker="Lin", audio_url=""):
    return SimpleNamespace(start_time=start, end_time=end, text=text, speaker=speaker, audio_url=audio_url)


class VoiceFitTest(unittest.TestCase):
    def test_a_voice_that_fits_is_left_alone(self):
        self.assertEqual(ts.plan_voice_fit(2.9, 3.0, 3.0), (1.0, "left"))

    def test_a_short_voice_is_not_dragged_out_to_fill_a_long_caption(self):
        # 1.3s of speech in a 3s box used to be played at 0.43x
        self.assertEqual(ts.plan_voice_fit(1.3, 3.0, 3.0), (1.0, "left"))

    def test_a_voice_just_short_of_its_box_is_slowed_to_end_with_it(self):
        tempo, outcome = ts.plan_voice_fit(2.6, 3.0, 3.0)
        self.assertEqual(outcome, "slowed")
        self.assertAlmostEqual(tempo, 2.6 / 3.0)

    def test_an_overrun_into_silence_is_not_sped_up(self):
        self.assertEqual(ts.plan_voice_fit(3.6, 3.0, 5.0), (1.0, "runs_on"))

    def test_an_overrun_into_the_next_line_is_sped_up_to_fit(self):
        tempo, outcome = ts.plan_voice_fit(3.9, 3.0, 3.0)
        self.assertEqual(outcome, "sped_up")
        self.assertAlmostEqual(tempo, 1.3)

    def test_speed_is_capped_and_the_line_reported(self):
        # 5s of speech with 1s of room used to be played at 5x
        self.assertEqual(ts.plan_voice_fit(5.0, 1.0, 1.0), (ts.AUTOFIT_MAX_SPEEDUP, "too_long"))


class TidyMergeTest(unittest.TestCase):
    def test_default_labels_do_not_name_a_character(self):
        for label in ("តួអង្គប្រុស (Male)", "តួអង្គស្រី (Female)", "Speaker 1 (Male)", "តួអង្គទី១ (ប្រុស)",
                      "ក្មេងស្រី (Girl)", "លោកតា (Grandpa)", "តួអង្គប្រុស", "Narrator"):
            self.assertIsNone(ts._named_speaker(label), label)
        for name in ("Tang Bohu", "Mother", "Young Man"):
            self.assertEqual(ts._named_speaker(name), name)

    def test_two_unnamed_men_are_not_joined_into_one_caption(self):
        pair = [line(0, 1.2, speaker="តួអង្គប្រុស (Male)"), line(1.3, 2.4, speaker="តួអង្គប្រុស (Male)")]
        self.assertEqual(ts._plan_merges(pair), [])

    def test_short_lines_of_one_character_are_joined(self):
        self.assertEqual(len(ts._plan_merges([line(0, 1.2), line(1.3, 2.4)])), 1)

    def test_dubbed_lines_keep_their_voices(self):
        pair = [line(0, 1.2, audio_url="/uploads/tts/a.mp3"), line(1.3, 2.4)]
        self.assertEqual(ts._plan_merges(pair), [])
        self.assertEqual(len(ts._plan_merges(pair, keep_dubbed=False)), 1)


class ReadingTimeTest(unittest.TestCase):
    def test_a_dubbed_line_keeps_its_start(self):
        # room only before the line: an undubbed caption leads in, a dubbed one must not,
        # because its voice starts where the caption starts
        for audio, moves in (("", True), ("/uploads/tts/a.mp3", False)):
            lines = [line(0, 1.0), line(4.0, 4.5, text="ក" * 40, audio_url=audio), line(4.6, 6.0)]
            ts._extend_for_reading(lines, 10.0)
            self.assertEqual(lines[1].start_time < 4.0, moves, audio)


if __name__ == "__main__":
    unittest.main()


class ExportBitrateTest(unittest.TestCase):
    """An export should not be several times the size of the video it was made from."""

    def test_a_lightly_compressed_source_is_not_inflated_to_the_preset(self):
        from backend.services.video_service import fit_video_bitrate
        vertical = 1080 * 1920
        # 0.52 Mbit/s HEVC in, 3.8 Mbit/s preset: the floor for this frame size, not the preset
        self.assertEqual(fit_video_bitrate(3_800_000, 520_000, "hevc", vertical), 1_500_000)
        # a richer H.264 source gets its own bitrate plus headroom
        self.assertEqual(fit_video_bitrate(3_800_000, 2_000_000, "h264", vertical), 3_000_000)

    def test_never_above_the_preset_and_unknown_sources_keep_it(self):
        from backend.services.video_service import fit_video_bitrate
        self.assertEqual(fit_video_bitrate(3_800_000, 9_000_000, "h264", 1080 * 1920), 3_800_000)
        self.assertEqual(fit_video_bitrate(3_800_000, 0, "", 1080 * 1920), 3_800_000)


class ShortenPlanTest(unittest.TestCase):
    def test_a_line_that_fits_is_left_alone(self):
        self.assertIsNone(ts.plan_shorten(40, 3.0))            # 13 chars/sec
        self.assertIsNone(ts.plan_shorten(58, 3.0))            # brisk, but within what a voice can do

    def test_far_too_much_text_gets_a_budget_for_its_time(self):
        self.assertEqual(ts.plan_shorten(90, 3.0), 52)         # 3s × 16 chars/sec × 1.1

    def test_a_voice_that_overruns_decides_the_cut(self):
        # 40 characters looked fine on paper, but the voice takes 4.5s for 3s of room
        self.assertEqual(ts.plan_shorten(40, 3.0, spoken=4.5), 26)

    def test_nothing_is_offered_when_there_is_nothing_to_cut(self):
        self.assertIsNone(ts.plan_shorten(9, 0.4))             # the floor is 8 characters
