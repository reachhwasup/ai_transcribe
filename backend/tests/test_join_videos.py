import asyncio
import os
import shutil
import subprocess
import tempfile
import unittest

from backend.api.routes import join as jr
from backend.services import join_videos as jv

FFMPEG = shutil.which("ffmpeg")


def make_video(path, seconds, size="160x90", tone=440):
    subprocess.run([FFMPEG, "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=25:duration={seconds}",
                    "-f", "lavfi", "-i", f"sine=frequency={tone}:duration={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-shortest", path], check=True)


class NamesAndChaptersTest(unittest.TestCase):
    def test_the_episode_is_the_last_number_in_the_name(self):
        self.assertEqual(jv.episode_of("Series - EP012.mp4"), 12)
        self.assertEqual(jv.episode_of("Series 2 - Episode_003_custom.mp4"), 3)
        self.assertIsNone(jv.episode_of("trailer.mp4"))

    def test_episode_files_are_found_in_order_and_joined_files_are_left_out(self):
        folder = tempfile.mkdtemp()
        for name in ("S - EP010.mp4", "S - EP002.mp4", "S - Episode (1-10).mp4", "notes.txt", "trailer.mp4", ".hidden1.mp4"):
            open(os.path.join(folder, name), "wb").close()
        self.assertEqual([v["episode"] for v in jv.find_videos(folder)], [2, 10])
        self.assertEqual(jv.find_videos(os.path.join(folder, "missing")), [])

    def test_of_two_files_for_one_episode_the_newer_is_kept(self):
        folder = tempfile.mkdtemp()
        for name, age in (("S - EP001.mp4", 100), ("S_Episode_001_custom.mp4", 10)):
            path = os.path.join(folder, name)
            open(path, "wb").close()
            os.utime(path, (os.path.getmtime(path) - age,) * 2)
        self.assertEqual([v["name"] for v in jv.find_videos(folder)], ["S_Episode_001_custom.mp4"])

    def test_only_the_named_series_is_taken_from_a_shared_folder(self):
        folder = tempfile.mkdtemp()
        for name in ("War God_-_Episode_001.mp4", "War God - EP002.mp4", "Other Show - EP001.mp4"):
            open(os.path.join(folder, name), "wb").close()
        self.assertEqual([v["name"] for v in jv.find_videos(folder, "War God")], ["War God_-_Episode_001.mp4", "War God - EP002.mp4"])
        self.assertEqual(len(jv.find_videos(folder, "Renamed Since")), 2)      # nothing carries it: all, newest per episode

    def test_chapters_start_where_the_episode_before_ends(self):
        marks = jv.chapters([118.0, 75.5, 3700.0], ["Episode 1", "Episode 2", "Episode 3"])
        self.assertEqual([m["start"] for m in marks], [0.0, 118.0, 193.5])
        self.assertEqual(jv.chapter_text(marks), "0:00 Episode 1\n1:58 Episode 2\n3:13 Episode 3")
        self.assertEqual(jv.clock(3893.5), "1:04:53")
        self.assertIn("START=118000", jv.metadata_file(marks))

    def test_the_joined_file_is_named_for_its_episodes(self):
        self.assertEqual(jr.output_name("My: Series", 1, 10, "/out"), "/out/My Series - Episode (1-10).mp4")
        self.assertEqual(jr.output_name("", 3, 4, "/out"), "/out/Episode (3-4).mp4")
        self.assertTrue(jv.is_joined("My Series - Episode (1-10).mp4"))
        self.assertFalse(jv.is_joined("My Series (2024) - EP001.mp4"))


