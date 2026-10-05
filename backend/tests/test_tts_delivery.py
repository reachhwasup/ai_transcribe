import unittest
from unittest.mock import patch

from backend.services import tts_service as tts


class DeliveryTests(unittest.TestCase):
    def test_selected_emotion_including_neutral_wins_over_tags(self):
        self.assertEqual(tts._clean_and_detect_emotion('[angry] Hello', 'calm'), ('Hello', 'calm'))
        self.assertEqual(tts._clean_and_detect_emotion('[angry] Hello', 'neutral'), ('Hello', 'neutral'))

    def test_auto_tags_and_parenthetical_dialogue(self):
        self.assertEqual(tts._clean_and_detect_emotion('[crying] Please (come home)', 'auto'), ('Please (come home)', 'crying'))
        self.assertEqual(tts._clean_and_detect_emotion('[ខ្សឹប] សួស្តី'), ('សួស្តី', 'whisper'))
        self.assertEqual(tts._clean_and_detect_emotion('[music]'), ('', 'neutral'))

    def test_crying_changes_delivery_and_voxcpm_prompt(self):
        self.assertNotEqual(tts._emotion_prosody('crying'), tts._emotion_prosody('neutral'))
        self.assertIn('tearful', tts._build_voxcpm_prompt('Hello', 'female', 'crying'))

    def test_pronunciations_do_not_cascade_and_longest_match_wins(self):
        with patch.object(tts, '_pronunciations', [('Tang Bohu', 'Tang'), ('Tang', 'ថាង')]):
            self.assertEqual(tts.apply_pronunciations('Tang Bohu and Tang'), 'Tang and ថាង')

    def test_latin_names_next_to_khmer_and_literal_replacement(self):
        with patch.object(tts, '_pronunciations', [('Ann', r'អែន\1')]):
            self.assertEqual(tts.apply_pronunciations('សួស្តីAnn! Anna'), 'សួស្តីអែន\\1! Anna')
