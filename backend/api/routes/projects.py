from __future__ import annotations
import os
import asyncio
import shutil
import uuid
from pathlib import Path
from typing import List

from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from backend.config import settings
from backend.database.db import get_db, async_session
from backend.database.models import AppSetting, Project, Segment, VideoClip
from backend.api.schemas import (
    ProjectCreate, ProjectUpdate, ProjectResponse, ProjectListResponse,
)
from backend.services.audio_service import get_video_duration
from backend.services.video_service import generate_preview, clear_derived_audio

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
    projects = list(result.scalars().all())

    # Newest first, except that the parts of one split stay together and in part order —
    # otherwise a 12-part video scatters itself across the grid as each part is worked on.
    # A whole split sits where its most recently touched member would have sat.
    # The projects made from one folder stay together the same way, in the folder's order.
    def group_of(p):
        return p.source_project_id or (f"batch:{p.batch_id}" if p.batch_id else p.id)

    newest_in_group: dict[str, object] = {}
    for p in projects:
        root = group_of(p)
        if root not in newest_in_group:
            newest_in_group[root] = p.updated_at

    def sort_key(p):
        # part_index is 0 for the original, so it leads its own parts
        return (newest_in_group[group_of(p)], -(p.part_index or p.batch_index or 0))

    projects.sort(key=sort_key, reverse=True)

    # one query for every saved "could not transcribe these stretches" note
    from backend.database.models import AppSetting

    warn_rows = await db.execute(
        select(AppSetting).where(AppSetting.key.like("transcribe_warning:%"))
    )
    warnings = {r.key.split(":", 1)[1]: r.value for r in warn_rows.scalars().all()}

    response = []
    for p in projects:
        # one row per project: how many captions, and how many already have a voice
        counts = await db.execute(
            select(
                func.count(),
                func.count(Segment.audio_url).filter(func.trim(func.coalesce(Segment.audio_url, "")) != ""),
                func.count().filter(
                    func.trim(func.coalesce(Segment.speaker, "")) == "",
                    func.trim(func.coalesce(Segment.text, "")) != "",
                ),
            ).where(Segment.project_id == p.id)
        )
        seg_count, dubbed, unnamed = counts.one()
        data = ProjectListResponse.model_validate(p)
        data.segment_count = seg_count or 0
        data.dubbed_count = dubbed or 0
        data.unnamed_count = unnamed or 0
        data.transcribe_warning = warnings.get(p.id, "")
        response.append(data)

    return response


@router.post("/", response_model=ProjectResponse, status_code=201)
async def create_project(data: ProjectCreate, db: AsyncSession = Depends(get_db)):
    project = Project(
        id=str(uuid.uuid4()),
        name=data.name,
        description=data.description,
        language=data.language,
        batch_id=data.batch_id[:36],
        batch_name=data.batch_name[:255],
        batch_index=max(0, data.batch_index),
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


class OpenFolderRequest(BaseModel):
    path: str


@router.get("/default-folders")
async def get_default_folders_endpoint():
    """Return common user directories (Downloads, Desktop, Movies, etc.)."""
    home = os.path.expanduser("~")
    downloads = os.path.join(home, "Downloads")
    desktop = os.path.join(home, "Desktop")
    movies = os.path.join(home, "Movies")
    return {
        "home": home,
        "downloads": downloads if os.path.exists(downloads) else home,
        "desktop": desktop if os.path.exists(desktop) else home,
        "movies": movies if os.path.exists(movies) else home,
    }


@router.post("/open-folder")
async def open_folder_in_finder_endpoint(body: OpenFolderRequest):
    """Open a folder or reveal a file in macOS Finder / Windows Explorer."""
    raw_path = os.path.expanduser(body.path.strip())
    if not os.path.exists(raw_path):
        parent = os.path.dirname(raw_path)
        if os.path.exists(parent):
            raw_path = parent
        else:
            raise HTTPException(404, f"Path not found: {raw_path}")

    import sys
    import subprocess
    try:
        if sys.platform == "darwin":
            if os.path.isfile(raw_path):
                subprocess.Popen(["open", "-R", raw_path])
            else:
                subprocess.Popen(["open", raw_path])
        elif sys.platform == "win32":
            if os.path.isfile(raw_path):
                subprocess.Popen(["explorer", f"/select,{raw_path}"])
            else:
                subprocess.Popen(["explorer", raw_path])
        else:
            target = os.path.dirname(raw_path) if os.path.isfile(raw_path) else raw_path
            subprocess.Popen(["xdg-open", target])
        return {"status": "ok", "path": raw_path}
    except Exception as e:
        raise HTTPException(500, f"Could not open path: {e}")


@router.post("/select-folder")
async def select_folder_dialog_endpoint():
    """Open native OS folder chooser dialog and return chosen path."""
    import sys
    import subprocess
    try:
        if sys.platform == "darwin":
            cmd = [
                "osascript", "-e",
                'POSIX path of (choose folder with prompt "Select Destination Folder for Export:")'
            ]
            res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=120)
            if res.returncode == 0 and res.stdout.strip():
                clean_path = res.stdout.strip().rstrip("/")
                return {"path": clean_path}
        elif sys.platform == "win32":
            cmd = [
                "powershell", "-command",
                "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"
            ]
            res = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, text=True, timeout=120)
            if res.returncode == 0 and res.stdout.strip():
                return {"path": res.stdout.strip()}
    except Exception as e:
        print(f"Folder picker error: {e}")
    return {"path": None}


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

    # 1. Clean up entire project upload directory (source video, preview proxy, extracted audio, BGM/vocals, watermarks, exports, demucs stems)
    project_dir = os.path.join(settings.upload_dir, project_id)
    if os.path.isdir(project_dir):
        shutil.rmtree(project_dir, ignore_errors=True)

    # Clean up any external paths referenced directly on the project model
    for p_path in (project.video_path, project.audio_path, project.preview_path):
        if p_path and os.path.exists(p_path):
            try:
                os.remove(p_path)
            except OSError:
                pass

    # 2. Clean up all segment AI TTS voice files in uploads/tts/
    seg_res = await db.execute(select(Segment).where(Segment.project_id == project_id))
    tts_dir = os.path.join(settings.upload_dir, "tts")
    for seg in seg_res.scalars().all():
        if seg.audio_url:
            fpath = seg.audio_url.lstrip("/")
            if os.path.exists(fpath):
                try:
                    os.remove(fpath)
                except OSError:
                    pass
        if os.path.isdir(tts_dir):
            for fname in os.listdir(tts_dir):
                if fname.startswith(seg.id):
                    try:
                        os.remove(os.path.join(tts_dir, fname))
                    except OSError:
                        pass

    await db.delete(project)
    # per-project settings kept by key ("text_overlays:<id>", "assets:<id>", "editor_settings:<id>"…)
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(AppSetting).where(AppSetting.key.like(f"%:{project_id}")))
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

    # Remove old video and stale audio stems if exists
    if project.video_path and os.path.exists(project.video_path):
        try:
            os.remove(project.video_path)
        except OSError:
            pass
    clear_derived_audio(project_dir)
    preview_p = os.path.join(project_dir, "preview.mp4")
    if os.path.exists(preview_p):
        try:
            os.remove(preview_p)
        except OSError:
            pass

    # Get video duration
    duration = get_video_duration(file_path)

    project.video_filename = file.filename
    project.video_path = file_path
    project.duration = duration
    project.status = "uploaded"
    project.preview_path = ""
    project.preview_status = "generating"
    project.timeline_cleared = False

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


