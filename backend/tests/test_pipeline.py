import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from backend.api.routes import pipeline as pl


class StreamEventsTest(unittest.IsolatedAsyncioTestCase):
    async def test_reads_the_events_of_a_streaming_endpoint(self):
        async def body():
            yield 'data: {"type": "progress", "percent": 40}\n\n'
            yield b'data: {"type": "done", "total_segments": 3}\n\n'
            yield 'data: not json\n\n'
        events = [e async for e in pl.stream_events(SimpleNamespace(body_iterator=body()))]
        self.assertEqual([e["type"] for e in events], ["progress", "done"])


class MusicStepTest(unittest.IsolatedAsyncioTestCase):
    """Isolating the background music as part of the queue."""

    def setUp(self):
        import os
        import tempfile
        self.folder = tempfile.mkdtemp()
        self.video = os.path.join(self.folder, "film.mp4")
        open(self.video, "wb").close()
        self.job = pl.PipelineJob(id="j", project_id="p", project_name="Film", status="running", steps=["music"], queued_at="now")

    def session(self, video_path):
        db = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(video_path=video_path)))

        class Session:
            async def __aenter__(self):
                return db

            async def __aexit__(self, *exc):
                return False

        return patch.object(pl, "async_session", Session)

    async def test_the_sound_is_split_and_the_progress_shown(self):
        import os
        import time
        from backend.services import video_service as vs
        seen = {}

        def separate(video_path, project_dir):
            seen.update(video=video_path, folder=project_dir)
            vs.separation_progress[project_dir] = {"percent": 40, "eta_seconds": 150}
            time.sleep(2.3)
            vs.separation_progress.pop(project_dir, None)

        with self.session(self.video), patch.object(vs, "separate_audio", separate), patch.object(vs, "stems_ready", return_value=False):
            await pl._step_music(self.job, pl.PipelineOptions())
        self.assertEqual(seen["folder"], os.path.abspath(self.folder))
        self.assertEqual(self.job.percent, 40)
        self.assertIn("about 2 min left", self.job.message)        # 150 seconds, said in minutes
        self.assertEqual(self.job.notes, ["Background music isolated"])

    async def test_music_already_isolated_is_kept(self):
        from backend.services import video_service as vs
        never = AsyncMock()
        with self.session(self.video), patch.object(vs, "separate_audio", never), patch.object(vs, "stems_ready", return_value=True):
            await pl._step_music(self.job, pl.PipelineOptions())
        never.assert_not_called()
        self.assertEqual(self.job.notes, ["Kept the background music already isolated"])

    async def test_a_failed_separation_or_a_missing_video_fails_the_step(self):
        from backend.services import video_service as vs

        def broken(video_path, project_dir):
            raise RuntimeError("Demucs ran out of memory")

        with self.session(self.video), patch.object(vs, "separate_audio", broken), patch.object(vs, "stems_ready", return_value=False):
            with self.assertRaisesRegex(RuntimeError, "out of memory"):
                await pl._step_music(self.job, pl.PipelineOptions())
        with self.session("/nowhere/film.mp4"):
            with self.assertRaisesRegex(RuntimeError, "no video"):
                await pl._step_music(self.job, pl.PipelineOptions())

    def test_music_runs_before_the_steps_that_need_gemini(self):
        self.assertEqual([name for name, _, _ in pl.STEPS], ["music", "captions", "speakers", "repair", "dubbing", "export"])


class PipelineRunTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        pl._jobs.clear()
        pl._options.clear()
        pl._quota_until = None
        for target, stand_in in (("_caption_count", AsyncMock(return_value=0)), ("_persist", AsyncMock())):
            patcher = patch.object(pl, target, stand_in)
            patcher.start()
            self.addCleanup(patcher.stop)

    def job(self, steps):
        job = pl.PipelineJob(id="j", project_id="p", project_name="Film", status="queued", steps=steps, queued_at="now")
        pl._options[job.id] = pl.PipelineOptions()
        return job

    async def test_runs_the_chosen_steps_in_order(self):
        ran = []

        def step(name):
            async def run(job, options):
                ran.append(name)
                job.notes.append(name)
            return run

        steps = tuple((n, "…", step(n)) for n in ("captions", "dubbing", "export"))
        with patch.object(pl, "STEPS", steps), patch.object(pl, "_review", AsyncMock(return_value=[])):
            job = self.job(["captions", "export"])
            await pl._run_one(job)
        self.assertEqual(ran, ["captions", "export"])
        self.assertEqual((job.status, job.percent), ("done", 100))

    async def test_a_failed_step_stops_the_job_and_says_why(self):
        async def boom(job, options):
            raise RuntimeError("The video has no sound")
        never = AsyncMock()
        with patch.object(pl, "STEPS", (("captions", "…", boom), ("dubbing", "…", never))):
            job = self.job(["captions", "dubbing"])
            await pl._run_one(job)
        self.assertEqual((job.status, job.error), ("error", "The video has no sound"))
        never.assert_not_awaited()

    async def test_existing_captions_are_kept_not_rewritten(self):
        with patch.object(pl, "_caption_count", AsyncMock(return_value=12)), \
             patch("backend.api.routes.transcripts.generate_transcript_stream", AsyncMock()) as transcribe:
            job = self.job(["captions"])
            await pl._step_captions(job, pl.PipelineOptions())
        transcribe.assert_not_awaited()
        self.assertIn("12 captions", job.notes[0])

    async def test_one_job_failing_does_not_stop_the_queue(self):
        async def step(job, options):
            if job.project_id == "bad":
                raise RuntimeError("no video")
        with patch.object(pl, "STEPS", (("captions", "…", step),)):
            for pid in ("bad", "good"):
                j = pl.PipelineJob(id=pid, project_id=pid, project_name=pid, status="queued", steps=["captions"], queued_at="now")
                pl._jobs.append(j)
                pl._options[j.id] = pl.PipelineOptions()
            await pl._drain()
        self.assertEqual([j.status for j in pl._jobs], ["error", "done"])


if __name__ == "__main__":
    unittest.main()


class RestartTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        pl._jobs.clear()
        pl._options.clear()

    def tearDown(self):
        if pl._worker and not pl._worker.done():
            pl._worker.cancel()
        pl._jobs.clear()
        pl._options.clear()

    async def test_waiting_and_interrupted_jobs_run_again_and_finished_ones_stay_finished(self):
        saved = {
            "jobs": [
                {"id": "a", "project_id": "p1", "project_name": "One", "status": "running", "step": "dubbing",
                 "steps": ["captions", "dubbing"], "percent": 40, "queued_at": "t"},
                {"id": "b", "project_id": "p2", "project_name": "Two", "status": "queued", "steps": ["captions"], "queued_at": "t"},
                {"id": "c", "project_id": "p3", "project_name": "Three", "status": "done", "steps": ["captions"], "queued_at": "t"},
            ],
            "options": {"a": {"language": "km", "dub": True}, "b": {"language": "en"}},
        }
        never = asyncio.Event()

        async def hold(job, options):
            await never.wait()

        with patch.object(pl.queue_store, "load", AsyncMock(return_value=saved)), \
             patch.object(pl, "STEPS", (("captions", "…", hold),)):
            resumed = await pl.restore()
            self.assertEqual(resumed, 2)
            by_id = {j.id: j for j in pl._jobs}
            self.assertEqual(by_id["c"].status, "done")
            self.assertEqual(by_id["b"].status, "queued")
            self.assertEqual(pl._options["b"].language, "en")
            self.assertEqual(by_id["a"].percent, 0)          # starts over; its steps skip finished work

    async def test_a_job_cut_off_by_shutdown_is_not_marked_cancelled(self):
        started = asyncio.Event()

        async def hold(job, options):
            started.set()
            await asyncio.Event().wait()

        job = pl.PipelineJob(id="j", project_id="p", project_name="Film", status="queued", steps=["captions"], queued_at="t")
        pl._options[job.id] = pl.PipelineOptions()
        with patch.object(pl, "STEPS", (("captions", "…", hold),)):
            task = asyncio.create_task(pl._run_one(job))
            await started.wait()
            task.cancel()                                     # what a server shutdown does
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(job.status, "running")              # saved as running, so it resumes
        self.assertIn(job.id, pl._options)

    async def test_a_job_the_user_stops_is_cancelled_for_good(self):
        started = asyncio.Event()

        async def hold(job, options):
            started.set()
            await asyncio.Event().wait()

        job = pl.PipelineJob(id="j", project_id="p", project_name="Film", status="queued", steps=["captions"], queued_at="t")
        pl._options[job.id] = pl.PipelineOptions()
        with patch.object(pl, "STEPS", (("captions", "…", hold),)):
            task = asyncio.create_task(pl._run_one(job))
            await started.wait()
            pl._stopped_by_user.add(job.id)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertEqual(job.status, "cancelled")
        self.assertNotIn(job.id, pl._options)


class HoldForReviewTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        pl._jobs.clear()
        pl._options.clear()

    def tearDown(self):
        if pl._worker and not pl._worker.done():
            pl._worker.cancel()
        pl._jobs.clear()
        pl._options.clear()

    def job(self):
        job = pl.PipelineJob(id="j", project_id="p", project_name="Film", status="queued", steps=["dubbing", "export"], queued_at="t")
        pl._jobs.append(job)
        pl._options[job.id] = pl.PipelineOptions(export=True)
        return job

    async def test_the_export_waits_when_the_review_finds_something(self):
        exported, dubbed = AsyncMock(), AsyncMock()
        issue = {"key": "unvoiced", "severity": "problem", "count": 3, "title": "3 lines have no voice", "hint": "…"}
        with patch.object(pl, "STEPS", (("dubbing", "…", dubbed), ("export", "…", exported))), \
             patch.object(pl, "_review", AsyncMock(return_value=[issue])):
            job = self.job()
            await pl._run_one(job)
        dubbed.assert_awaited_once()
        exported.assert_not_awaited()
        self.assertEqual((job.status, job.issues, job.finished_at), ("review", [issue], None))
        self.assertIn("j", pl._options)                       # kept, so it can still be approved

    async def test_a_clean_review_exports_straight_away(self):
        exported = AsyncMock()
        with patch.object(pl, "STEPS", (("export", "…", exported),)), patch.object(pl, "_review", AsyncMock(return_value=[])):
            job = self.job()
            await pl._run_one(job)
        exported.assert_awaited_once()
        self.assertEqual(job.status, "done")

    async def test_approving_exports_it_as_it_is(self):
        exported = AsyncMock()
        review = AsyncMock(return_value=[{"key": "too_long", "severity": "check", "count": 1, "title": "t", "hint": "h"}])
        with patch.object(pl, "STEPS", (("dubbing", "…", AsyncMock()), ("export", "…", exported))), patch.object(pl, "_review", review):
            job = self.job()
            await pl._run_one(job)
            self.assertEqual(job.status, "review")
            await pl.approve_export("j")
            await pl._worker
        exported.assert_awaited_once()
        self.assertEqual(review.await_count, 1)               # approved: not asked a second time
        self.assertEqual((job.status, job.issues), ("done", []))


class ScheduleExportTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.jobs = patch.object(pl, "_jobs", [])
        self.options = patch.object(pl, "_options", {})
        self.jobs.start()
        self.options.start()
        self.addCleanup(self.jobs.stop)
        self.addCleanup(self.options.stop)
        self.db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(
            scalar_one_or_none=lambda: SimpleNamespace(name="Episode 1"))))
        self.persist = patch.object(pl, "_persist", AsyncMock())
        self.persist.start()
        self.addCleanup(self.persist.stop)
        self.worker = patch.object(pl, "_ensure_worker")
        self.worker.start()
        self.addCleanup(self.worker.stop)

    def job(self, status="queued", steps=None):
        job = pl.PipelineJob(id="j", project_id="p", project_name="Episode 1",
                             status=status, steps=steps or ["dubbing"], queued_at="now")
        pl._jobs.append(job)
        pl._options[job.id] = pl.PipelineOptions(captions=False, dub=True)
        return job

    def request(self):
        return pl.PipelineOptions(captions=False, dub=False, export=True,
            export_request=pl.VideoExportRequest(platform="tiktok", include_voice=True,
                include_subtitles=True, background_audio="music", export_folder="/exports"))

    async def test_export_appends_to_queued_work_and_repeated_click_is_idempotent(self):
        job = self.job()
        original = pl._options[job.id]
        await pl.add_to_pipeline("p", self.request(), self.db)
        await pl.add_to_pipeline("p", self.request(), self.db)
        self.assertEqual(job.steps, ["dubbing", "export"])
        self.assertEqual(len(pl._jobs), 1)
        self.assertIs(pl._options[job.id], original)
        self.assertTrue(original.dub)
        self.assertEqual(original.export_request.export_folder, "/exports")

    async def test_running_dub_finishes_before_appended_export_with_requested_settings(self):
        job = self.job()
        started, finish = asyncio.Event(), asyncio.Event()
        seen = []

        async def dub(job, options):
            started.set()
            await finish.wait()
            seen.append("dub")

        async def export(job, options):
            seen.append(options.export_request.platform)

        with patch.object(pl, "STEPS", (("dubbing", "…", dub), ("export", "…", export))), \
             patch.object(pl, "_review", AsyncMock(return_value=[])):
            task = asyncio.create_task(pl._run_one(job))
            await started.wait()
            await pl.add_to_pipeline("p", self.request(), self.db)
            finish.set()
            await task
        self.assertEqual(seen, ["dub", "tiktok"])
        self.assertEqual(job.status, "done")

    async def test_held_review_is_preserved(self):
        job = self.job("review", ["dubbing", "export"])
        job.issues = [{"key": "unvoiced", "title": "Missing voices"}]
        returned = await pl.add_to_pipeline("p", self.request(), self.db)
        self.assertIs(returned, job)
        self.assertEqual(job.status, "review")
        self.assertTrue(job.issues)

    async def test_finished_project_gets_export_only_job(self):
        job = self.job("done")
        returned = await pl.add_to_pipeline("p", self.request(), self.db)
        self.assertNotEqual(returned.id, job.id)
        self.assertEqual(returned.steps, ["export"])
        self.assertEqual(returned.status, "queued")


class FixReviewTest(ScheduleExportTest):
    async def test_fix_preserves_export_settings_and_queues_review_after_dubbing(self):
        job = self.job("review", ["export"])
        options = self.request()
        pl._options[job.id] = options
        await pl.fix_for_export(job.id)
        await pl.fix_for_export(job.id)
        self.assertEqual(job.steps, ["repair", "dubbing", "export"])
        self.assertTrue(options.hold_for_review)
        self.assertEqual(options.export_request.export_folder, "/exports")
        self.assertEqual(len(pl._jobs), 1)

    async def test_unresolved_issues_hold_export_after_repair(self):
        job = self.job("review", ["export"])
        await pl.fix_for_export(job.id)
        repair, dub, export = AsyncMock(), AsyncMock(), AsyncMock()
        with patch.object(pl, "STEPS", (("repair", "…", repair), ("dubbing", "…", dub), ("export", "…", export))), \
             patch.object(pl, "_review", AsyncMock(return_value=[{"key": "too_long"}])):
            await pl._run_one(job)
        repair.assert_awaited_once()
        dub.assert_awaited_once()
        export.assert_not_awaited()
        self.assertEqual(job.status, "review")

    async def test_fix_rejects_completed_job(self):
        from fastapi import HTTPException
        job = self.job("done")
        with self.assertRaises(HTTPException) as caught:
            await pl.fix_for_export(job.id)
        self.assertEqual(caught.exception.status_code, 400)


