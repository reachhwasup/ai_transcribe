import os
import shutil
import tempfile
import unittest
from types import SimpleNamespace

from backend.api.routes.voice_generation import _dry_voice_path
from backend.api.routes.caption_repair import _borrowed_voice


class DryVoicePathTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.dry = os.path.join(self.dir, "abc_fitted.mp3")
        open(self.dry, "wb").write(b"x")

    def test_normal_clip_is_its_own_clean_copy(self):
        self.assertEqual(_dry_voice_path(self.dry, "normal"), self.dry)

    def test_styled_copy_leads_back_to_the_clean_voice(self):
        styled = os.path.join(self.dir, "abc_fitted.fx-phone.mp3")
        self.assertEqual(_dry_voice_path(styled, "phone"), self.dry)

    def test_voice_generated_with_its_effect_baked_in_has_no_clean_copy(self):
        baked = os.path.join(self.dir, "def_fx.mp3")
        open(baked, "wb").write(b"x")
        self.assertEqual(_dry_voice_path(baked, "dream"), "")


class BorrowedVoiceTest(unittest.TestCase):
    cast = [
        SimpleNamespace(start_time=10, end_time=12, speaker="A", voice_profile="female", voice_name="km-KH-SreymomNeural"),
        SimpleNamespace(start_time=20, end_time=22, speaker="B", voice_profile="male", voice_name="km-KH-PisethNeural"),
    ]

    def test_takes_the_nearest_caption(self):
        self.assertEqual(_borrowed_voice(13, 14, {"speaker": "Speaker 1"}, self.cast)[0], "A")

    def test_respects_the_heard_gender(self):
        self.assertEqual(_borrowed_voice(13, 14, {"voice_profile": "male"}, self.cast)[0], "B")

    def test_keeps_its_own_label_when_nobody_is_near(self):
        self.assertEqual(_borrowed_voice(60, 61, {"speaker": "Speaker 2"}, self.cast), ("Speaker 2", "female", ""))


if __name__ == "__main__":
    unittest.main()


class GapBatchingTest(unittest.TestCase):
    def test_many_short_gaps_share_a_few_requests(self):
        from backend.api.routes import caption_repair as cr

        gaps = [(10.0 * i + 2, 10.0 * i + 3) for i in range(30)]
        batches = cr._plan_gap_batches(gaps, 400.0)
        self.assertLessEqual(len(batches), 3)
        self.assertEqual(sorted(i for b in batches for p in b for i in p["gaps"]), list(range(30)))

    def test_overlapping_context_is_sent_once(self):
        from backend.api.routes import caption_repair as cr

        batches = cr._plan_gap_batches([(10.0, 11.0), (12.0, 13.0)], 100.0)
        self.assertEqual(len(batches[0]), 1)
        self.assertEqual(batches[0][0]["gaps"], [0, 1])

    def test_lines_return_to_their_gap_in_source_time(self):
        from backend.api.routes import caption_repair as cr

        gaps = [(20.0, 21.0), (50.0, 51.0)]
        batch = cr._plan_gap_batches(gaps, 100.0)[0]
        second = batch[1]
        t = second["offset"] + (50.3 - second["start"])
        out = cr._split_batch_lines(batch, [{"start_time": t, "end_time": t + 0.4}], gaps)
        self.assertEqual(out[0], [])
        self.assertAlmostEqual(out[1][0]["start_time"], 50.3, places=2)


