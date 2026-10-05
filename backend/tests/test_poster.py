import base64
import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from PIL import Image

from backend.services import poster


def picture(width, height, mode="RGB", fmt="PNG"):
    out = io.BytesIO()
    Image.new(mode, (width, height), (200, 120, 40) if mode == "RGB" else (200, 120, 40, 128)).save(out, fmt)
    return out.getvalue()


def answer(width, height):
    return {"candidates": [{"content": {"parts": [
        {"text": "Here is the poster."},
        {"inlineData": {"mimeType": "image/png", "data": base64.b64encode(picture(width, height)).decode()}},
    ]}}]}


class PrepareTest(unittest.TestCase):
    def test_the_shape_asked_for_is_the_posters_own(self):
        self.assertEqual(poster.nearest_ratio(640, 914), "2:3")
        self.assertEqual(poster.nearest_ratio(1080, 1920), "9:16")
        self.assertEqual(poster.nearest_ratio(1280, 720), "16:9")

    def test_a_large_or_transparent_upload_becomes_a_plain_jpeg(self):
        raw, width, height = poster.prepare(picture(3000, 4500, "RGBA"))
        self.assertEqual((width, height), (1365, 2048))
        image = Image.open(io.BytesIO(raw))
        self.assertEqual((image.format, image.mode), ("JPEG", "RGB"))

    def test_what_is_not_a_usable_image_is_said_plainly(self):
        with self.assertRaisesRegex(poster.PosterError, "not an image"):
            poster.prepare(b"WEBVTT\n\n00:01.000 --> 00:02.000\nhello")
        with self.assertRaisesRegex(poster.PosterError, "too small"):
            poster.prepare(picture(120, 90))

    def test_the_answer_comes_back_at_the_posters_size(self):
        fitted = Image.open(io.BytesIO(poster.fit_back(picture(832, 1248), 640, 914)))
        self.assertEqual(fitted.size, (640, 914))


