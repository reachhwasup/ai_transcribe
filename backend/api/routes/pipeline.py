"""Pipeline queue: caption, dub and export a project without the browser staying open.

Each job walks one project through the steps it was asked for, and jobs run one after another
— they share one Gemini quota and one machine. The page only has to hand the work over; before
this, a batch was driven from the browser tab and stopped the moment it was closed or reloaded.

When Gemini's quota runs out, a job that still needs it is not failed: it waits, and is tried
again later, while the work that needs no quota (music, dubbing, export) carries on.

The queue is saved whenever it changes and picked up again after a restart. A job that was
running when the server stopped starts over from its first step — which is safe, because each
step skips work that is already done (existing captions are kept, voiced lines are not redone).
"""
import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timedelta
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.routes.export import VideoExportRequest
from backend.database.db import async_session, get_db
from backend.database.models import Project, Segment
from backend.services import queue_store

router = APIRouter(prefix="/pipeline", tags=["pipeline"])
STORE_KEY = "pipeline_queue"

MAX_FINISHED_KEPT = 50
COMPLETED_RETENTION_SECONDS = 120
# Out of quota, a job waits this long before it is tried again: a per-minute limit clears in
# moments, the daily one only at midnight Pacific, and the error does not reliably say which.
QUOTA_WAIT_MINUTES = (15, 30, 60)
NEEDS_GEMINI = ("captions", "speakers", "repair")      # repair asks for shorter wording
IDLE_CHECK_SECONDS = 30


class QuotaWait(Exception):
    """Gemini has no quota left for this step; the job waits and is tried again."""


class PipelineOptions(BaseModel):
    language: str = "km"
    music: bool = False       # split the film's sound into voices and background music
    captions: bool = True     # transcribe and translate, unless the project already has captions
    speakers: bool = False    # work out from the audio who speaks each line that names nobody
    repair: bool = False      # space overlapping lines, shorten the ones that do not fit, drop bad voices
    dub: bool = True          # generate a voice for every line that has none
    export: bool = False      # hand the finished project to the render queue
    # Before exporting, check the project; if anything looks wrong, wait for a person instead
    # of rendering a video that would have to be rendered again.
    hold_for_review: bool = True
    export_request: Optional[VideoExportRequest] = None


class PipelineJob(BaseModel):
    id: str
    project_id: str
    project_name: str
    status: str               # queued | running | review | done | error | cancelled
    step: str = ""            # music | captions | speakers | dubbing | export
    steps: list[str] = []
    percent: int = 0
    message: str = ""
    notes: list[str] = []     # what each finished step did, for the record
    issues: list[dict] = []   # status "review": what was found, waiting for a person to decide
    error: Optional[str] = None
    queued_at: str
    finished_at: Optional[str] = None
    retry_at: Optional[str] = None   # waiting for Gemini quota: not tried again before this
    waits: int = 0                   # how many times it has waited, which sets how long


_jobs: list[PipelineJob] = []
_options: dict[str, PipelineOptions] = {}
_worker: asyncio.Task | None = None
_stopped_by_user: set[str] = set()
_quota_until: datetime | None = None    # nothing that needs Gemini is started before this
# How long each step took on the videos already done, newest last — what the time left is
# worked out from. The episodes of a series are about the same length, so plain seconds do.
_timings: dict[str, list[float]] = {}
_step_started: dict[str, float] = {}
TIMINGS_KEPT = 15


def _record_timing(step: str, seconds: float) -> None:
    kept = _timings.setdefault(step, [])
    kept.append(round(seconds, 1))
    del kept[:-TIMINGS_KEPT]


def _typical(step: str) -> float | None:
    kept = _timings.get(step)
    return sum(kept) / len(kept) if kept else None


