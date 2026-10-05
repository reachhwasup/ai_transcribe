import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.api.routes.caption_repair import _uncovered_ranges, _missed_speech_spans, _is_duplicate, _repeats_nearby_caption


class RepairDuplicateTests(unittest.TestCase):
    def test_combined_caption_coverage_rejects_duplicate(self):
        self.assertTrue(_is_duplicate(0, 10, [(0, 3), (3, 6)]))
        self.assertFalse(_is_duplicate(0, 10, [(0, 3), (0, 3)]))
        self.assertTrue(_is_duplicate(5, 5, []))

    def test_shifted_repeat_matches_source_even_when_translation_changes(self):
        existing = [SimpleNamespace(start_time=0, end_time=3, text='An older translation', original_text='Where are you going?')]
        self.assertTrue(_repeats_nearby_caption(3.4, 5, 'A new translation', 'Where are you going!', existing))
        self.assertFalse(_repeats_nearby_caption(10, 12, 'A new translation', 'Where are you going!', existing))
        self.assertFalse(_repeats_nearby_caption(3.4, 5, 'Different words', 'I am leaving now', existing))

    def test_short_repeated_response_is_preserved(self):
        existing = [SimpleNamespace(start_time=0, end_time=3, text='Yes', original_text='Yes')]
        self.assertFalse(_repeats_nearby_caption(3.4, 4, 'Yes', 'Yes', existing))


class UncoveredRangesTests(unittest.TestCase):
    def test_partial_caption_does_not_hide_rest_of_speech(self):
        self.assertEqual(_uncovered_ranges([(0, 10)], [(0, 2), (5, 7)]), [(2, 5), (7, 10)])

    def test_overlapping_and_nested_captions_are_unioned(self):
        self.assertEqual(_uncovered_ranges([(0, 12)], [(2, 3), (0, 8), (7, 10)]), [(10, 12)])

    def test_short_missing_line_is_included_but_timing_sliver_is_not(self):
        self.assertEqual(_uncovered_ranges([(0, 4)], [(0.1, 2), (2.5, 4)]), [(2, 2.5)])

    def test_empty_and_fully_captioned_regions(self):
        self.assertEqual(_uncovered_ranges([(0, 5)], []), [(0, 5)])
        self.assertEqual(_uncovered_ranges([(0, 5)], [(0, 6)]), [])


class MissedSpeechTests(unittest.IsolatedAsyncioTestCase):
    async def test_gap_padding_does_not_include_captioned_audio(self):
        with (
            patch('backend.api.routes.caption_repair.os.path.isfile', return_value=True),
            patch('backend.services.speech_align.detect_speech_regions', return_value=[(0, 10)]),
        ):
            spans, _, _ = await _missed_speech_spans('movie.mp4', [
                SimpleNamespace(start_time=0, end_time=3, text='First'),
                SimpleNamespace(start_time=7, end_time=10, text='Last'),
            ], 999)
        self.assertEqual(spans, [(3, 7)])

    async def test_no_vocals_does_not_mark_blank_timeline_as_speech(self):
        with patch('backend.api.routes.caption_repair.os.path.isfile', return_value=False):
            spans, _, count = await _missed_speech_spans('movie.mp4', [], 999)
        self.assertEqual(spans, [])
        self.assertEqual(count, 0)

    async def test_silent_stretch_between_dialogue_is_not_bridged(self):
        with (
            patch('backend.api.routes.caption_repair.os.path.isfile', return_value=True),
            patch('backend.services.speech_align.detect_speech_regions', return_value=[(1, 3), (15, 17)]),
        ):
            spans, _, count = await _missed_speech_spans('movie.mp4', [], 999)
        self.assertEqual(count, 2)
        self.assertEqual(spans, [(0.6, 3.4), (14.6, 17.4)])

    async def test_blank_caption_does_not_cover_speech_and_noise_filter_is_enabled(self):
        with (
            patch('backend.api.routes.caption_repair.os.path.isfile', return_value=True),
            patch('backend.services.speech_align.detect_speech_regions', return_value=[(1, 3)]) as detect,
        ):
            spans, _, count = await _missed_speech_spans('movie.mp4', [
                SimpleNamespace(start_time=0, end_time=5, text=' '),
            ], 999)
        self.assertEqual(count, 1)
        self.assertEqual(spans, [(0.6, 3.4)])
        self.assertEqual(detect.call_args.args[1], 20.0)
