"""Named versions of a project: save the edit, list, rename, delete and restore."""
from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.database.db import get_db
from backend.database.models import Project, ProjectVersion
from backend.services import project_versions

router = APIRouter(prefix="/projects/{project_id}/versions", tags=["versions"])


class VersionName(BaseModel):
    name: str = Field(min_length=1, max_length=200)


def _summary(v: ProjectVersion) -> dict:
    return {
        "id": v.id,
        "name": v.name,
        "auto": bool(v.auto),
        # SQLite hands the time back without its zone; it was stored in UTC
        "created_at": (v.created_at if v.created_at.tzinfo else v.created_at.replace(tzinfo=timezone.utc)).isoformat()
        if v.created_at else None,
        "segment_count": v.segment_count or 0,
        "voiced_count": v.voiced_count or 0,
        "clip_count": v.clip_count or 0,
        "timeline_seconds": v.timeline_seconds or 0.0,
    }


async def _project(db: AsyncSession, project_id: str) -> Project:
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


async def _version(db: AsyncSession, project_id: str, version_id: str) -> ProjectVersion:
    v = await db.get(ProjectVersion, version_id)
    if not v or v.project_id != project_id:
        raise HTTPException(404, "Version not found")
    return v


@router.get("")
@router.get("/")
async def list_versions(project_id: str, db: AsyncSession = Depends(get_db)):
    await _project(db, project_id)
    rows = (await db.execute(
        select(ProjectVersion)
        .where(ProjectVersion.project_id == project_id)
        .order_by(ProjectVersion.created_at.desc())
    )).scalars().all()
    return [_summary(v) for v in rows]


@router.post("")
@router.post("/")
async def create_version(project_id: str, body: VersionName, db: AsyncSession = Depends(get_db)):
    await _project(db, project_id)
    v = await project_versions.save_version(db, project_id, body.name)
    await db.commit()
    return _summary(v)


@router.patch("/{version_id}")
async def rename_version(project_id: str, version_id: str, body: VersionName, db: AsyncSession = Depends(get_db)):
    v = await _version(db, project_id, version_id)
    v.name = body.name.strip()
    v.auto = False  # naming an automatic version means it is worth keeping
    await db.commit()
    return _summary(v)


@router.delete("/{version_id}")
async def delete_version(project_id: str, version_id: str, db: AsyncSession = Depends(get_db)):
    v = await _version(db, project_id, version_id)
    await db.delete(v)
    await db.commit()
    return {"deleted": version_id}


@router.post("/{version_id}/restore")
async def restore_version(project_id: str, version_id: str, db: AsyncSession = Depends(get_db)):
    """Restore a version. The current edit is saved first, so a restore can itself be undone."""
    await _project(db, project_id)
    v = await _version(db, project_id, version_id)
    backup = await project_versions.save_version(db, project_id, f"Before restoring “{v.name}”", auto=True)
    result = await project_versions.restore(db, project_id, v)
    await db.commit()
    return {**result, "restored": _summary(v), "backup": _summary(backup)}