def estimates(now: float | None = None) -> dict[str, float | None]:
    """{job id: seconds until that job is done}, for the running job and those in line behind
    it, in the order they will run. None where a step has never been timed yet, and for
    everything behind it; a job waiting for quota is left out — nobody knows when that ends."""
    now = now or time.time()
    out: dict[str, float | None] = {}
    ahead: float | None = 0.0
    line = [j for j in _jobs if j.status == "running"] + [j for j in _jobs if j.status == "queued" and not _waiting_for_quota(j)]
    for job in line:
        steps = [name for name, _, _ in STEPS if name in job.steps]
        if job.status == "running" and job.step in steps:
            steps = steps[steps.index(job.step):]
        for name in steps:
            usual = _typical(name)
            if ahead is None or usual is None:
                ahead = None
                break
            if job.status == "running" and name == job.step:
                spent = max(0.0, now - _step_started.get(job.id, now))
                if job.percent >= 5:
                    ahead += spent * (100 - job.percent) / job.percent      # this video's own pace
                else:
                    ahead += max(usual - spent, usual * 0.1)
            else:
                ahead += usual
        out[job.id] = None if ahead is None else round(ahead)
    return out
_wake: asyncio.Event | None = None


def _waiting_for_quota(job: PipelineJob, now: datetime | None = None) -> bool:
    if not job.retry_at:
        return False
    try:
        return datetime.fromisoformat(job.retry_at) > (now or datetime.now())
    except ValueError:
        return False


def _hold_for_quota(job: PipelineJob, step: str) -> None:
    """Put the job back in the queue to be tried again once quota may be back."""
    global _quota_until
    now = datetime.now()
    if not (_quota_until and _quota_until > now):
        # the first job to find the quota gone sets the wait; the others share it, so a
        # folder of 80 videos does not spend 80 requests finding out the same thing
        job.waits += 1
        minutes = QUOTA_WAIT_MINUTES[min(job.waits, len(QUOTA_WAIT_MINUTES)) - 1]
        _quota_until = now + timedelta(minutes=minutes)
    job.retry_at = _quota_until.isoformat(timespec="seconds")
    job.status, job.step, job.percent = "queued", "", 0
    job.message = f"Gemini's quota is used up — trying again at {_quota_until.strftime('%H:%M')}"
    note = "Waited for Gemini quota before " + {"captions": "captions", "repair": "fixing captions"}.get(step, "identifying speakers")
    if note not in job.notes:
        job.notes.append(note)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


async def _persist() -> None:
    await queue_store.save(STORE_KEY, {
        "jobs": [j.model_dump() for j in _jobs],
        "options": {job_id: o.model_dump() for job_id, o in _options.items()},
        "timings": _timings,
    })


async def cleanup_completed(now: datetime | None = None) -> int:
    """Remove successful work records only; rendered files live in the separate export queue."""
    expired = []
    for job in _jobs:
        if job.status != "done" or not job.finished_at:
            continue
        try:
            finished = datetime.fromisoformat(job.finished_at)
            current = now or datetime.now(finished.tzinfo)
            age = (current - finished).total_seconds()
        except (ValueError, TypeError):
            continue
        if age >= COMPLETED_RETENTION_SECONDS:
            expired.append(job)
    for job in expired:
        _jobs.remove(job)
        _options.pop(job.id, None)
    if expired:
        await _persist()
    return len(expired)


async def cleanup_loop() -> None:
    """Also clean up when no browser is polling the queue."""
    while True:
        await asyncio.sleep(5)
        try:
            await cleanup_completed()
        except Exception as exc:
            print(f"[queue] completed-work cleanup failed: {exc}", flush=True)


async def restore() -> int:
    """Bring back the queue saved before a restart. Returns how many jobs will run again."""
    data = await queue_store.load(STORE_KEY)
    for step, kept in (data.get("timings") or {}).items():
        if isinstance(kept, list) and step not in _timings:
            _timings[step] = [float(x) for x in kept if isinstance(x, (int, float))][-TIMINGS_KEPT:]
    resumed = 0
    for raw in data.get("jobs") or []:
        try:
            job = PipelineJob(**raw)
            options = PipelineOptions(**(data.get("options") or {}).get(job.id, {}))
        except Exception:
            continue
        if any(j.id == job.id for j in _jobs):
            continue
        if job.status in ("queued", "running"):
            job.status, job.step, job.percent = "queued", "", 0
            if not _waiting_for_quota(job):
                job.retry_at = None
                job.message = "Waiting… (picked up after a restart)"
            _options[job.id] = options
            resumed += 1
        elif job.status == "review":
            _options[job.id] = options      # still waiting to be approved
        _jobs.append(job)
    await cleanup_completed()
    if resumed:
        _ensure_worker()
    return resumed