class BgmCleanTest(unittest.TestCase):
    def test_levels_are_reversible_and_keep_length(self):
        import numpy as np
        import soundfile as sf
        from backend.services import video_service as vs

        folder = tempfile.mkdtemp()
        sr = 44100
        t = np.arange(sr * 3) / sr
        music = (0.2 * np.sin(2 * np.pi * 110 * t))[:, None].repeat(2, 1).astype(np.float32)
        voice = (0.3 * np.sin(2 * np.pi * 1000 * t) * (t > 1))[:, None].repeat(2, 1).astype(np.float32)
        leak = music + 0.3 * voice
        sf.write(os.path.join(folder, "bgm.flac"), leak, sr, subtype="PCM_16")
        sf.write(os.path.join(folder, "vocals.flac"), voice, sr, subtype="PCM_16")
        original = open(os.path.join(folder, "bgm.flac"), "rb").read()
        # a tone is not speech to the voice detector, so say where the "dialogue" is, as the
        # captions do in the app
        vs.clean_bgm(folder, "strong", keep_effects=False, dialogue=[[1.0, 3.0]])
        cleaned, _ = sf.read(os.path.join(folder, "bgm.flac"), always_2d=True)
        self.assertEqual(len(cleaned), len(leak))
        spectrum = np.abs(np.fft.rfft(cleaned[sr * 2 : sr * 3, 0]))
        freqs = np.fft.rfftfreq(sr, 1 / sr)
        # the leaked 1 kHz voice drops well below the 110 Hz music
        self.assertLess(spectrum[np.argmin(abs(freqs - 1000))], 0.2 * spectrum[np.argmin(abs(freqs - 110))])
        self.assertEqual(vs.bgm_clean_level(folder), "strong")

        vs.clean_bgm(folder, "off", keep_effects=False)
        self.assertEqual(open(os.path.join(folder, "bgm.flac"), "rb").read(), original)

    def test_sound_effects_in_the_vocal_stem_come_back(self):
        """Non-speech sound Demucs put under vocals is added back to the BGM; speech is not."""
        import json
        import numpy as np
        import soundfile as sf
        from backend.services import video_service as vs

        folder = tempfile.mkdtemp()
        sr = 44100
        t = np.arange(sr * 4) / sr
        music = (0.05 * np.sin(2 * np.pi * 110 * t))[:, None].repeat(2, 1).astype(np.float32)
        voice = np.zeros_like(music)
        voice[: sr * 2] = 0.3 * np.sin(2 * np.pi * 300 * t[: sr * 2])[:, None]   # "speech" 0-2 s
        voice[sr * 3: sr * 3 + sr // 2] = 0.3                                      # a thump at 3 s
        sf.write(os.path.join(folder, "bgm.flac"), music, sr, subtype="PCM_16")
        sf.write(os.path.join(folder, "vocals.flac"), voice, sr, subtype="PCM_16")
        # the "speech" is a tone, so it is marked the way captions mark dialogue
        vs.clean_bgm(folder, "off", keep_effects=True, dialogue=[[0.0, 2.0]])
        out, _ = sf.read(os.path.join(folder, "bgm.flac"), always_2d=True)
        rms = lambda a, b: float(np.sqrt(np.mean(out[int(a * sr): int(b * sr), 0] ** 2)))
        self.assertGreater(rms(3.1, 3.4), 0.2)      # the thump is back
        self.assertLess(rms(0.5, 1.5), 0.06)        # the speech is not
        self.assertTrue(vs.bgm_keeps_effects(folder))


class TextOverlayExportTest(unittest.TestCase):
    """Guards for the overlay export: every motion must build a filter ffmpeg accepts, a pop's
    overshoot must fit its canvas, and Latin beside Khmer must not vanish."""

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
    def test_every_motion_renders(self):
        import subprocess
        from backend.services import video_service as vs

        folder = tempfile.mkdtemp()
        motions = ["fade", "slide_left", "slide_right", "slide_up", "slide_down", "zoom", "pop",
                   "marquee_left", "marquee_right", "drift", "bounce", "corners"]
        for motion in motions:
            for exit_ in ("none", "zoom", "slide_left"):
                item = vs.render_text_overlays([{
                    "text": "Title", "start_time": 0.2, "end_time": 1.4, "size_pct": 12, "box_opacity": 1,
                    "animation": motion, "animation_seconds": 0.4, "exit_animation": exit_, "exit_seconds": 0.3,
                }], 320, 180, folder)[0]
                chain = "format=rgba"
                factor = vs._overlay_scale_expr(item)
                if factor:
                    cw, ch = vs._overlay_canvas(item)
                    chain += (f",scale=w='max(2\\,trunc(iw*{factor}/2)*2)':h=-2:eval=frame"
                              f",pad=w={cw}:h={ch}:x='(ow-iw)/2':y='(oh-ih)/2':color=black@0:eval=frame")
                x, y = vs._overlay_position_exprs(item)
                r = subprocess.run(
                    ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x180:d=1.6:r=25",
                     "-loop", "1", "-t", "1.6", "-i", item["path"], "-filter_complex",
                     f"[1:v]{chain}[o];[0:v][o]overlay=x='{x}':y='{y}':enable='between(t,0.2,1.4)'",
                     "-f", "null", "-"], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, (motion, exit_, r.stderr[-300:]))

    def test_latin_beside_khmer_is_drawn(self):
        from PIL import Image
        from backend.services import video_service as vs

        folder = tempfile.mkdtemp()
        khmer, mixed = vs.render_text_overlays([
            {"text": "ចំណងជើង", "start_time": 0, "end_time": 1, "size_pct": 10},
            {"text": "ចំណងជើង Pop!", "start_time": 0, "end_time": 1, "size_pct": 10},
        ], 960, 540, folder)
        # the English word adds real width instead of disappearing
        self.assertGreater(Image.open(mixed["path"]).size[0], Image.open(khmer["path"]).size[0] * 1.3)


class CaptionRenderTest(unittest.TestCase):
    """The export's caption drawing honours the Style tab."""

    def test_font_choice_changes_the_drawing(self):
        import numpy as np
        from backend.services.caption_render import render_caption

        base = {"sizePct": 6, "boxOpacity": 0, "outlineWidth": 0, "position": "middle"}
        a = np.asarray(render_caption("Your story", {**base, "fontFamily": "'Inter', sans-serif"}, 640, 360))
        b = np.asarray(render_caption("Your story", {**base, "fontFamily": "'Bebas Neue', sans-serif"}, 640, 360))
        self.assertFalse((a == b).all())

    def test_uppercase_and_word_highlight(self):
        import numpy as np
        from backend.services.caption_render import render_caption, word_count

        style = {"sizePct": 6, "boxOpacity": 0, "outlineWidth": 0, "position": "middle",
                 "animation": "karaoke", "activeWordColor": "#FF0000", "textColor": "#FFFFFF"}
        self.assertEqual(word_count("one two three"), 3)
        first = np.asarray(render_caption("one two three", style, 640, 360, active_word=0))[:, :, :3].astype(int)
        last = np.asarray(render_caption("one two three", style, 640, 360, active_word=2))[:, :, :3].astype(int)
        red = lambda img: (img[:, :, 0] > 200) & (img[:, :, 1] < 60)
        cols_first, cols_last = np.nonzero(red(first))[1], np.nonzero(red(last))[1]
        # the red word moves from the left of the line to the right
        self.assertLess(cols_first.mean(), cols_last.mean())

    def test_bundled_fonts_are_present(self):
        from backend.services import caption_render as cr

        for family, (regular, _bold) in cr._FAMILIES.items():
            if family == "impact":
                continue
            self.assertTrue(os.path.exists(cr._path(regular)), family)