class CompletedCleanupTest(unittest.IsolatedAsyncioTestCase):
    async def test_only_successful_jobs_expire_at_two_minutes(self):
        from datetime import datetime, timedelta
        now = datetime(2026, 10, 4, 1, 22)
        jobs = [pl.PipelineJob(id=str(i), project_id=str(i), project_name="Episode",
            status=status, steps=[], queued_at="now", finished_at=(now - timedelta(seconds=age)).isoformat())
            for i, (status, age) in enumerate([
                ("done", 119), ("done", 120), ("done", 400),
                ("error", 400), ("review", 400), ("running", 400), ("cancelled", 400)])]
        options = {j.id: pl.PipelineOptions() for j in jobs}
        with patch.object(pl, "_jobs", jobs), patch.object(pl, "_options", options), \
             patch.object(pl, "_persist", AsyncMock()) as persist:
            self.assertEqual(await pl.cleanup_completed(now), 2)
            self.assertEqual([j.id for j in jobs], ["0", "3", "4", "5", "6"])
            self.assertNotIn("1", options)
            persist.assert_awaited_once()
            self.assertEqual(await pl.cleanup_completed(now), 0)
            persist.assert_awaited_once()

    async def test_invalid_or_missing_finish_time_is_kept(self):
        jobs = [pl.PipelineJob(id=str(i), project_id="p", project_name="Episode",
            status="done", steps=[], queued_at="now", finished_at=value)
            for i, value in enumerate([None, "invalid"])]
        with patch.object(pl, "_jobs", jobs), patch.object(pl, "_persist", AsyncMock()) as persist:
            self.assertEqual(await pl.cleanup_completed(), 0)
            self.assertEqual(len(jobs), 2)
            persist.assert_not_awaited()


class LogoFieldsTest(unittest.TestCase):
    def test_a_saved_logo_becomes_export_fields(self):
        fields = pl.logo_fields({"enabled": True, "url": "/uploads/p/logo.png", "position": "top_left",
                                 "scale_pct": 12, "opacity": 0.8, "x_pct": 40, "y_pct": 60})
        self.assertEqual((fields["logo_url"], fields["logo_enabled"], fields["logo_position"]), ("/uploads/p/logo.png", True, "top_left"))
        self.assertEqual((fields["logo_scale_pct"], fields["logo_opacity"]), (12.0, 0.8))
        self.assertIsNone(fields["logo_x_pct"])        # a corner needs no coordinates
        custom = pl.logo_fields({"url": "x", "position": "custom", "x_pct": 40, "y_pct": 60, "opacity": 0})
        self.assertEqual((custom["logo_x_pct"], custom["logo_y_pct"], custom["logo_opacity"]), (40.0, 60.0, 0.0))
        pl.VideoExportRequest().model_copy(update=fields)