async def stream_events(response) -> AsyncGenerator[dict, None]:
    """The events of one of this app's own streaming endpoints, as dicts."""
    async for chunk in response.body_iterator:
        text = chunk.decode("utf-8", "replace") if isinstance(chunk, (bytes, bytearray)) else str(chunk)
        for line in text.split("\n"):
            if line.startswith("data: "):
                try:
                    yield json.loads(line[6:])
                except ValueError:
                    continue


async def _caption_count(project_id: str) -> int:
    async with async_session() as db:
        return int((await db.execute(
            select(func.count(Segment.id)).where(Segment.project_id == project_id)
        )).scalar() or 0)


async def _step_music(job: PipelineJob, options: PipelineOptions) -> None:
    """Split the film's sound into its voices and its background music.

    A dubbed export plays the new voices over the music alone, and the editor needs the two
    tracks to show them. Done here, a folder of projects is ready to open and to export
    without each one stopping for minutes on first use. It runs on this machine and uses no
    Gemini quota, so it goes first: a day with no quota left still gets the music done."""
    from backend.services.video_service import separate_audio, separation_progress, stems_ready

    async with async_session() as db:
        project = await db.get(Project, job.project_id)
        video_path = project.video_path if project else None
    if not video_path or not os.path.exists(video_path):
        raise RuntimeError("There is no video to take the music from")
    folder = os.path.abspath(os.path.dirname(video_path))
    if stems_ready(folder, video_path):
        job.notes.append("Kept the background music already isolated")
        return
    work = asyncio.ensure_future(asyncio.to_thread(separate_audio, video_path=video_path, project_dir=folder))
    while not work.done():
        # the separation cannot be interrupted part-way; a cancelled job leaves it to finish
        # in the background, and its result is kept for the next time the project needs it
        await asyncio.wait({work}, timeout=2)
        running = separation_progress.get(folder)
        if running:
            job.percent = int(running.get("percent") or job.percent)
            left = running.get("eta_seconds")
            job.message = "Isolating the background music" + (f" — about {max(1, round(left / 60))} min left" if left else "…")
    work.result()
    job.notes.append("Background music isolated")


async def _step_captions(job: PipelineJob, options: PipelineOptions) -> None:
    existing = await _caption_count(job.project_id)
    if existing:
        job.notes.append(f"Kept the {existing} captions already there")
        return
    from backend.api.routes.transcripts import generate_transcript_stream
    from backend.api.schemas import TranscribeRequest

    response = await generate_transcript_stream(job.project_id, TranscribeRequest(language=options.language))
    async for evt in stream_events(response):
        kind = evt.get("type")
        if kind == "progress":
            job.percent = int(evt.get("percent") or job.percent)
            job.message = str(evt.get("message") or job.message)
        elif kind == "error":
            raise RuntimeError(evt.get("message") or "Transcription failed")
        elif kind == "done":
            job.notes.append(f"{evt.get('total_segments', 0)} captions written")
            if evt.get("warning"):
                job.notes.append(str(evt["warning"]))
    if not await _caption_count(job.project_id):
        # out of quota, or a film with no speech; the first waits and tries again
        raise RuntimeError("No captions could be written")


async def _step_speakers(job: PipelineJob, options: PipelineOptions) -> None:
    """Imported subtitles name nobody, so every line would be dubbed in one default voice.
    Captions written by transcription already carry their speakers and are left alone."""
    from backend.api.routes.transcripts import identify_speakers
    from backend.services import gemini_client

    started = time.time()
    try:
        async with async_session() as db:
            result = await identify_speakers(job.project_id, {}, db)
    except Exception as exc:
        if gemini_client.quota_refused_since(started):
            # dubbed now, every line would get the default voice and be dubbed again later
            raise QuotaWait() from exc
        # Knowing who speaks makes the dub better, but without it every line can still be
        # voiced — a day with no Gemini quota left should not stop the dubbing.
        detail = getattr(exc, "detail", None) or str(exc) or type(exc).__name__
        job.notes.append(f"Speakers not identified ({str(detail)[:120]}); lines keep their current voices")
        return
    if not result["asked"]:
        job.notes.append("Every line already has a speaker")
        return
    people = len(result["characters"])
    job.notes.append(f"{result['labelled']} of {result['asked']} lines given a speaker ({people} character{'s' if people != 1 else ''})")


