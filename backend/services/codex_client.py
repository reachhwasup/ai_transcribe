"""Codex (the ChatGPT coding agent) as a second engine, run through its own command-line tool.

It works with the ChatGPT sign-in already on this machine, so it needs no API key and does
not touch the Gemini quota. Each call is one `codex exec` run in a throwaway folder, with
Codex's sandbox limiting what it can write to that folder."""
import asyncio
import glob
import logging
import os
import shutil
import tempfile
import time

from backend.config import settings

logger = logging.getLogger(__name__)

# An image edit took just under two minutes when measured; this leaves room for a slow day
RUN_TIMEOUT = 420.0
_HOME = os.path.expanduser("~")
# Where the tool lives when it came with an editor extension or the desktop app, not on PATH
_BUNDLED = [
    os.path.join(_HOME, ".vscode", "extensions", "openai.chatgpt-*", "bin", "*", "codex"),
    os.path.join(_HOME, ".cursor", "extensions", "openai.chatgpt-*", "bin", "*", "codex"),
    os.path.join(_HOME, ".windsurf", "extensions", "openai.chatgpt-*", "bin", "*", "codex"),
    "/Applications/Codex.app/Contents/Resources/codex",
]


class CodexError(RuntimeError):
    """Something the person can be told about and act on."""


def find_codex() -> str | None:
    """The Codex program to run, or None when it is not on this machine."""
    if settings.codex_path:
        return settings.codex_path if os.access(settings.codex_path, os.X_OK) else None
    on_path = shutil.which("codex")
    if on_path:
        return on_path
    found = [p for pattern in _BUNDLED for p in glob.glob(pattern) if os.access(p, os.X_OK)]
    # several versions of the extension can be installed side by side; the newest is the one in use
    return max(found, key=os.path.getmtime) if found else None


async def _run(args: list[str], cwd: str | None = None, timeout: float = RUN_TIMEOUT) -> tuple[int, str]:
    """Run the tool; returns its exit code and everything it printed."""
    proc = await asyncio.create_subprocess_exec(
        *args, cwd=cwd, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise CodexError("Codex took too long and was stopped.")
    return proc.returncode or 0, out.decode("utf-8", "replace")


async def status() -> dict:
    """Whether Codex can be used here: {"installed", "signed_in"}."""
    program = find_codex()
    if not program:
        return {"installed": False, "signed_in": False}
    try:
        code, out = await _run([program, "login", "status"], timeout=20)
    except Exception as exc:                      # a broken install is the same as none
        logger.warning("codex status failed: %s", exc)
        return {"installed": True, "signed_in": False}
    return {"installed": True, "signed_in": code == 0 and "not logged in" not in out.lower()}


async def ask_about_image(image: bytes, question: str) -> str:
    """Have Codex look at a picture and answer in text. It is given nothing it can write to."""
    program = find_codex()
    if not program:
        raise CodexError("Codex is not installed on this computer.")
    folder = tempfile.mkdtemp(prefix="codex_image_")
    try:
        source = os.path.join(folder, "source.jpg")
        answer = os.path.join(folder, "answer.txt")
        with open(source, "wb") as out:
            out.write(image)
        base = [program, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
                "-c", 'model_reasoning_effort="low"', "-C", folder, "-i", source, "-o", answer]
        attempts = [["-m", settings.codex_model]] if settings.codex_model else []
        attempts.append([])
        for extra in attempts:
            _, output = await _run([*base, *extra, question], cwd=folder, timeout=180)
            if os.path.exists(answer):
                with open(answer, encoding="utf-8") as src:
                    text = src.read().strip()
                if text:
                    return text
            if "model" not in output.lower():
                break
        raise CodexError("Codex did not answer.")
    finally:
        shutil.rmtree(folder, ignore_errors=True)


def _newest_generated(since: float) -> str | None:
    """The picture Codex made in this run, from its own store, for when it did not copy it out."""
    made = [p for p in glob.glob(os.path.join(_HOME, ".codex", "generated_images", "*", "*.png"))
            if os.path.getmtime(p) >= since]
    return max(made, key=os.path.getmtime) if made else None


async def edit_image(image: bytes, instruction: str) -> bytes:
    """Have Codex edit a picture with its image tool; returns the edited picture's bytes."""
    program = find_codex()
    if not program:
        raise CodexError("Codex is not installed on this computer.")
    folder = tempfile.mkdtemp(prefix="codex_image_")
    started = time.time()
    try:
        source = os.path.join(folder, "source.jpg")
        result = os.path.join(folder, "result.png")
        with open(source, "wb") as out:
            out.write(image)
        prompt = (
            "Use your image generation tool to edit the attached picture (also saved as "
            f"source.jpg in this folder).\n{instruction}\n"
            "Save the edited picture in this folder as result.png and reply with only: DONE"
        )
        base = [program, "exec", "--skip-git-repo-check", "--ephemeral", "-s", "workspace-write",
                "-c", 'model_reasoning_effort="low"', "-C", folder, "-i", source]
        # the model named in settings first; if this Codex does not know it, its own default
        attempts = [["-m", settings.codex_model]] if settings.codex_model else []
        attempts.append([])
        output = ""
        for extra in attempts:
            code, output = await _run([*base, *extra, prompt], cwd=folder)
            picture = result if os.path.exists(result) else _newest_generated(started)
            if picture:
                with open(picture, "rb") as src:
                    return src.read()
            logger.warning("codex image edit gave no picture (exit %s): %s", code, output[-300:])
            if "model" not in output.lower():
                break                            # not a problem another model name would fix
        low = output.lower()
        if "not logged in" in low or "401" in low or "login" in low and "required" in low:
            raise CodexError("Codex is not signed in. Open Codex and sign in with ChatGPT, then try again.")
        if "usage limit" in low or "rate limit" in low or "429" in low:
            raise CodexError("Your ChatGPT plan's Codex limit is used up for now. Try again later.")
        raise CodexError("Codex did not return an edited picture.")
    finally:
        shutil.rmtree(folder, ignore_errors=True)
