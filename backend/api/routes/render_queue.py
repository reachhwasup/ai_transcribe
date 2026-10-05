"""Render queue: line up several exports and let them render one after another.

The queue is saved whenever it changes and picked up again after a restart; a render that was
in progress when the server stopped starts again from the beginning.
"""
import asyncio
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.routes.export import VideoExportRequest, run_export
from backend.database.db import get_db
from backend.database.models import Project
from backend.services import queue_store

router = APIRouter(prefix="/render-queue", tags=["render-queue"])
STORE_KEY = "render_queue"

MAX_FINISHED_KEPT = 20


class RenderJob(BaseModel):
    id: str
    project_id: str
    project_name: str
    label: str
    status: str  # queued | rendering | done | error | cancelled
    percent: int = 0
    message: str = ""
    filename: Optional[str] = None
    saved_path: Optional[str] = None
    download_url: Optional[str] = None
    error: Optional[str] = None
    queued_at: str
    finished_at: Optional[str] = None


_jobs: list[RenderJob] = []
_requests: dict[str, VideoExportRequest] = {}
_worker: asyncio.Task | None = None
_current: Optional[str] = None
_stopped_by_user: set[str] = set()


async def _persist() -> None:
    await queue_store.save(STORE_KEY, {
        "jobs": [j.model_dump() for j in _jobs],
        "requests": {job_id: r.model_dump() for job_id, r in _requests.items()},
    })


async def restore() -> int:
    """Bring back the queue saved before a restart. Returns how many renders will run again."""
    data = await queue_store.load(STORE_KEY)
    resumed = 0
    for raw in data.get("jobs") or []:
        try:
            job = RenderJob(**raw)
        except Exception:
            continue
        if any(j.id == job.id for j in _jobs):
            continue
        if job.status in ("queued", "rendering"):
            try:
                request = VideoExportRequest(**(data.get("requests") or {})[job.id])
            except Exception:
                job.status, job.error, job.message = "error", "Its settings were lost in a restart", "Failed"
            else:
                job.status, job.percent, job.message = "queued", 0, "Waiting… (picked up after a restart)"
                _requests[job.id] = request
                resumed += 1
        _jobs.append(job)
    if resumed:
        _ensure_worker()
    return resumed


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _trim_finished() -> None:
    finished = [j for j in _jobs if j.status in ("done", "error", "cancelled")]
    for job in finished[:-MAX_FINISHED_KEPT] if len(finished) > MAX_FINISHED_KEPT else []:
        _jobs.remove(job)
        _requests.pop(job.id, None)


async def _run_one(job: RenderJob) -> None:
    global _current
    _current = job.id
    job.status, job.message, job.percent = "rendering", "Starting…", 0
    await _persist()
    try:
        async for evt in run_export(job.project_id, _requests[job.id]):
            kind = evt.get("type")
            if kind == "progress":
                job.percent = int(evt.get("percent") or job.percent)
                job.message = str(evt.get("message") or job.message)
            elif kind == "error":
                raise RuntimeError(evt.get("message") or "Export failed")
            elif kind == "done":
                job.percent = 100
                job.message = str(evt.get("message") or "Finished")
                job.filename = evt.get("filename")
                job.saved_path = evt.get("saved_path")
                job.download_url = evt.get("download_url")
        job.status = "done"
    except asyncio.CancelledError:
        # Stopped by the user, it is over. Stopped because the server is shutting down, it
        # stays "rendering" in the saved queue and is rendered again on the next start.
        if job.id in _stopped_by_user:
            job.status, job.message = "cancelled", "Cancelled"
        raise
    except Exception as e:
        job.status, job.error, job.message = "error", str(e), "Failed"
    finally:
        _current = None
        _stopped_by_user.discard(job.id)
        if job.status != "rendering":
            job.finished_at = _now()
            _requests.pop(job.id, None)
            try:
                await asyncio.shield(_persist())
            except asyncio.CancelledError:
                pass


async def _drain() -> None:
    """Render queued jobs one at a time until none are left."""
    while True:
        nxt = next((j for j in _jobs if j.status == "queued"), None)
        if not nxt:
            return
        await _run_one(nxt)


def _ensure_worker() -> None:
    global _worker
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_drain())


class QueueAdd(BaseModel):
    label: Optional[str] = None
    request: VideoExportRequest


@router.post("/{project_id}", response_model=RenderJob)
async def add_to_queue(project_id: str, body: QueueAdd, db: AsyncSession = Depends(get_db)):
    """Queue an export. It starts as soon as any earlier jobs finish."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    job = RenderJob(
        id=str(uuid.uuid4()),
        project_id=project_id,
        project_name=project.name or "Untitled",
        label=(body.label or body.request.output_filename or project.name or "Export").strip(),
        status="queued",
        message="Waiting…",
        queued_at=_now(),
    )
    _jobs.append(job)
    _requests[job.id] = body.request
    _trim_finished()
    await _persist()
    _ensure_worker()
    return job


@router.get("", response_model=list[RenderJob])
@router.get("/", response_model=list[RenderJob])
async def list_queue():
    return _jobs


@router.delete("/{job_id}")
async def remove_job(job_id: str):
    """Drop a queued job, or stop the one currently rendering."""
    job = next((j for j in _jobs if j.id == job_id), None)
    if not job:
        raise HTTPException(404, "Job not found")

    if job.status == "queued":
        job.status, job.message, job.finished_at = "cancelled", "Cancelled", _now()
        _requests.pop(job.id, None)
    elif job.status == "rendering":
        _stopped_by_user.add(job.id)
        if _worker and not _worker.done():
            _worker.cancel()  # the ffmpeg step finishes, then the job is marked cancelled
        job.status, job.message, job.finished_at = "cancelled", "Cancelled", _now()
        _ensure_worker()
    else:
        _jobs.remove(job)
    await _persist()
    return {"status": "ok", "id": job_id}


@router.delete("")
@router.delete("/")
async def clear_finished():
    """Remove finished, failed and cancelled jobs from the list."""
    before = len(_jobs)
    for job in [j for j in _jobs if j.status in ("done", "error", "cancelled")]:
        _jobs.remove(job)
        _requests.pop(job.id, None)
    await _persist()
    return {"removed": before - len(_jobs)}