async def _step_dub(job: PipelineJob, options: PipelineOptions) -> None:
    if not await _caption_count(job.project_id):
        raise RuntimeError("There are no captions to dub")
    from backend.api.routes.voice_generation import GenerateSegmentVoiceRequest, generate_voice_segments_stream
    from backend.services.spacing import space_overlaps

    # Lines that overlap would be voiced on top of each other; space them first. A line that
    # moves loses its old voice, so this run voices it again in its new place.
    async with async_session() as db:
        segments = list((await db.execute(
            select(Segment).where(Segment.project_id == job.project_id).order_by(Segment.start_time)
        )).scalars().all())
        moved = space_overlaps(segments)
        for seg in moved:
            if seg.audio_url:
                seg.audio_url, seg.audio_speed = "", 1.0
        if moved:
            await db.commit()
            job.notes.append(f"{len(moved)} overlapping line{'s' if len(moved) != 1 else ''} spaced apart")

    async with async_session() as db:
        response = await generate_voice_segments_stream(
            job.project_id, GenerateSegmentVoiceRequest(skip_existing=True), db
        )
        async for evt in stream_events(response):
            kind = evt.get("type")
            if kind == "progress" and evt.get("total"):
                job.percent = int(100 * (evt.get("completed") or 0) / evt["total"])
                job.message = f"Voiced {evt.get('completed')} of {evt['total']} lines"
            elif kind == "error":
                raise RuntimeError(evt.get("message") or "Dubbing failed")
            elif kind == "done":
                failed, total = int(evt.get("failed") or 0), int(evt.get("total") or 0)
                if total and failed >= total:
                    raise RuntimeError("No line could be voiced. Check the voice engine in Settings.")
                job.notes.append(
                    f"{total - failed} of {total} lines voiced" + (f", {failed} failed" if failed else "")
                )


async def _review(job: PipelineJob) -> list[dict]:
    from backend.services.review import review_project

    async with async_session() as db:
        project = await db.get(Project, job.project_id)
        segments = list((await db.execute(
            select(Segment).where(Segment.project_id == job.project_id).order_by(Segment.start_time)
        )).scalars().all())
        found = review_project(segments, (project.language if project else "") or "km",
                               float((project.duration if project else 0) or 0.0))
    # the list of line ids is for the editor; the queue only needs the headlines
    return [{k: v for k, v in issue.items() if k != "segment_ids"} for issue in found["issues"]]


async def _step_repair(job: PipelineJob, options: PipelineOptions) -> None:
    """Repair timing and length, keeping a version before edits and voices for unchanged lines."""
    from backend.api.routes.transcripts import space_overlapping_lines
    from backend.api.routes.timeline_sync import shorten_to_fit

    async with async_session() as db:
        spaced = await space_overlapping_lines(job.project_id, db)
        job.notes.append(f"{spaced['moved']} overlapping captions spaced apart")
    job.percent, job.message = 30, "Shortening lines that do not fit…"
    async with async_session() as db:
        result = await shorten_to_fit(job.project_id, {}, db)
        changes = [{"id": p["id"], "text": p["after"]} for p in result["proposals"] if p["fits"]]
        if changes:
            applied = await shorten_to_fit(job.project_id, {"apply": changes}, db)
            job.notes.append(f"{applied['applied']} long lines shortened")
        else:
            job.notes.append("No fitting shorter wording to apply")
    # Broken audio references need clearing so skip_existing can regenerate them.
    async with async_session() as db:
        segments = list((await db.execute(select(Segment).where(Segment.project_id == job.project_id))).scalars().all())
        for seg in segments:
            if seg.audio_url and not os.path.exists(seg.audio_url.lstrip("/")):
                seg.audio_url, seg.audio_speed = "", 1.0
        # a caption that flashes by is held for its reading time, in the silence around it
        from backend.api.routes.timeline_sync import _extend_for_reading

        ordered = sorted(segments, key=lambda seg: seg.start_time)
        project = await db.get(Project, job.project_id)
        held = _extend_for_reading(ordered, float(project.duration or 0.0) if project else None)
        if held:
            job.notes.append(f"{len(held)} caption{'s' if len(held) != 1 else ''} held longer, to be read")
        # and so do the voices that are there but cannot be used: silent, cut short, distorted
        from backend.services.dub_check import check_dub

        heard = await asyncio.to_thread(check_dub, sorted(segments, key=lambda seg: seg.start_time))
        bad = {seg.id: seg for kind in ("silent", "cut_short", "distorted") for seg, _ in heard[kind]}
        for seg in bad.values():
            seg.audio_url, seg.audio_speed = "", 1.0
        if bad:
            job.notes.append(f"{len(bad)} bad voice{'s' if len(bad) != 1 else ''} thrown away to be dubbed again")
        await db.commit()
    job.percent = 100


