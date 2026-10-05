"""Join a series' exported episodes into one long video with chapters.

Asked for by hand, the files already in the folder are joined at once. Asked for along with a
batch of exports, a plan is kept and each group of episodes is joined when its exports have
all arrived — hours later, with no browser open.
"""
import asyncio
import os
import time
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database.db import get_db
from backend.services import join_videos, queue_store

router = APIRouter(prefix="/join", tags=["join"])

MAX_KEPT = 10


class JoinJob(BaseModel):
    id: str
    status: str               # running | done | error | cancelled
    percent: int = 0
    message: str = ""
    name: str
    count: int
    saved_path: Optional[str] = None
    chapter_text: str = ""
    reencoded: bool = False
    error: Optional[str] = None
    started_at: str
    finished_at: Optional[str] = None


class JoinRequest(BaseModel):
    folder: str
    first: int                # the episodes to join, both ends included
    last: int
    name: str = Field(default="", max_length=150)
    series: str = Field(default="", max_length=300)   # only files that carry this name
    chapter_word: str = Field(default="Episode", max_length=40)


class PlanGroup(BaseModel):
    episodes: list[int]
    status: str = "waiting"    # waiting | joining | done | error
    job_id: Optional[str] = None
    saved_path: Optional[str] = None
    error: Optional[str] = None


class JoinPlan(BaseModel):
    """Episodes being exported now, to be joined in these groups once their files arrive."""
    id: str
    folder: str
    series: str = ""           # only files that carry this name are this series'
    name: str = ""
    groups: list[PlanGroup]
    created_at: float          # only files exported after this count as arrived


class PlanRequest(BaseModel):
    folder: str = ""
    series: str = Field(default="", max_length=300)
    name: str = Field(default="", max_length=150)
    groups: list[list[int]] = Field(min_length=1, max_length=200)


_jobs: list[JoinJob] = []
_tasks: dict[str, asyncio.Task] = {}
_plans: list[JoinPlan] = []
STORE_KEY = "join_plans"
PLAN_CHECK_SECONDS = 10
PLAN_GIVEN_UP_AFTER = 72 * 3600      # exports that never came: the plan is dropped


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


async def default_folder(db: AsyncSession, project_id: str) -> str:
    """Where this series' exports were last saved; the Downloads folder when none were."""
    from backend.api.routes import render_queue
    from backend.services.series_memory import family_projects, project_and_memory

    try:
        project, _ = await project_and_memory(db, project_id)
        family = {p.id for p in await family_projects(db, project)}
    except HTTPException:
        family = set()
    for job in reversed(render_queue._jobs):
        if job.project_id in family and job.saved_path and os.path.isdir(os.path.dirname(job.saved_path)):
            return os.path.dirname(job.saved_path)
    return os.path.join(os.path.expanduser("~"), "Downloads")


@router.get("/videos")
async def list_videos(project_id: str = "", folder: str = "", series: str = "", db: AsyncSession = Depends(get_db)):
    """The episode files found in a folder, in episode order; only this series' when its name
    is given and some file carries it."""
    folder = os.path.expanduser(folder.strip()) if folder.strip() else await default_folder(db, project_id)
    found = join_videos.find_videos(folder, series)
    return {"folder": folder, "exists": os.path.isdir(folder),
            "videos": [{"name": v["name"], "episode": v["episode"], "size": v["size"]} for v in found]}


def output_name(name: str, first: int, last: int, folder: str) -> str:
    """"Movie - Episode (1-10).mp4": the series, then the episodes it holds."""
    clean = " ".join("".join(" " if c in '\\/:*?"<>|' else c for c in name).split())
    return os.path.join(folder, f"{clean + ' - ' if clean else ''}Episode ({first}-{last}).mp4")


async def _run(job: JoinJob, paths: list[str], titles: list[str], out_path: str) -> None:
    def progress(percent: int, message: str) -> None:
        job.percent, job.message = percent, message

    try:
        result = await join_videos.join(paths, titles, out_path, progress)
        with open(os.path.splitext(out_path)[0] + " chapters.txt", "w", encoding="utf-8") as f:
            f.write(result["chapter_text"] + "\n")
        job.status, job.percent, job.message = "done", 100, "Finished"
        job.saved_path, job.chapter_text, job.reencoded = out_path, result["chapter_text"], result["reencoded"]
    except asyncio.CancelledError:
        job.status, job.message = "cancelled", "Cancelled"
        if os.path.exists(out_path):
            os.remove(out_path)
    except Exception as exc:
        job.status, job.error, job.message = "error", str(exc) or type(exc).__name__, "Failed"
    finally:
        job.finished_at = _now()
        _tasks.pop(job.id, None)


def _launch(chosen: list[dict], name: str, folder: str, word: str = "Episode") -> JoinJob:
    job = JoinJob(id=str(uuid.uuid4()), status="running", message="Starting…", name=name.strip(),
                  count=len(chosen), started_at=_now())
    _jobs.append(job)
    del _jobs[:-MAX_KEPT]
    out_path = output_name(name, chosen[0]["episode"], chosen[-1]["episode"], folder)
    _tasks[job.id] = asyncio.create_task(
        _run(job, [v["path"] for v in chosen], [f"{word} {v['episode']}" for v in chosen], out_path))
    return job


