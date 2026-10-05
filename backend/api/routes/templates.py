"""Series templates: the look of one project, saved to use on the next.

Every episode of a series wants the same caption style, colour filter, logo and frame shape.
Those live on each project, so they were set up again by hand each time — or copied between
the parts of one split video, which does not help with the next episode. A template keeps
them under a name, and is applied to any project in one step.
"""
from __future__ import annotations

import json
import os
import shutil
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.api.routes.project_settings import load_editor_settings, save_editor_settings
from backend.config import settings
from backend.database.db import get_db
from backend.database.models import AppSetting, Project

router = APIRouter(prefix="/templates", tags=["templates"])

STORE_KEY = "series_templates"
# Blur boxes are placed on one particular video, so they are not part of a look
LOOK_KEYS = ("caption_style", "video_filter", "logo", "aspect_ratio")
MAX_TEMPLATES = 50


class TemplateCreate(BaseModel):
    name: str
    project_id: str
    platform: str = ""        # the export platform this series goes to, if it has one


async def _load(db: AsyncSession) -> list[dict]:
    row = await db.get(AppSetting, STORE_KEY)
    try:
        data = json.loads(row.value) if row and row.value else []
    except (TypeError, ValueError):
        data = []
    return [t for t in data if isinstance(t, dict) and t.get("id")]


async def _save(db: AsyncSession, templates: list[dict]) -> None:
    row = await db.get(AppSetting, STORE_KEY)
    value = json.dumps(templates, ensure_ascii=False)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=STORE_KEY, value=value))


def _template_dir(template_id: str) -> str:
    return os.path.join(settings.upload_dir, "templates", template_id)


def _keep_logo(logo: dict, template_id: str) -> dict:
    """The logo image, copied into the template's own folder: the template must still work
    after the project it was made from is deleted."""
    url = str(logo.get("url") or "")
    path = url.lstrip("/")
    if not url or url.startswith("data:") or not os.path.isfile(path):
        return dict(logo)
    os.makedirs(_template_dir(template_id), exist_ok=True)
    dest = os.path.join(_template_dir(template_id), os.path.basename(path))
    shutil.copyfile(path, dest)
    return {**logo, "url": "/" + os.path.relpath(dest, ".").replace("\\", "/")}


def _give_logo(logo: dict, project: Project) -> dict:
    """…and copied again into the project it is applied to, so that project stands on its own."""
    url = str(logo.get("url") or "")
    path = url.lstrip("/")
    if not url or url.startswith("data:") or not os.path.isfile(path):
        return dict(logo)
    dest_dir = os.path.join(settings.upload_dir, project.id, "watermarks")
    os.makedirs(dest_dir, exist_ok=True)
    dest = os.path.join(dest_dir, os.path.basename(path))
    if os.path.abspath(dest) != os.path.abspath(path):
        shutil.copyfile(path, dest)
    return {**logo, "url": "/" + os.path.relpath(dest, ".").replace("\\", "/")}


def _summary(template: dict) -> dict:
    look = template.get("look") or {}
    return {
        "id": template["id"],
        "name": template.get("name") or "Untitled",
        "created_at": template.get("created_at"),
        "platform": template.get("platform") or "",
        "source_project": template.get("source_project") or "",
        "has": [k for k in LOOK_KEYS if look.get(k)],
    }


@router.get("")
@router.get("/")
async def list_templates(db: AsyncSession = Depends(get_db)):
    return [_summary(t) for t in await _load(db)]


@router.post("")
@router.post("/")
async def create_template(body: TemplateCreate, db: AsyncSession = Depends(get_db)):
    """Save a project's caption style, colour filter, logo and frame shape under a name.
    Saving under a name that exists replaces that template."""
    name = body.name.strip()[:80]
    if not name:
        raise HTTPException(400, "Give the template a name")
    project = await db.get(Project, body.project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    current = await load_editor_settings(db, body.project_id)
    look = {k: current[k] for k in LOOK_KEYS if current.get(k)}
    if not look:
        raise HTTPException(400, "This project has no caption style, filter or logo set yet — there is nothing to save.")

    templates = await _load(db)
    existing = next((t for t in templates if (t.get("name") or "").lower() == name.lower()), None)
    template_id = existing["id"] if existing else uuid.uuid4().hex[:12]
    if isinstance(look.get("logo"), dict):
        look["logo"] = _keep_logo(look["logo"], template_id)
    template = {
        "id": template_id, "name": name, "look": look, "platform": body.platform.strip(),
        "source_project": project.name or "", "created_at": datetime.now(timezone.utc).isoformat(),
    }
    templates = [t for t in templates if t["id"] != template_id] + [template]
    await _save(db, templates[-MAX_TEMPLATES:])
    await db.commit()
    return _summary(template)


@router.delete("/{template_id}")
async def delete_template(template_id: str, db: AsyncSession = Depends(get_db)):
    templates = await _load(db)
    if not any(t["id"] == template_id for t in templates):
        raise HTTPException(404, "Template not found")
    await _save(db, [t for t in templates if t["id"] != template_id])
    await db.commit()
    shutil.rmtree(_template_dir(template_id), ignore_errors=True)
    return {"deleted": template_id}


@router.post("/{template_id}/apply/{project_id}")
async def apply_template(template_id: str, project_id: str, db: AsyncSession = Depends(get_db)):
    """Give a project the template's look. Settings the template does not carry are left alone."""
    template = next((t for t in await _load(db) if t["id"] == template_id), None)
    if not template:
        raise HTTPException(404, "Template not found")
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    data = await load_editor_settings(db, project_id)
    applied = []
    for key, value in (template.get("look") or {}).items():
        if key not in LOOK_KEYS or not value:
            continue
        data[key] = _give_logo(value, project) if key == "logo" and isinstance(value, dict) else value
        applied.append(key)
    await save_editor_settings(db, project_id, data)
    await db.commit()
    return {"applied": applied, "platform": template.get("platform") or ""}