def logo_fields(logo: dict) -> dict:
    """A logo as the editor saves it, as the fields an export asks for."""
    custom = logo.get("position") == "custom"
    return {
        "logo_url": str(logo.get("url") or ""), "logo_enabled": True,
        "logo_position": str(logo.get("position") or "top_right"),
        "logo_scale_pct": float(logo.get("scale_pct") or 15.0),
        "logo_opacity": float(logo.get("opacity") if logo.get("opacity") is not None else 1.0),
        "logo_x_pct": float(logo.get("x_pct") or 0.0) if custom else None,
        "logo_y_pct": float(logo.get("y_pct") or 0.0) if custom else None,
        "logo_start": logo.get("start"), "logo_end": logo.get("end"),
    }


async def _step_export(job: PipelineJob, options: PipelineOptions) -> None:
    from backend.api.routes import render_queue

    request = options.export_request or VideoExportRequest(include_voice=True, include_subtitles=True)
    async with async_session() as db:
        # An export started from the editor carries the caption style with it. One started
        # here has nobody to send it, so it is read from what the project has saved — without
        # this every unattended export came out in the default look.
        if request.subtitle_style is None:
            from backend.api.routes.project_settings import load_editor_settings

            style = (await load_editor_settings(db, job.project_id)).get("caption_style")
            if isinstance(style, dict) and style:
                request = request.model_copy(update={
                    "subtitle_style": style,
                    "subtitle_size_pct": float(style.get("sizePct") or request.subtitle_size_pct),
                    "subtitle_position": str(style.get("position") or request.subtitle_position),
                })
                job.notes.append("Using the project's caption style")
        if request.video_filter is None:
            from backend.api.routes.project_settings import load_editor_settings

            saved = (await load_editor_settings(db, job.project_id)).get("video_filter")
            if isinstance(saved, dict) and saved.get("steps"):
                request = request.model_copy(update={"video_filter": saved["steps"]})
                job.notes.append("Using the project's colour filter")
        if request.logo_url is None:
            # the same for the logo: an export queued for a whole folder says nothing about
            # it, so each video gets the logo it shows in the editor
            from backend.api.routes.project_settings import load_editor_settings

            logo = (await load_editor_settings(db, job.project_id)).get("logo")
            if isinstance(logo, dict) and logo.get("enabled") and logo.get("url"):
                request = request.model_copy(update=logo_fields(logo))
                job.notes.append("Using the project's logo")
        queued = await render_queue.add_to_queue(
            job.project_id, render_queue.QueueAdd(label=job.project_name, request=request), db
        )
    job.notes.append(f"Export added to the render queue ({queued.label})")


STEPS = (("music", "Isolating the background music…", _step_music),
         ("captions", "Writing captions…", _step_captions),
         ("speakers", "Listening for who speaks each line…", _step_speakers),
         ("repair", "Fixing captions…", _step_repair),
         ("dubbing", "Dubbing…", _step_dub),
         ("export", "Queueing the export…", _step_export))


async def _step_with_quota(name: str, step, job: PipelineJob, options: PipelineOptions) -> None:
    """Run a step that asks Gemini. Out of quota it raises QuotaWait instead of failing."""
    global _quota_until
    from backend.services import gemini_client

    if name == "captions" and await _caption_count(job.project_id):
        await step(job, options)      # nothing to ask for: the captions are already there
        return
    if _quota_until and _quota_until > datetime.now():
        raise QuotaWait()
    started = time.time()
    try:
        await step(job, options)
    except QuotaWait:
        raise
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        if gemini_client.quota_refused_since(started) or gemini_client.is_quota_error(detail):
            raise QuotaWait() from exc
        raise
    _quota_until = None