class RemoveTitleTest(unittest.IsolatedAsyncioTestCase):
    async def run_remove(self, replies, keys=("k1",)):
        with patch.object(poster, "_keys", AsyncMock(return_value=list(keys))), \
             patch.object(poster, "_ask_image", AsyncMock(side_effect=replies)) as ask:
            prepared, width, height = poster.prepare(picture(640, 914))
            try:
                return (await poster.remove_title(prepared, width, height, "gemini"))[0], ask
            except poster.PosterError as exc:
                return exc, ask

    async def test_the_poster_is_sent_with_the_instruction_and_its_shape(self):
        result, ask = await self.run_remove([answer(832, 1248)])
        self.assertEqual(Image.open(io.BytesIO(result)).size, (640, 914))
        key, model, body = ask.await_args.args
        self.assertEqual(model, poster.settings.gemini_image_model)
        self.assertIn("Add no new text", body["contents"][0]["parts"][0]["text"])
        self.assertEqual(body["generationConfig"]["imageConfig"]["aspectRatio"], "2:3")

    async def test_a_refused_shape_setting_is_sent_again_without_it(self):
        result, ask = await self.run_remove([RuntimeError("400 Unknown name imageConfig"), answer(1024, 1024)])
        self.assertIsInstance(result, bytes)
        self.assertNotIn("imageConfig", ask.await_args.args[2]["generationConfig"])

    async def test_a_missing_model_moves_on_to_the_next_one(self):
        result, ask = await self.run_remove([RuntimeError("404 model not found"), answer(832, 1248)], keys=("k1", "k2"))
        self.assertIsInstance(result, bytes)
        self.assertEqual(ask.await_count, 2)                  # the second key is not wasted on a missing model
        self.assertNotEqual(ask.await_args_list[0].args[1], ask.await_args_list[1].args[1])

    async def test_a_used_up_limit_explains_what_is_needed(self):
        result, _ = await self.run_remove([RuntimeError("429 quota exceeded")] * 10)
        self.assertIsInstance(result, poster.PosterError)
        self.assertIn("billing", str(result))

    async def test_a_refusal_is_reported_and_not_retried(self):
        result, ask = await self.run_remove([{"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}}])
        self.assertIn("would not edit", str(result))
        self.assertEqual(ask.await_count, 1)

    async def test_an_answer_without_a_picture_is_a_failure(self):
        empty = {"candidates": [{"finishReason": "NO_IMAGE", "content": {"parts": [{"text": "I can't."}]}}]}
        result, _ = await self.run_remove([empty] * 10)
        self.assertIsInstance(result, poster.PosterError)
        self.assertIn("NO_IMAGE", str(result))


class EngineTest(unittest.IsolatedAsyncioTestCase):
    """Which engine erases the title: Codex on the ChatGPT sign-in, or Gemini."""

    async def run_auto(self, signed_in, codex_reply, engine="auto"):
        from backend.services import codex_client
        with patch.object(codex_client, "status", AsyncMock(return_value={"installed": signed_in, "signed_in": signed_in})), \
             patch.object(codex_client, "edit_image", AsyncMock(side_effect=[codex_reply])) as codex, \
             patch.object(poster, "_edit_gemini", AsyncMock(return_value=b"gemini")) as gemini:
            prepared, width, height = poster.prepare(picture(640, 914))
            return await poster.remove_title(prepared, width, height, engine), codex, gemini

    async def test_codex_is_used_when_it_is_signed_in(self):
        (image, engine), codex, gemini = await self.run_auto(True, picture(1050, 1500))
        self.assertEqual(engine, "codex")
        self.assertEqual(Image.open(io.BytesIO(image)).size, (640, 914))     # back at the poster's size
        self.assertIn("Add no new text", codex.await_args.args[1])
        gemini.assert_not_awaited()

    async def test_gemini_is_used_when_codex_is_not_there_or_fails(self):
        from backend.services.codex_client import CodexError
        (_, engine), codex, _ = await self.run_auto(False, picture(10, 10))
        self.assertEqual(engine, "gemini")
        codex.assert_not_awaited()
        (_, engine), _, _ = await self.run_auto(True, CodexError("limit used up"))
        self.assertEqual(engine, "gemini")

    async def test_a_named_engine_is_not_swapped_for_the_other(self):
        from backend.services.codex_client import CodexError
        with self.assertRaisesRegex(poster.PosterError, "limit used up"):
            await self.run_auto(True, CodexError("limit used up"), engine="codex")


class PaintTitleTest(unittest.IsolatedAsyncioTestCase):
    """Repainting the poster with the new title lettered in by the model."""

    async def paint(self, title, subtitle=""):
        from backend.services import codex_client
        with patch.object(codex_client, "status", AsyncMock(return_value={"installed": True, "signed_in": True})), \
             patch.object(codex_client, "edit_image", AsyncMock(return_value=picture(1050, 1500))) as codex:
            prepared, width, height = poster.prepare(picture(640, 914))
            return await poster.paint_title(prepared, width, height, title, subtitle), codex

    async def test_the_title_is_given_exactly_and_on_its_own_lines(self):
        (image, engine), codex = await self.paint("ទាយមួយដង\n បង្ហាញឫទ្ធិ ២", "ខ្ញុំក្លាយជាសេដ្ឋី")
        prompt = codex.await_args.args[1]
        self.assertIn("Line 1 (large): ទាយមួយដង បង្ហាញឫទ្ធិ ២\n", prompt)      # a pasted line break cannot split it
        self.assertIn("Line 2 (smaller, below it): ខ្ញុំក្លាយជាសេដ្ឋី", prompt)
        self.assertIn("Copy every character exactly", prompt)
        self.assertEqual((engine, Image.open(io.BytesIO(image)).size), ("codex", (640, 914)))

    async def test_one_line_asks_for_one_line(self):
        _, codex = await self.paint("ស្ដេចទាយ")
        self.assertIn("one line", codex.await_args.args[1])
        self.assertNotIn("Line 2", codex.await_args.args[1])

    async def test_nothing_or_too_much_to_letter_is_refused_before_any_call(self):
        for title, reason in (("  ", "Type the title"), ("ក" * 81, "too long")):
            with self.assertRaisesRegex(poster.PosterError, reason):
                await self.paint(title)


READING = {"original": "一卦显圣2：\n得到道家传承后我终于发达了", "romanised": "YI GUA XIAN SHENG",
           "meaning": "One divination shows divine power 2.", "title": "ទាយមួយដង បង្ហាញឫទ្ធិ ២", "subtitle": "ខ្ញុំក្លាយជាអ្នកមាន"}


class ReadTitleTest(unittest.IsolatedAsyncioTestCase):
    """Reading the poster's own title and putting it into the project's language."""

    async def read(self, gemini, codex=None, signed_in=True):
        from backend.services import codex_client
        with patch("backend.services.gemini_client._configure_genai", AsyncMock()), \
             patch("backend.services.gemini_client._generate_with_fallback", AsyncMock(side_effect=[gemini])) as ask, \
             patch.object(codex_client, "status", AsyncMock(return_value={"installed": signed_in, "signed_in": signed_in})), \
             patch.object(codex_client, "ask_about_image", AsyncMock(side_effect=[codex])) as asked:
            prepared, _, _ = poster.prepare(picture(640, 914))
            return await poster.read_title(prepared, "km"), ask, asked

    async def test_the_title_is_read_and_translated_for_the_projects_language(self):
        reading, ask, asked = await self.read(SimpleNamespace(text=json.dumps(READING, ensure_ascii=False)))
        self.assertEqual(reading["title"], "ទាយមួយដង បង្ហាញឫទ្ធិ ២")
        self.assertEqual(reading["original"], "一卦显圣2： 得到道家传承后我终于发达了")     # on one line, ready to show
        self.assertEqual(reading["engine"], "gemini")
        prompt, image = ask.await_args.args[0]
        self.assertIn("Khmer", prompt)
        self.assertIn("not writing that belongs to the scene", prompt)
        self.assertEqual(image["mime_type"], "image/jpeg")
        asked.assert_not_awaited()

    async def test_codex_reads_it_when_gemini_cannot_be_reached(self):
        reading, _, _ = await self.read(RuntimeError("503"), "Here it is:\n```json\n" + json.dumps(READING, ensure_ascii=False) + "\n```")
        self.assertEqual((reading["engine"], reading["subtitle"]), ("codex", "ខ្ញុំក្លាយជាអ្នកមាន"))

    async def test_a_poster_with_no_title_says_so(self):
        with self.assertRaisesRegex(poster.PosterError, "No title could be read"):
            await self.read(SimpleNamespace(text='{"original": "", "title": ""}'), '{"original": ""}')
        with self.assertRaisesRegex(poster.PosterError, "could not be read just now"):
            await self.read(RuntimeError("503"), None, signed_in=False)


class CodexClientTest(unittest.IsolatedAsyncioTestCase):
    async def test_the_picture_codex_saves_is_returned_and_the_folder_removed(self):
        import os
        from backend.services import codex_client
        seen = {}

        async def fake_run(args, cwd=None, timeout=0):
            seen["args"], seen["cwd"] = args, cwd
            with open(os.path.join(cwd, "result.png"), "wb") as out:
                out.write(b"edited")
            return 0, "DONE"

        with patch.object(codex_client, "find_codex", return_value="/bin/codex"), patch.object(codex_client, "_run", fake_run):
            self.assertEqual(await codex_client.edit_image(b"jpeg", "Remove the title."), b"edited")
        self.assertIn("workspace-write", seen["args"])              # it may write only inside its own folder
        self.assertIn("Remove the title.", seen["args"][-1])
        self.assertFalse(os.path.exists(seen["cwd"]))

    async def test_no_picture_is_reported_with_the_reason(self):
        from backend.services import codex_client
        with patch.object(codex_client, "find_codex", return_value="/bin/codex"), \
             patch.object(codex_client, "_newest_generated", return_value=None), \
             patch.object(codex_client, "_run", AsyncMock(return_value=(1, "You've hit your usage limit."))):
            with self.assertRaisesRegex(codex_client.CodexError, "limit is used up"):
                await codex_client.edit_image(b"jpeg", "Remove the title.")
        with patch.object(codex_client, "find_codex", return_value=None):
            with self.assertRaisesRegex(codex_client.CodexError, "not installed"):
                await codex_client.edit_image(b"jpeg", "Remove the title.")


if __name__ == "__main__":
    unittest.main()