@unittest.skipUnless(FFMPEG and shutil.which("ffprobe"), "ffmpeg is needed")
class JoinTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, True)

    def path(self, name):
        return os.path.join(self.folder, name)

    async def test_like_files_are_joined_without_encoding_and_carry_chapters(self):
        make_video(self.path("S - EP001.mp4"), 2), make_video(self.path("S - EP002.mp4"), 3, tone=660)
        seen = []
        result = await jv.join([self.path("S - EP001.mp4"), self.path("S - EP002.mp4")], ["Episode 1", "Episode 2"],
                               self.path("out.mp4"), lambda percent, message: seen.append(percent))
        self.assertFalse(result["reencoded"])
        self.assertAlmostEqual(jv.probe(self.path("out.mp4"))["duration"], 5.0, delta=0.3)
        self.assertEqual(result["chapter_text"].splitlines()[1][:4], "0:02")
        listed = subprocess.run(["ffprobe", "-v", "error", "-show_chapters", "-of", "json", self.path("out.mp4")], capture_output=True, text=True).stdout
        self.assertIn("Episode 2", listed)
        self.assertTrue(seen)

    async def test_files_of_different_sizes_are_encoded_to_the_first(self):
        make_video(self.path("a.mp4"), 2), make_video(self.path("b.mp4"), 2, size="120x120")
        result = await jv.join([self.path("a.mp4"), self.path("b.mp4")], ["Episode 1", "Episode 2"], self.path("out.mp4"))
        self.assertTrue(result["reencoded"])
        info = jv.probe(self.path("out.mp4"))
        self.assertEqual((info["width"], info["height"]), (160, 90))
        self.assertAlmostEqual(info["duration"], 4.0, delta=0.3)

    async def test_one_video_or_an_unreadable_one_is_refused(self):
        with self.assertRaises(RuntimeError):
            await jv.join([self.path("a.mp4")], ["Episode 1"], self.path("out.mp4"))
        open(self.path("bad1.mp4"), "wb").close(), open(self.path("bad2.mp4"), "wb").close()
        with self.assertRaises(RuntimeError):
            await jv.join([self.path("bad1.mp4"), self.path("bad2.mp4")], ["1", "2"], self.path("out.mp4"))

    async def test_the_route_joins_the_chosen_episodes_and_writes_the_chapter_list(self):
        for n in (1, 2, 3):
            make_video(self.path(f"S - EP00{n}.mp4"), 1)
        jr._jobs.clear()
        job = await jr.start_join(jr.JoinRequest(folder=self.folder, first=2, last=3, name="S"))
        self.assertEqual(job.count, 2)
        await jr._tasks[job.id]
        self.assertEqual((job.status, job.error), ("done", None))
        self.assertTrue(os.path.exists(self.path("S - Episode (2-3).mp4")))
        with open(self.path("S - Episode (2-3) chapters.txt"), encoding="utf-8") as f:
            self.assertEqual(f.read().splitlines()[0], "0:00 Episode 2")
        # the joined file is not picked up as an episode next time
        self.assertEqual([v["episode"] for v in jv.find_videos(self.folder)], [1, 2, 3])


@unittest.skipUnless(FFMPEG and shutil.which("ffprobe"), "ffmpeg is needed")
class JoinAfterExportsTest(unittest.IsolatedAsyncioTestCase):
    """A plan made with a batch of exports joins each group once its files have arrived."""

    def setUp(self):
        self.folder = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.folder, True)
        jr._jobs.clear(), jr._plans.clear()

    def export(self, episode, age=0):
        path = os.path.join(self.folder, f"S - EP00{episode}.mp4")
        make_video(path, 1)
        if age:
            os.utime(path, (os.path.getmtime(path) - age,) * 2)

    async def test_a_group_waits_for_all_its_exports_and_old_files_do_not_count(self):
        self.export(1, age=3600)                       # left from an earlier export
        plan = await jr.plan_join(jr.PlanRequest(folder=self.folder, series="S", name="S", groups=[[1, 2], [3, 4], [5]]))
        self.assertEqual([g.episodes for g in plan.groups], [[1, 2], [3, 4]])      # one episode is no join
        self.export(2)
        await jr.check_plans()
        self.assertEqual([g.status for g in plan.groups], ["waiting", "waiting"])
        self.export(1), self.export(3), self.export(4)
        await jr.check_plans()
        self.assertEqual([g.status for g in plan.groups], ["joining", "waiting"])  # one at a time
        await jr._tasks[plan.groups[0].job_id]
        await jr.check_plans()
        self.assertEqual([g.status for g in plan.groups], ["done", "joining"])
        await jr._tasks[plan.groups[1].job_id]
        await jr.check_plans()
        self.assertEqual(jr._plans, [])                # all done: the plan is finished with
        self.assertTrue(os.path.exists(os.path.join(self.folder, "S - Episode (1-2).mp4")))
        self.assertTrue(os.path.exists(os.path.join(self.folder, "S - Episode (3-4).mp4")))

    async def test_exports_that_never_come_are_given_up_on_and_a_plan_can_be_cancelled(self):
        import time
        plan = await jr.plan_join(jr.PlanRequest(folder=self.folder, groups=[[1, 2]]))
        await jr.check_plans(now=time.time() + jr.PLAN_GIVEN_UP_AFTER + 1)
        self.assertEqual(jr._plans, [])
        plan = await jr.plan_join(jr.PlanRequest(folder=self.folder, groups=[[1, 2]]))
        await jr.cancel_plan(plan.id)
        self.assertEqual(jr._plans, [])
        with self.assertRaises(Exception):
            await jr.plan_join(jr.PlanRequest(folder=self.folder, groups=[[1]]))


if __name__ == "__main__":
    unittest.main()
