import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.services import gemini_marketing as gm


def reply(texts):
    return SimpleNamespace(text=json.dumps([{"hook_id": f"hook_{i}", "text": t} for i, t in enumerate(texts, 1)], ensure_ascii=False))


LINE = "អ្នកណាទៅដឹងថាគាត់ជាមហាសេដ្ឋីលាក់មុខ។ "       # one sentence, about 37 characters


class LongHookTest(unittest.IsolatedAsyncioTestCase):
    async def generate(self, seconds, replies):
        prompts = []

        async def fake(prompt, **_):
            prompts.append(prompt)
            return replies[min(len(prompts), len(replies)) - 1]

        with patch.object(gm, "_generate_with_fallback", fake):
            hooks = await gm.generate_catchy_hooks("Film", "transcript", duration_seconds=seconds)
        return hooks, prompts

    async def test_a_long_hook_is_asked_for_as_several_lines_with_a_job_each(self):
        hooks, prompts = await self.generate(30, [reply([LINE * 12] * 6)])
        self.assertEqual(len(prompts), 1)                       # long enough: no second ask
        self.assertIn("at least 450 characters", prompts[0])
        self.assertIn("the cliffhanger", prompts[0])
        self.assertEqual(hooks[0]["lines"], 12)
        self.assertAlmostEqual(hooks[0]["estimated_seconds"], len(hooks[0]["text"]) / 15, delta=0.1)

    async def test_a_long_hook_that_comes_back_short_is_asked_for_again(self):
        hooks, prompts = await self.generate(20, [reply([LINE] * 6), reply([LINE * 8] * 6)])
        self.assertEqual(len(prompts), 2)
        self.assertIn("PREVIOUS ATTEMPT WAS TOO SHORT", prompts[1])
        self.assertEqual(hooks[0]["lines"], 8)

    async def test_short_hooks_are_unchanged(self):
        hooks, prompts = await self.generate(4.5, [reply([LINE] * 6)])
        self.assertEqual(len(prompts), 1)
        self.assertNotIn("the cliffhanger —", prompts[0])
        self.assertEqual(hooks[0]["estimated_seconds"], 4.5)

    async def test_the_length_is_capped(self):
        _, prompts = await self.generate(120, [reply([LINE * 12] * 6)])
        self.assertIn("~30s of narration", prompts[0])


if __name__ == "__main__":
    unittest.main()
