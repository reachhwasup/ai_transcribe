from __future__ import annotations
import os
import asyncio
import shutil
import uuid
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.config import settings
from backend.database.db import get_db, async_session
from backend.database.models import Project, Segment, VideoClip
from backend.api.schemas import (
    ProjectCreate, ProjectUpdate, ProjectResponse, ProjectListResponse,
)
from backend.services.audio_service import get_video_duration
from backend.services.video_service import generate_preview

router = APIRouter(prefix="/projects", tags=["projects"])

ALLOWED_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".flv"}


async def _generate_preview_task(project_id: str, video_path: str):
    """Background task: build the 720p preview proxy and record it on the project.
    Skips writing back if the project's video changed while we were encoding."""
    project_dir = os.path.dirname(video_path)
    out_path = os.path.join(project_dir, "preview.mp4")
    try:
        await asyncio.to_thread(generate_preview, video_path, out_path)
        status, path = "ready", out_path
    except Exception as e:
        print(f"[preview] generation failed for {project_id}: {e}")
        status, path = "error", ""

    async with async_session() as db:
        proj = await db.get(Project, project_id)
        # Only record the result if this is still the same source video.
        if proj and proj.video_path == video_path:
            proj.preview_path = path
            proj.preview_status = status
            await db.commit()


@router.get("/", response_model=List[ProjectListResponse])
async def list_projects(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Project).order_by(Project.updated_at.desc())
    )
    projects = result.scalars().all()

    response = []
    for p in projects:
        count_result = await db.execute(
            select(func.count()).where(Segment.project_id == p.id)
        )
        seg_count = count_result.scalar() or 0
        data = ProjectListResponse.model_validate(p)
        data.segment_count = seg_count
        response.append(data)

    return response


@router.post("/", response_model=ProjectResponse, status_code=201)
async def create_project(data: ProjectCreate, db: AsyncSession = Depends(get_db)):
    project = Project(
        id=str(uuid.uuid4()),
        name=data.name,
        description=data.description,
        language=data.language,
    )
    db.add(project)
    await db.commit()

    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments), selectinload(Project.video_clips))
        .where(Project.id == project.id)
    )
    project = result.scalar_one_or_none()
    return ProjectResponse.model_validate(project)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments), selectinload(Project.video_clips))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Lazily generate a preview proxy for projects that predate this feature
    # (or whose previous attempt errored), so opening them speeds up next time.
    if project.video_path and os.path.exists(project.video_path) and \
            project.preview_status in ("none", "error"):
        project.preview_status = "generating"
        await db.commit()
        await db.refresh(project)
        asyncio.create_task(_generate_preview_task(project_id, project.video_path))

    return ProjectResponse.model_validate(project)


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project(project_id: str, data: ProjectUpdate, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(project, field, value)

    await db.commit()
    await db.refresh(project)

    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments), selectinload(Project.video_clips))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    return ProjectResponse.model_validate(project)


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Clean up entire project upload directory (video, audio, TTS, separated audio, etc.)
    project_dir = os.path.join(settings.upload_dir, project_id)
    if os.path.isdir(project_dir):
        shutil.rmtree(project_dir, ignore_errors=True)

    await db.delete(project)
    await db.commit()


@router.post("/{project_id}/upload", response_model=ProjectResponse)
async def upload_video(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Validate file extension
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}")

    # Save file
    project_dir = os.path.join(settings.upload_dir, project_id)
    os.makedirs(project_dir, exist_ok=True)

    safe_filename = f"{uuid.uuid4()}{ext}"
    file_path = os.path.join(project_dir, safe_filename)

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    # Remove old video if exists
    if project.video_path and os.path.exists(project.video_path):
        os.remove(project.video_path)

    # Get video duration
    duration = get_video_duration(file_path)

    project.video_filename = file.filename
    project.video_path = file_path
    project.duration = duration
    project.status = "uploaded"
    project.preview_path = ""
    project.preview_status = "generating"

    # Remove old video clips and create initial one spanning the full video
    existing_clips = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id)
    )
    for clip in existing_clips.scalars().all():
        await db.delete(clip)

    initial_clip = VideoClip(
        id=str(uuid.uuid4()),
        project_id=project_id,
        index=0,
        source_start=0.0,
        source_end=duration,
    )
    db.add(initial_clip)

    await db.commit()
    await db.refresh(project)

    # Kick off preview-proxy generation in the background so the editor player
    # can load a small file instead of the full-resolution source.
    asyncio.create_task(_generate_preview_task(project_id, file_path))

    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments), selectinload(Project.video_clips))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    return ProjectResponse.model_validate(project)
