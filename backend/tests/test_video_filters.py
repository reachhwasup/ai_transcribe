import shutil
import subprocess
import unittest

from backend.services.video_filters import clean_steps, css_result, filter_chain


class StepsTest(unittest.TestCase):
    def test_unknown_names_bad_numbers_and_no_ops_are_dropped(self):
        raw = [["saturate", 1.4], ["blur", 3], ["contrast", "x"], ["brightness", 1.0], ["sepia", 9], ["hue-rotate", -15]]
        self.assertEqual(clean_steps(raw), [("saturate", 1.4), ("sepia", 1.0), ("hue-rotate", -15.0)])

    def test_nothing_to_do_is_no_filter_at_all(self):
        self.assertEqual(filter_chain([]), "")
        self.assertEqual(filter_chain([["brightness", 1], ["sepia", 0]]), "")
        self.assertEqual(filter_chain(None), "")


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
class MatchesThePreviewTest(unittest.TestCase):
    """The exported picture has to be the picture the editor showed."""

    def rendered(self, steps, rgb):
        colour = "0x%02x%02x%02x" % rgb
        out = subprocess.run(
            ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"color=c={colour}:s=16x16:d=0.1,format=rgb24",
             "-vf", filter_chain(steps) + ",format=rgb24", "-frames:v", "1", "-f", "rawvideo", "-"],
            capture_output=True, check=True,
        ).stdout
        return tuple(out[:3])

    def test_every_preset_style_step_matches_css_arithmetic(self):
        looks = {
            "vivid": [["saturate", 1.4], ["contrast", 1.15], ["brightness", 1.05]],
            "noir": [["grayscale", 1], ["contrast", 1.3], ["brightness", 0.9]],
            "sunset": [["sepia", 0.35], ["saturate", 1.4], ["hue-rotate", -15], ["contrast", 1.1]],
            "teal": [["contrast", 1.2], ["saturate", 1.1], ["hue-rotate", -10], ["brightness", 0.95]],
        }
        for name, steps in looks.items():
            for rgb in ((200, 120, 60), (40, 90, 160), (128, 128, 128), (250, 240, 20)):
                got, want = self.rendered(steps, rgb), css_result(steps, rgb)
                for a, b in zip(got, want):
                    self.assertLessEqual(abs(a - b), 3, (name, rgb, got, want))


if __name__ == "__main__":
    unittest.main()