class QuotaWaitTest(unittest.IsolatedAsyncioTestCase):
    """Out of Gemini quota, work waits and is picked up again instead of failing."""

    def setUp(self):
        self.saved = (list(pl._jobs), dict(pl._options), pl._quota_until, pl.STEPS)
        pl._jobs.clear(), pl._options.clear()
        pl._quota_until = None
        for target, stand_in in (("_caption_count", AsyncMock(return_value=0)), ("_persist", AsyncMock())):
            patcher = patch.object(pl, target, stand_in)
            patcher.start()
            self.addCleanup(patcher.stop)

    def tearDown(self):
        pl._jobs[:], pl._quota_until, pl.STEPS = self.saved[0], self.saved[2], self.saved[3]
        pl._options.clear(), pl._options.update(self.saved[1])

    def job(self, name, steps):
        job = pl.PipelineJob(id=name, project_id=name, project_name=name, status="queued", steps=steps, queued_at="now")
        pl._jobs.append(job)
        pl._options[name] = pl.PipelineOptions()
        return job

    async def test_a_step_refused_for_quota_waits_instead_of_failing(self):
        async def refused(job, options):
            raise RuntimeError("429 You exceeded your current quota")
        pl.STEPS = (("speakers", "…", refused),)
        job = self.job("a", ["speakers"])
        await pl._run_one(job)
        self.assertEqual(job.status, "queued")
        self.assertIsNone(job.error)
        self.assertTrue(pl._waiting_for_quota(job))
        self.assertIn("trying again at", job.message)
        self.assertIn("a", pl._options)        # it keeps what it was asked to do

    async def test_an_ordinary_failure_still_fails(self):
        async def broken(job, options):
            raise RuntimeError("the video is unreadable")
        pl.STEPS = (("speakers", "…", broken),)
        job = self.job("a", ["speakers"])
        await pl._run_one(job)
        self.assertEqual((job.status, job.error), ("error", "the video is unreadable"))

    async def test_the_next_job_does_not_ask_again_but_does_its_other_work(self):
        asked = []

        async def music(job, options):
            asked.append(("music", job.id))

        async def refused(job, options):
            asked.append(("speakers", job.id))
            raise RuntimeError("quota exhausted")
        pl.STEPS = (("music", "…", music), ("speakers", "…", refused))
        first, second = self.job("a", ["music", "speakers"]), self.job("b", ["music", "speakers"])
        await pl._run_one(first)
        await pl._run_one(second)
        self.assertEqual(asked, [("music", "a"), ("speakers", "a"), ("music", "b")])
        self.assertEqual(second.retry_at, first.retry_at)

    async def test_each_wait_is_longer_and_success_clears_it(self):
        calls = {"n": 0}

        async def flaky(job, options):
            calls["n"] += 1
            if calls["n"] < 3:
                raise RuntimeError("429")
        pl.STEPS = (("speakers", "…", flaky),)
        job = self.job("a", ["speakers"])
        waits = []
        for _ in range(2):
            await pl._run_one(job)
            waits.append(pl._quota_until)
            pl._quota_until = None           # the wait is over
        self.assertEqual(job.waits, 2)
        await pl._run_one(job)
        self.assertEqual((job.status, job.retry_at, job.waits), ("done", None, 0))

    async def test_captions_already_there_do_not_wait_for_quota(self):
        from datetime import datetime, timedelta
        pl._quota_until = datetime.now() + timedelta(minutes=10)
        ran = []

        async def captions(job, options):
            ran.append(job.id)
        pl.STEPS = (("captions", "…", captions),)
        job = self.job("a", ["captions"])
        with patch.object(pl, "_caption_count", AsyncMock(return_value=12)):
            await pl._run_one(job)
        self.assertEqual((ran, job.status), (["a"], "done"))

    async def test_retry_now_ends_the_wait(self):
        async def refused(job, options):
            raise RuntimeError("429")
        pl.STEPS = (("speakers", "…", refused),)
        job = self.job("a", ["speakers"])
        await pl._run_one(job)
        with patch.object(pl, "_ensure_worker"):
            result = await pl.retry_now()
        self.assertEqual(result, {"retried": 1})
        self.assertFalse(pl._waiting_for_quota(job))
        self.assertIsNone(pl._quota_until)

    async def test_the_worker_skips_waiting_jobs_and_runs_the_rest(self):
        done = []

        async def music(job, options):
            done.append(job.id)
        pl.STEPS = (("music", "…", music),)
        from datetime import datetime, timedelta
        waiting = self.job("a", ["music"])
        waiting.retry_at = (datetime.now() + timedelta(minutes=5)).isoformat()
        self.job("b", ["music"])
        task = asyncio.create_task(pl._drain())
        await asyncio.sleep(0.05)
        task.cancel()
        self.assertEqual(done, ["b"])
        self.assertEqual(waiting.status, "queued")


