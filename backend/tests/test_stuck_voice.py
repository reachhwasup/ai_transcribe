"""A voice request that never answers must not freeze a dubbing job."""
import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from backend.api.routes import pipeline as pl
from backend.services.tts_service import finish_within


class FinishWithinTest(unittest.IsolatedAsyncioTestCase):
    async def test_work_that_will_not_stop_is_left_behind(self):
        released = asyncio.Event()

        async def stubborn():
            # like a websocket stuck in its close handshake: it ignores being cancelled
            while not released.is_set():
                try:
                    await asyncio.sleep(0.05)
                except asyncio.CancelledError:
                    continue

        started = asyncio.get_running_loop().time()
        with self.assertRaises(TimeoutError):
            await finish_within(stubborn(), 0.2)
        self.assertLess(asyncio.get_running_loop().time() - started, 1.0)   # asyncio.wait_for would hang here
        released.set()              # let the abandoned work end, so the test can close its loop
        await asyncio.sleep(0.1)

    async def test_a_quick_answer_comes_back(self):
        async def quick():
            return 7
        self.assertEqual(await finish_within(quick(), 1), 7)


class SpeakersStepTest(unittest.IsolatedAsyncioTestCase):
    async def test_no_quota_for_speakers_does_not_stop_the_dubbing(self):
        from fastapi import HTTPException

        class Session:
            async def __aenter__(self):
                return SimpleNamespace()

            async def __aexit__(self, *exc):
                return False

        job = pl.PipelineJob(id="j", project_id="p", project_name="Film", status="running", steps=["speakers", "dubbing"], queued_at="now")
        with patch.object(pl, "async_session", Session), \
             patch("backend.api.routes.transcripts.identify_speakers", AsyncMock(side_effect=HTTPException(502, "The Gemini request limit was reached"))):
            await pl._step_speakers(job, pl.PipelineOptions())
        self.assertIn("Speakers not identified", job.notes[0])
        self.assertIn("request limit", job.notes[0])


if __name__ == "__main__":
    unittest.main()