async def _run_one(job: PipelineJob) -> None:
    options = _options[job.id]
    job.status, job.retry_at = "running", None
    await _persist()
    try:
        for name, message, step in STEPS:
            if name not in job.steps:
                continue
            if name == "export" and options.hold_for_review:
                job.issues = await _review(job)
                if job.issues:
                    job.status, job.step, job.percent = "review", "", 100
                    job.message = f"{len(job.issues)} thing{'s' if len(job.issues) != 1 else ''} to check before exporting"
                    return
            job.step, job.message, job.percent = name, message, 0
            began = _step_started[job.id] = time.time()
            if name in NEEDS_GEMINI:
                await _step_with_quota(name, step, job, options)
            else:
                await step(job, options)
            _record_timing(name, time.time() - began)
        job.status, job.step, job.percent, job.message = "done", "", 100, "Finished"
        job.retry_at, job.waits = None, 0
    except QuotaWait:
        _hold_for_quota(job, job.step)
    except asyncio.CancelledError:
        # Stopped by the user, it is over. Stopped because the server is shutting down, it
        # stays "running" in the saved queue and is picked up again on the next start.
        if job.id in _stopped_by_user:
            job.status, job.message = "cancelled", "Cancelled"
        raise
    except HTTPException as e:
        job.status, job.error, job.message = "error", str(e.detail), "Failed"
    except Exception as e:
        job.status, job.error, job.message = "error", str(e) or type(e).__name__, "Failed"
    finally:
        _stopped_by_user.discard(job.id)
        _step_started.pop(job.id, None)
        if job.status == "review":
            # not finished: it waits, with its options, for someone to approve the export
            try:
                await asyncio.shield(_persist())
            except asyncio.CancelledError:
                pass
        elif job.status == "queued":
            # waiting for quota: it keeps its options and its place
            try:
                await asyncio.shield(_persist())
            except asyncio.CancelledError:
                pass
        elif job.status != "running":
            job.finished_at = _now()
            _options.pop(job.id, None)
            try:
                await asyncio.shield(_persist())
            except asyncio.CancelledError:
                pass


async def _drain() -> None:
    global _wake
    if _wake is None:
        _wake = asyncio.Event()
    while True:
        now = datetime.now()
        nxt = next((j for j in _jobs if j.status == "queued" and not _waiting_for_quota(j, now)), None)
        if not nxt:
            if not any(j.status == "queued" for j in _jobs):
                return
            # everything left is waiting for quota: look again shortly, or when asked to
            _wake.clear()
            try:
                await asyncio.wait_for(_wake.wait(), IDLE_CHECK_SECONDS)
            except asyncio.TimeoutError:
                pass
            continue
        try:
            await _run_one(nxt)
        except asyncio.CancelledError:
            # one job was stopped; the worker is restarted for the rest
            return


def _ensure_worker() -> None:
    global _worker
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_drain())
    elif _wake is not None:
        _wake.set()


@router.post("/retry-now")
async def retry_now():
    """Stop waiting for quota and try again — after adding a key, or when the quota is back."""
    global _quota_until
    _quota_until = None
    waiting = [j for j in _jobs if j.status == "queued" and j.retry_at]
    for job in waiting:
        job.retry_at, job.message = None, "Waiting…"
    if waiting:
        await _persist()
    _ensure_worker()
    return {"retried": len(waiting)}


