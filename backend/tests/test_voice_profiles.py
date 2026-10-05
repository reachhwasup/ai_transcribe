import json
import unittest

from backend.services.voice_profiles import resolve_voice_profile
from backend.services.transcript_cleanup import _parse_segments
from backend.services.tts_service import assign_speaker_voices


class VoiceProfileTests(unittest.TestCase):
    def test_explicit_profiles_take_priority_over_name_and_gender(self):
        self.assertEqual(resolve_voice_profile('male', None, 'Alex'), 'male')
        self.assertEqual(resolve_voice_profile('female', 'male', 'Master'), 'female')
        self.assertEqual(resolve_voice_profile('female', None, 'Young Woman'), 'female')

    def test_female_labels_are_not_male_substrings(self):
        for label in ['Female', 'Woman', 'Young Woman', 'លោកស្រី']:
            self.assertEqual(resolve_voice_profile(speaker=label), 'female')
        self.assertEqual(resolve_voice_profile(speaker='Jackson'), 'female')
        self.assertEqual(resolve_voice_profile(speaker='Male'), 'male')

    def test_parser_and_assignment_keep_both_detected_voices(self):
        rows = _parse_segments(json.dumps([
            {'start_time': 0, 'end_time': 2, 'text': 'Hello there', 'original_text': 'Hello there', 'speaker': 'Alex', 'voice_profile': 'male'},
            {'start_time': 3, 'end_time': 5, 'text': 'Welcome back', 'original_text': 'Welcome back', 'speaker': 'Female', 'voice_profile': 'female'},
        ]))
        self.assertEqual([r['voice_profile'] for r in rows], ['male', 'female'])
        assigned = assign_speaker_voices(rows)
        self.assertEqual([r['voice_name'] for r in assigned], ['km-KH-PisethNeural', 'km-KH-SreymomNeural'])

    def test_gender_fallback_and_age_profiles(self):
        self.assertEqual(resolve_voice_profile(None, 'male', 'Alex'), 'male')
        for profile in ['grandpa', 'grandma', 'child_boy', 'child_girl']:
            self.assertEqual(resolve_voice_profile(profile, None, 'Alex'), profile)