class TimeLeftTest(unittest.IsolatedAsyncioTestCase):
    """The time left is worked out from how long the videos already done took."""

    def setUp(self):
        self.saved = (list(pl._jobs), dict(pl._timings), dict(pl._step_started), pl.STEPS, pl._quota_until)
        pl._jobs.clear(), pl._timings.clear(), pl._step_started.clear()
        pl._quota_until = None
        pl.STEPS = tuple((n, "…", None) for n in ("music", "captions", "speakers", "dubbing", "export"))

    def tearDown(self):
        pl._jobs[:] = self.saved[0]
        pl._timings.clear(), pl._timings.update(self.saved[1])
        pl._step_started.clear(), pl._step_started.update(self.saved[2])
        pl.STEPS, pl._quota_until = self.saved[3], self.saved[4]

    def job(self, name, steps, **more):
        job = pl.PipelineJob(**{"id": name, "project_id": name, "project_name": name, "status": "queued",
                                "steps": steps, "queued_at": "now", **more})
        pl._jobs.append(job)
        return job

    def test_nothing_is_promised_before_a_step_has_been_timed(self):
        self.job("a", ["music", "dubbing"])
        pl._record_timing("music", 60)
        self.assertEqual(pl.estimates(), {"a": None})

    def test_jobs_in_line_add_up_in_the_order_they_run(self):
        pl._record_timing("music", 60), pl._record_timing("music", 100), pl._record_timing("dubbing", 40)
        self.job("a", ["music", "dubbing"]), self.job("b", ["dubbing"])
        self.assertEqual(pl.estimates(), {"a": 120, "b": 160})

    def test_the_running_step_counts_only_what_is_left_of_it(self):
        pl._record_timing("music", 100), pl._record_timing("dubbing", 40)
        job = self.job("a", ["music", "dubbing"], status="running", step="dubbing", percent=50)
        pl._step_started["a"] = 1000.0
        self.assertEqual(pl.estimates(now=1030.0), {"a": 30})      # half done in 30 s: 30 s to go
        job.percent = 0
        self.assertEqual(pl.estimates(now=1010.0), {"a": 30})      # no progress yet: the usual 40, less 10 spent

    def test_a_job_waiting_for_quota_is_left_out(self):
        from datetime import datetime, timedelta
        pl._record_timing("dubbing", 40)
        self.job("a", ["dubbing"], retry_at=(datetime.now() + timedelta(minutes=5)).isoformat())
        self.job("b", ["dubbing"])
        self.assertEqual(pl.estimates(), {"b": 40})

    def test_only_the_newest_timings_are_kept(self):
        for n in range(40):
            pl._record_timing("music", n)
        self.assertEqual(pl._timings["music"], [float(n) for n in range(25, 40)])

    async def test_finished_steps_are_timed(self):
        async def step(job, options):
            await asyncio.sleep(0.01)
        pl.STEPS = (("music", "…", step),)
        job = self.job("a", ["music"])
        pl._options["a"] = pl.PipelineOptions()
        with patch.object(pl, "_persist", AsyncMock()):
            await pl._run_one(job)
        self.assertEqual(len(pl._timings["music"]), 1)
        self.assertNotIn("a", pl._step_started)


class RepairRequestTest(unittest.IsolatedAsyncioTestCase):
    async def test_a_repair_can_be_asked_for_and_runs_before_the_dub(self):
        saved = (list(pl._jobs), dict(pl._options))
        pl._jobs.clear()
        db = SimpleNamespace(execute=AsyncMock(return_value=SimpleNamespace(scalar_one_or_none=lambda: SimpleNamespace(name="Film"))))
        try:
            with patch.object(pl, "_persist", AsyncMock()), patch.object(pl, "_ensure_worker"):
                job = await pl.add_to_pipeline("p", pl.PipelineOptions(captions=False, repair=True, dub=True), db)
            self.assertEqual(job.steps, ["repair", "dubbing"])
            self.assertIn("repair", pl.NEEDS_GEMINI)
        finally:
            pl._jobs[:] = saved[0]
            pl._options.clear(), pl._options.update(saved[1])