@router.post("", response_model=JoinJob)
@router.post("/", response_model=JoinJob)
async def start_join(body: JoinRequest):
    if any(j.status == "running" for j in _jobs):
        raise HTTPException(409, "Another join is still running. Wait for it to finish.")
    folder = os.path.expanduser(body.folder.strip())
    chosen = [v for v in join_videos.find_videos(folder, body.series) if body.first <= v["episode"] <= body.last]
    if len(chosen) < 2:
        raise HTTPException(400, "Choose at least two episodes that are in this folder.")
    return _launch(chosen, body.name, folder, body.chapter_word.strip() or "Episode")


# --- joining by itself, once a batch of exports has finished ---

async def _persist_plans() -> None:
    await queue_store.save(STORE_KEY, {"plans": [p.model_dump() for p in _plans]})


async def restore() -> int:
    """Bring back the plans saved before a restart. A join that was cut off is done again."""
    data = await queue_store.load(STORE_KEY)
    for raw in data.get("plans") or []:
        try:
            plan = JoinPlan(**raw)
        except Exception:
            continue
        if any(p.id == plan.id for p in _plans):
            continue
        for group in plan.groups:
            if group.status == "joining":
                group.status, group.job_id = "waiting", None
        _plans.append(plan)
    return len(_plans)


def arrived(plan: JoinPlan, group: PlanGroup) -> list[dict] | None:
    """The group's files, in order, when every one has been exported since the plan was made."""
    found = {v["episode"]: v for v in join_videos.find_videos(plan.folder, plan.series)}
    chosen = [found.get(n) for n in group.episodes]
    if any(v is None or v["modified"] < plan.created_at for v in chosen):
        return None
    return chosen


async def check_plans(now: float | None = None) -> None:
    """Start the next join whose exports have all arrived, and note the ones that finished."""
    now = now or time.time()
    changed = False
    for plan in list(_plans):
        for group in plan.groups:
            if group.status == "joining":
                job = next((j for j in _jobs if j.id == group.job_id), None)
                if job is None or job.status in ("error", "cancelled"):
                    group.status, group.error, changed = "error", (job.error if job else None) or "The join was stopped", True
                elif job.status == "done":
                    group.status, group.saved_path, changed = "done", job.saved_path, True
        finished = all(g.status in ("done", "error") for g in plan.groups)
        if finished or now - plan.created_at > PLAN_GIVEN_UP_AFTER:
            _plans.remove(plan)
            changed = True
    if not any(j.status == "running" for j in _jobs):       # one join at a time
        for plan in _plans:
            group = next((g for g in plan.groups if g.status == "waiting" and arrived(plan, g)), None)
            if group:
                job = _launch(arrived(plan, group), plan.name, plan.folder)
                group.status, group.job_id, changed = "joining", job.id, True
                break
    if changed:
        await _persist_plans()


async def watch_loop() -> None:
    while True:
        await asyncio.sleep(PLAN_CHECK_SECONDS)
        try:
            if _plans:
                await check_plans()
        except Exception as exc:
            print(f"[join] could not check the plans: {type(exc).__name__}: {exc}", flush=True)


@router.post("/plans", response_model=JoinPlan)
async def plan_join(body: PlanRequest):
    """Join these groups of episodes when the exports now being queued have finished."""
    groups = [PlanGroup(episodes=sorted(set(g))) for g in body.groups if len(set(g)) >= 2]
    if not groups:
        raise HTTPException(400, "A joined video needs at least two episodes.")
    folder = os.path.expanduser(body.folder.strip()) if body.folder.strip() else os.path.join(os.path.expanduser("~"), "Downloads")
    plan = JoinPlan(id=str(uuid.uuid4()), folder=folder, series=body.series.strip(), name=body.name.strip(),
                    groups=groups, created_at=time.time())
    _plans.append(plan)
    await _persist_plans()
    return plan


@router.get("/plans", response_model=list[JoinPlan])
async def list_plans():
    return _plans


@router.delete("/plans/{plan_id}")
async def cancel_plan(plan_id: str):
    plan = next((p for p in _plans if p.id == plan_id), None)
    if not plan:
        raise HTTPException(404, "Plan not found")
    _plans.remove(plan)
    await _persist_plans()
    return {"status": "ok"}


@router.get("", response_model=list[JoinJob])
@router.get("/", response_model=list[JoinJob])
async def list_joins():
    return _jobs


@router.delete("/{job_id}")
async def cancel_join(job_id: str):
    job = next((j for j in _jobs if j.id == job_id), None)
    if not job:
        raise HTTPException(404, "Join not found")
    task = _tasks.get(job_id)
    if task and not task.done():
        task.cancel()
    elif job.status != "running":
        _jobs.remove(job)
    return {"status": "ok"}
