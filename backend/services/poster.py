"""Movie posters: take the original title off so a new one can be put in its place.

Only the erasing is done by the image model. The new title is drawn by the app with real
fonts, because image models still misspell Khmer — they draw letters that look right and
are not words."""
import base64
import io
import logging

from PIL import Image, ImageOps

from backend.config import settings

logger = logging.getLogger(__name__)

_REST_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# Tried in order after the one named in settings; a model this key cannot use is skipped
IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"]
# Sent no larger than this on its longest side: enough for a poster, small enough to send inline
MAX_SIDE = 2048
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]

ERASE_PROMPT = """Edit this movie poster. Remove the lettering that was laid over the artwork:
the title, subtitle, tagline, the romanised title, credits, release date, logos and watermarks.
Where it was, paint what would be behind it — continue the clothing, background, light and
effects so the area does not look patched or blurred.
Change nothing else: the same people, faces, pose, colours, framing and proportions.
Writing that belongs to the scene itself (banners, signs, coins, talismans) stays as it is.
Add no new text of any kind. Return only the edited image."""


TITLE_MAX = 80


def clean_line(text: str) -> str:
    """One line of a title as it will be given to the model: on one line, no stray spacing."""
    return " ".join(str(text or "").split())


def title_prompt(title: str, subtitle: str = "") -> str:
    """The instruction for repainting the poster with a new title where the old one was."""
    second = (f"\nLine 2 (smaller, below it): {subtitle}" if subtitle else "")
    lines = "two lines" if subtitle else "one line"
    return f"""Replace the title on this movie poster with a new title.
The new title has {lines}. Copy every character exactly as given, in the same order — do not
translate, respell, shorten or add to it:
Line 1 (large): {title}{second}
Put it where the original title is, at about the same size, in the same look as the original
lettering (its stroke style, colour and edge). Draw the script's letter shapes correctly —
for Khmer that means every subscript consonant and vowel sign in its place — so it reads cleanly.
Remove the original title and every other piece of lettering laid over the artwork (romanised
title, tagline, credits, logos, watermarks), painting in what would be behind it.
Change nothing else: the same people, faces, pose, colours, framing and proportions.
Writing that belongs to the scene itself (banners, signs, coins, talismans) stays as it is."""


def read_prompt(language_name: str) -> str:
    """The instruction for reading a poster's own title and putting it into another language."""
    return f"""Look at this movie poster and read its title — the lettering laid over the artwork,
not writing that belongs to the scene (banners, signs, coins, talismans).
Return ONE JSON object:
{{
  "original": "the title exactly as written, every line, in its own script",
  "romanised": "the romanised title if the poster prints one, else \"\"",
  "meaning": "what the title means, in plain English, in one sentence",
  "title": "the main title in {language_name}",
  "subtitle": "the second line in {language_name}, or \"\" if the title has one line"
}}
For "title" and "subtitle": translate the meaning the way a film distributor would title it for
{language_name} viewers — short, natural and striking, not word for word. Keep a part number
(2, II) in the main title. "title" is at most 30 characters and "subtitle" at most 45.
If the poster has no readable title, return "original": "".
Return ONLY the JSON object."""


def clean_reading(data: dict) -> dict:
    """The model's reading as the five fields the editor shows; ValueError if it read nothing."""
    if not isinstance(data, dict):
        raise ValueError("not an object")
    reading = {key: clean_line(data.get(key)) for key in ("original", "romanised", "meaning", "title", "subtitle")}
    if not reading["original"] or not reading["title"]:
        raise ValueError("no title read")
    if reading["subtitle"] == reading["title"]:
        reading["subtitle"] = ""
    return reading