@router.delete("/{project_id}/video", response_model=ProjectResponse)
async def remove_project_video(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Remove video and all video clips from a project so user can upload the correct video."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Remove clips
    existing_clips = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id)
    )
    for clip in existing_clips.scalars().all():
        await db.delete(clip)

    # Physically delete source video, preview video proxy, audio file, and audio stems from disk
    project_dir = os.path.join(settings.upload_dir, project_id)
    if os.path.isdir(project_dir):
        for fname in os.listdir(project_dir):
            if fname != "watermarks":
                fpath = os.path.join(project_dir, fname)
                try:
                    if os.path.isfile(fpath):
                        os.remove(fpath)
                    elif os.path.isdir(fpath) and fname == "_demucs_tmp":
                        shutil.rmtree(fpath, ignore_errors=True)
                except OSError:
                    pass

    for p_path in (project.video_path, project.audio_path, project.preview_path):
        if p_path and os.path.exists(p_path):
            try:
                os.remove(p_path)
            except OSError:
                pass

    project.video_path = ""
    project.video_filename = ""
    project.duration = 0.0
    project.preview_path = ""
    project.preview_status = "none"
    project.audio_path = ""

    await db.commit()
    await db.refresh(project)

    result = await db.execute(
        select(Project)
        .options(selectinload(Project.segments), selectinload(Project.video_clips))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    return ProjectResponse.model_validate(project)


@router.post("/{project_id}/watermark")
async def upload_watermark(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Upload a watermark / logo image for a project."""
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    ext = Path(file.filename).suffix.lower()
    allowed = {".png", ".jpg", ".jpeg", ".webp", ".svg"}
    if ext not in allowed:
        raise HTTPException(400, f"Unsupported image file type. Allowed: {', '.join(allowed)}")

    watermark_dir = os.path.join(settings.upload_dir, project_id, "watermarks")
    if os.path.isdir(watermark_dir):
        for old_file in os.listdir(watermark_dir):
            try:
                os.remove(os.path.join(watermark_dir, old_file))
            except OSError:
                pass
    os.makedirs(watermark_dir, exist_ok=True)

    safe_filename = f"logo_{uuid.uuid4()}{ext}"
    file_path = os.path.join(watermark_dir, safe_filename)

    content = await file.read()
    with open(file_path, "wb") as f:
        f.write(content)

    url_path = f"/uploads/{project_id}/watermarks/{safe_filename}"
    return {
        "url": url_path,
        "filename": file.filename,
        "path": file_path,
    }


@router.get("/{project_id}/watermark")
async def get_watermark(project_id: str):
    """The project's current logo/watermark image, if one was uploaded."""
    watermark_dir = os.path.join(settings.upload_dir, project_id, "watermarks")
    if not os.path.isdir(watermark_dir):
        return {"url": None}
    files = [f for f in os.listdir(watermark_dir) if not f.startswith(".")]
    if not files:
        return {"url": None}
    newest = max(files, key=lambda f: os.path.getmtime(os.path.join(watermark_dir, f)))
    return {"url": f"/uploads/{project_id}/watermarks/{newest}"}


@router.delete("/{project_id}/watermark", status_code=204)
async def delete_watermark(project_id: str, db: AsyncSession = Depends(get_db)):
    """Delete all watermark logo files for a project."""
    watermark_dir = os.path.join(settings.upload_dir, project_id, "watermarks")
    if os.path.isdir(watermark_dir):
        shutil.rmtree(watermark_dir, ignore_errors=True)
    return {"ok": True}