@router.post("/{project_id}", response_model=PipelineJob)
async def add_to_pipeline(project_id: str, body: PipelineOptions, db: AsyncSession = Depends(get_db)):
    """Queue a project; an export-only request can append export to existing work."""
    project = (await db.execute(select(Project).where(Project.id == project_id))).scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")
    active = next((j for j in _jobs if j.project_id == project_id and j.status in ("queued", "running")), None)
    export_only = body.export and not any((body.music, body.captions, body.speakers, body.dub))
    if export_only:
        held = next((j for j in _jobs if j.project_id == project_id and j.status == "review"), None)
        if held:
            return held  # keep its review and previously requested export settings
    if active:
        if export_only and "export" not in active.steps:
            # _run_one holds this same options object while dubbing awaits. Mutate it in
            # place so its later export step sees these settings without restarting work.
            options = _options[active.id]
            options.export = True
            options.export_request = body.export_request
            options.hold_for_review = body.hold_for_review
            active.steps.append("export")
            active.notes.append("Export scheduled after the current work")
            await _persist()
        return active
    # a job held for review is replaced by the new request for the same project
    for held in [j for j in _jobs if j.project_id == project_id and j.status == "review"]:
        _jobs.remove(held)
        _options.pop(held.id, None)
    steps = [name for name, on in (("music", body.music), ("captions", body.captions), ("speakers", body.speakers),
                                   ("repair", body.repair), ("dubbing", body.dub), ("export", body.export)) if on]
    if not steps:
        raise HTTPException(400, "Choose at least one step")
    job = PipelineJob(
        id=str(uuid.uuid4()), project_id=project_id, project_name=project.name or "Untitled",
        status="queued", steps=steps, message="Waiting…", queued_at=_now(),
    )
    _jobs.append(job)
    _options[job.id] = body
    finished = [j for j in _jobs if j.status in ("done", "error", "cancelled")]
    for old in finished[:-MAX_FINISHED_KEPT] if len(finished) > MAX_FINISHED_KEPT else []:
        _jobs.remove(old)
    await _persist()
    _ensure_worker()
    return job


@router.post("/{job_id}/fix", response_model=PipelineJob)
async def fix_for_export(job_id: str):
    """Queue repairs and fresh voices, then review again before the saved export."""
    job = next((j for j in _jobs if j.id == job_id), None)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status in ("queued", "running") and "repair" in job.steps:
        return job
    if job.status != "review":
        raise HTTPException(400, "This job is not waiting for review")
    options = _options.get(job.id)
    if options is None:
        raise HTTPException(409, "The export settings are missing. Queue the export again.")
    options.hold_for_review = True
    job.status, job.steps, job.issues = "queued", ["repair", "dubbing", "export"], []
    job.percent, job.step, job.message = 0, "", "Waiting to fix captions and regenerate affected voices…"
    job.finished_at, job.error = None, None
    await _persist()
    _ensure_worker()
    return job


@router.post("/{job_id}/approve", response_model=PipelineJob)
async def approve_export(job_id: str):
    """Export a job that was held for review, as it is."""
    job = next((j for j in _jobs if j.id == job_id), None)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status != "review":
        raise HTTPException(400, "This job is not waiting for review")
    options = _options.get(job.id) or PipelineOptions(captions=False, dub=False, export=True)
    _options[job.id] = options.model_copy(update={"hold_for_review": False})
    job.status, job.steps, job.issues, job.percent = "queued", ["export"], [], 0
    job.message, job.finished_at = "Waiting…", None
    job.notes.append("Export approved")
    await _persist()
    _ensure_worker()
    return job


@router.get("/estimate")
async def estimate_time_left():
    """Seconds until each running or waiting job is done, from how long finished ones took."""
    return {"jobs": estimates(),
            "waiting_for_quota": sum(1 for j in _jobs if j.status == "queued" and _waiting_for_quota(j))}


@router.get("", response_model=list[PipelineJob])
@router.get("/", response_model=list[PipelineJob])
async def list_pipeline():
    await cleanup_completed()
    return _jobs


@router.delete("/{job_id}")
async def remove_pipeline_job(job_id: str):
    """Drop a waiting job, stop the running one, or clear a finished one from the list."""
    job = next((j for j in _jobs if j.id == job_id), None)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.status in ("queued", "review"):
        job.status, job.message, job.finished_at = "cancelled", "Cancelled", _now()
        job.issues = []
        _options.pop(job.id, None)
    elif job.status == "running":
        _stopped_by_user.add(job.id)
        if _worker and not _worker.done():
            _worker.cancel()
        job.status, job.message, job.finished_at = "cancelled", "Cancelled", _now()
        # let the cancellation land before the next job starts
        await asyncio.sleep(0)
        _ensure_worker()
    else:
        _jobs.remove(job)
    await _persist()
    return {"status": "ok", "id": job_id}


@router.delete("")
@router.delete("/")
async def clear_finished_pipeline():
    before = len(_jobs)
    for job in [j for j in _jobs if j.status in ("done", "error", "cancelled")]:
        _jobs.remove(job)
    await _persist()
    return {"removed": before - len(_jobs)}