async def read_title(prepared: bytes, language: str) -> dict:
    """What the poster's own title says, and that title in the project's language.

    Gemini reads it first — it is a small text answer that the free tier covers — and Codex
    is asked when Gemini cannot be reached."""
    import re

    import google.generativeai as genai
    from backend.services import codex_client
    from backend.services.gemini_client import _configure_genai, _generate_with_fallback
    from backend.services.publish_kit import LANGUAGE_NAMES
    from backend.services.transcript_cleanup import _safe_json_loads

    prompt = read_prompt(LANGUAGE_NAMES.get(language, language))

    def parse(text: str) -> dict:
        raw = re.sub(r"^```(?:json)?\n?|\n?```$", "", (text or "").strip())
        found = re.search(r"\{.*\}", raw, re.S)
        return clean_reading(_safe_json_loads(found.group(0) if found else raw))

    unreadable = False
    try:
        await _configure_genai()
        response = await _generate_with_fallback(
            [prompt, {"mime_type": "image/jpeg", "data": prepared}],
            generation_config=genai.types.GenerationConfig(temperature=0.4, response_mime_type="application/json"),
        )
        return {**parse(response.text), "engine": "gemini"}
    except ValueError:
        unreadable = True
    except Exception as exc:
        logger.warning("poster title could not be read with gemini: %s", str(exc)[:200])
    try:
        if (await codex_client.status())["signed_in"]:
            return {**parse(await codex_client.ask_about_image(prepared, prompt)), "engine": "codex"}
    except ValueError:
        unreadable = True
    except codex_client.CodexError as exc:
        logger.warning("poster title could not be read with codex: %s", exc)
    if unreadable:
        raise PosterError("No title could be read on this poster. Type your title in the Big line instead.")
    raise PosterError("The poster could not be read just now. Check the Gemini key in Settings, or try again.")


class PosterError(RuntimeError):
    """Something the person can be told about and act on."""


def nearest_ratio(width: int, height: int) -> str:
    """The supported shape closest to the poster's own, so the model does not reframe it."""
    target = width / height
    return min(RATIOS, key=lambda r: abs(int(r.split(":")[0]) / int(r.split(":")[1]) - target))


def prepare(raw: bytes) -> tuple[bytes, int, int]:
    """The upload as a plain JPEG, turned the right way up, with its size."""
    if len(raw) > MAX_UPLOAD_BYTES:
        raise PosterError("That image is too large — use one under 25 MB.")
    try:
        image = Image.open(io.BytesIO(raw))
        image = ImageOps.exif_transpose(image)
        image.load()
    except Exception as exc:
        raise PosterError("That file is not an image this can read. Use a JPG, PNG or WebP.") from exc
    if min(image.size) < 200:
        raise PosterError("That image is too small to work with.")
    if image.mode != "RGB":
        # transparency is laid on black, the way a poster with a cut-out is normally shown
        background = Image.new("RGB", image.size, (0, 0, 0))
        rgba = image.convert("RGBA")
        background.paste(rgba, mask=rgba.split()[3])
        image = background
    if max(image.size) > MAX_SIDE:
        image.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    out = io.BytesIO()
    image.save(out, "JPEG", quality=93)
    return out.getvalue(), image.width, image.height


def fit_back(edited: bytes, width: int, height: int) -> bytes:
    """The model's answer at the poster's own size. The model picks its own dimensions, so the
    answer is scaled to cover the original and trimmed evenly; the new title then lands in the
    same place it would on the original."""
    try:
        image = Image.open(io.BytesIO(edited)).convert("RGB")
    except Exception as exc:
        raise PosterError("The edited image could not be read.") from exc
    image = ImageOps.fit(image, (width, height), Image.LANCZOS, centering=(0.5, 0.5))
    out = io.BytesIO()
    image.save(out, "JPEG", quality=93)
    return out.getvalue()


async def _ask_image(key: str, model: str, body: dict) -> dict:
    import httpx

    async with httpx.AsyncClient(timeout=httpx.Timeout(240.0, connect=30.0)) as client:
        r = await client.post(_REST_URL.format(model=model), headers={"x-goog-api-key": key}, json=body)
    if r.status_code != 200:
        raise RuntimeError(f"{r.status_code} {r.text[:400]}")
    return r.json()


def _image_from(payload: dict) -> bytes:
    block = (payload.get("promptFeedback") or {}).get("blockReason")
    if block:
        raise PosterError(f"Gemini would not edit this image ({block}).")
    for candidate in payload.get("candidates") or []:
        for part in (candidate.get("content") or {}).get("parts") or []:
            data = (part.get("inlineData") or part.get("inline_data") or {}).get("data")
            if data:
                return base64.b64decode(data)
    reason = ((payload.get("candidates") or [{}])[0]).get("finishReason") or "no image"
    raise RuntimeError(f"no image in the answer ({reason})")


