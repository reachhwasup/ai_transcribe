import unittest
from types import SimpleNamespace

from backend.services.spacing import overlapping, space_overlaps


def line(start, end, text="ល្អ", speaker=""):
    return SimpleNamespace(start_time=start, end_time=end, text=text, speaker=speaker, voice_profile="female")


class SpacingTest(unittest.TestCase):
    def test_a_line_starting_inside_the_one_before_waits_for_it(self):
        # from a real episode: 3.40–4.44 then 3.80–4.83, the second voice 0.64 s over the first
        a, b, c = line(3.40, 4.44), line(3.80, 4.83), line(8.00, 9.00)
        changed = space_overlaps([a, b, c])
        self.assertEqual(changed, [b])
        self.assertEqual((b.start_time, b.end_time), (4.49, 5.52))      # keeps its full length
        self.assertEqual((a.start_time, a.end_time), (3.40, 4.44))      # the earlier line is untouched
        self.assertEqual(overlapping([a, b, c]), 0)

    def test_a_moved_line_does_not_run_into_the_one_after(self):
        a, b, c = line(0.0, 2.0), line(1.5, 3.0), line(3.2, 4.0)
        space_overlaps([a, b, c])
        self.assertEqual((b.start_time, b.end_time), (2.05, 3.15))      # gives up length, not overlap
        self.assertLessEqual(b.end_time, c.start_time)

    def test_with_no_room_to_move_the_earlier_line_ends_sooner(self):
        a, b, c = line(0.0, 2.0), line(1.6, 2.2), line(2.3, 3.0)
        changed = space_overlaps([a, b, c])
        self.assertEqual(changed, [a])
        self.assertEqual(a.end_time, 1.55)
        self.assertEqual((b.start_time, b.end_time), (1.6, 2.2))

    def test_a_run_of_overlapping_lines_is_spaced_one_after_another(self):
        lines = [line(42.20, 44.31), line(43.80, 45.56), line(45.20, 46.74), line(46.20, 47.25), line(60.0, 61.0)]
        space_overlaps(lines)
        self.assertEqual(overlapping(lines), 0)
        for a, b in zip(lines, lines[1:]):
            self.assertGreaterEqual(round(b.start_time - a.end_time, 2), 0.05)

    def test_lines_that_do_not_speak_are_left_alone(self):
        hook = line(0.0, 5.0, speaker="Intro hook")
        a = line(1.0, 2.0)
        blank = line(1.5, 3.0, text="  ")
        self.assertEqual(space_overlaps([hook, a, blank]), [])
        self.assertEqual(overlapping([hook, a, blank]), 0)


if __name__ == "__main__":
    unittest.main()