async def _keys() -> list[str]:
    from backend.services.gemini_client import _get_active_keys

    keys = await _get_active_keys()
    if not keys and settings.gemini_api_key and settings.gemini_api_key != "your_gemini_api_key_here":
        keys = [settings.gemini_api_key]
    if not keys:
        raise PosterError("Add a Gemini API key in Settings first.")
    return keys


ENGINES = ("codex", "gemini")


async def remove_title(prepared: bytes, width: int, height: int, engine: str = "auto") -> tuple[bytes, str]:
    """The poster with its lettering painted out, at the same size, and the engine that did it."""
    return await _edit(prepared, width, height, ERASE_PROMPT, engine)


async def paint_title(prepared: bytes, width: int, height: int, title: str, subtitle: str = "",
                      engine: str = "auto") -> tuple[bytes, str]:
    """The poster repainted with a new title in place of the old one, in the old one's style.

    The model draws the letters, so the spelling is not guaranteed — in a measured run on a
    Khmer title two letters of one word came out wrong. The result is for a person to check."""
    title, subtitle = clean_line(title), clean_line(subtitle)
    if not title:
        raise PosterError("Type the title to put on the poster first.")
    if len(title) > TITLE_MAX or len(subtitle) > TITLE_MAX:
        raise PosterError(f"That is too long to letter on a poster — keep each line under {TITLE_MAX} characters.")
    return await _edit(prepared, width, height, title_prompt(title, subtitle), engine)


async def _edit(prepared: bytes, width: int, height: int, prompt: str, engine: str) -> tuple[bytes, str]:
    """Have an image model change the poster as the prompt says; returns it and the engine used.

    "auto" uses Codex when it is installed and signed in — it runs on the ChatGPT sign-in and
    costs no Gemini quota — and falls back to Gemini. A named engine is used on its own."""
    from backend.services import codex_client

    if engine not in ENGINES:
        ready = await codex_client.status()
        order = ["codex", "gemini"] if ready["signed_in"] else ["gemini"]
    else:
        order = [engine]
    problem: Exception | None = None
    for name in order:
        try:
            if name == "codex":
                edited = await codex_client.edit_image(prepared, prompt)
                return fit_back(edited, width, height), "codex"
            return await _edit_gemini(prepared, width, height, prompt), "gemini"
        except (PosterError, codex_client.CodexError) as exc:
            logger.warning("poster edit with %s failed: %s", name, exc)
            problem = problem or exc           # the first engine's reason is the one worth showing
    raise PosterError(str(problem))


async def _edit_gemini(prepared: bytes, width: int, height: int, prompt: str) -> bytes:
    keys = await _keys()
    models = list(dict.fromkeys([settings.gemini_image_model, *IMAGE_MODELS]))
    parts = [
        {"text": prompt},
        {"inlineData": {"mimeType": "image/jpeg", "data": base64.b64encode(prepared).decode()}},
    ]
    shaped = {"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": nearest_ratio(width, height)}}
    plain = {"responseModalities": ["TEXT", "IMAGE"]}
    last = ""
    for model in models:
        for key in keys:
            # some image models refuse the shape setting; the plain request is the fallback
            for config in (shaped, plain):
                try:
                    payload = await _ask_image(key, model, {"contents": [{"parts": parts}], "generationConfig": config})
                    return fit_back(_image_from(payload), width, height)
                except PosterError:
                    raise
                except Exception as exc:
                    last = str(exc)
                    logger.warning("poster edit failed on %s: %s", model, last[:200])
                    if not last.startswith("400"):
                        break               # only a rejected request is worth re-sending differently
            if last.startswith("404"):
                break                       # this model does not exist for any key
    if last.startswith("429") or "quota" in last.lower():
        raise PosterError(
            "Gemini refused the image edit: the request limit is used up. Image editing is not "
            "included in the free tier of most keys — it needs a key with billing turned on.")
    if last.startswith(("401", "403")):
        raise PosterError("Gemini rejected the API key for image editing.")
    raise PosterError(f"The poster could not be edited just now. ({last[:160]})")
