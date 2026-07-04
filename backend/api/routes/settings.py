from __future__ import annotations
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings as app_config
from backend.database.db import get_db
from backend.database.models import ApiKey, AppSetting

router = APIRouter(prefix="/settings", tags=["settings"])

AVAILABLE_MODELS = [
    {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "description": "Latest, fast and smart (recommended)"},
    {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "description": "Most capable, best quality"},
    {"id": "gemini-2.0-flash", "name": "Gemini 2.0 Flash", "description": "Fast and efficient"},
    {"id": "gemini-2.0-flash-lite", "name": "Gemini 2.0 Flash Lite", "description": "Lightweight, fastest responses"},
]


# --- Pydantic schemas ---

class ApiKeyOut(BaseModel):
    id: str
    label: str
    preview: str
    is_active: bool
    created_at: str


class ApiKeyAdd(BaseModel):
    key: str
    label: Optional[str] = ""


class ApiKeyToggle(BaseModel):
    is_active: bool


class SettingsResponse(BaseModel):
    gemini_model: str
    speaker_voice: str
    tts_engine: str
    available_models: List[dict]
    api_keys: List[ApiKeyOut]


class SettingsUpdate(BaseModel):
    gemini_model: Optional[str] = None
    speaker_voice: Optional[str] = None
    tts_engine: Optional[str] = None


# --- Helpers ---

def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return key[:4] + "****" + key[-4:]


def _key_out(k: ApiKey) -> ApiKeyOut:
    return ApiKeyOut(
        id=k.id,
        label=k.label or "",
        preview=_mask_key(k.key),
        is_active=k.is_active,
        created_at=k.created_at.isoformat() if k.created_at else "",
    )


async def _get_setting(db: AsyncSession, key: str, default: str = "") -> str:
    row = await db.get(AppSetting, key)
    return row.value if row else default


async def _set_setting(db: AsyncSession, key: str, value: str) -> None:
    row = await db.get(AppSetting, key)
    if row:
        row.value = value
    else:
        db.add(AppSetting(key=key, value=value))


async def _sync_config(db: AsyncSession) -> None:
    """Sync DB settings into the runtime config singleton."""
    model = await _get_setting(db, "gemini_model", app_config.gemini_model)
    voice = await _get_setting(db, "speaker_voice", app_config.speaker_voice)
    tts_engine = await _get_setting(db, "tts_engine", app_config.tts_engine)

    # If the stored model was deprecated/removed, fall back to default
    valid_ids = [m["id"] for m in AVAILABLE_MODELS]
    if model not in valid_ids:
        model = app_config.gemini_model if app_config.gemini_model in valid_ids else valid_ids[0]
        await _set_setting(db, "gemini_model", model)

    app_config.gemini_model = model
    app_config.speaker_voice = voice
    app_config.tts_engine = tts_engine

    # Load the first active key into the config for backward compat
    result = await db.execute(
        select(ApiKey).where(ApiKey.is_active == True).order_by(ApiKey.created_at)
    )
    first_key = result.scalars().first()
    if first_key:
        app_config.gemini_api_key = first_key.key


async def _all_keys(db: AsyncSession) -> List[ApiKeyOut]:
    result = await db.execute(select(ApiKey).order_by(ApiKey.created_at))
    return [_key_out(k) for k in result.scalars().all()]


# --- Endpoints ---

@router.get("/", response_model=SettingsResponse)
async def get_settings(db: AsyncSession = Depends(get_db)):
    await _sync_config(db)
    return SettingsResponse(
        gemini_model=app_config.gemini_model,
        speaker_voice=app_config.speaker_voice,
        tts_engine=app_config.tts_engine,
        available_models=AVAILABLE_MODELS,
        api_keys=await _all_keys(db),
    )


@router.patch("/", response_model=SettingsResponse)
async def update_settings(data: SettingsUpdate, db: AsyncSession = Depends(get_db)):
    if data.gemini_model is not None:
        valid_ids = [m["id"] for m in AVAILABLE_MODELS]
        if data.gemini_model not in valid_ids:
            raise HTTPException(400, f"Invalid model. Choose from: {', '.join(valid_ids)}")
        await _set_setting(db, "gemini_model", data.gemini_model)

    if data.speaker_voice is not None:
        if data.speaker_voice not in ("male", "female"):
            raise HTTPException(400, "Invalid voice. Choose 'male' or 'female'.")
        await _set_setting(db, "speaker_voice", data.speaker_voice)

    if data.tts_engine is not None:
        if data.tts_engine != "edge-tts":
            raise HTTPException(400, "Invalid TTS engine. Only 'edge-tts' is supported.")
        await _set_setting(db, "tts_engine", data.tts_engine)

    await db.commit()
    await _sync_config(db)

    return SettingsResponse(
        gemini_model=app_config.gemini_model,
        speaker_voice=app_config.speaker_voice,
        tts_engine=app_config.tts_engine,
        available_models=AVAILABLE_MODELS,
        api_keys=await _all_keys(db),
    )


# --- API Key CRUD ---

@router.post("/api-keys", response_model=ApiKeyOut)
async def add_api_key(data: ApiKeyAdd, db: AsyncSession = Depends(get_db)):
    key_val = data.key.strip()
    if not key_val:
        raise HTTPException(400, "API key cannot be empty")

    # Check for duplicate
    result = await db.execute(select(ApiKey).where(ApiKey.key == key_val))
    if result.scalars().first():
        raise HTTPException(409, "This API key already exists")

    new_key = ApiKey(key=key_val, label=data.label or "")
    db.add(new_key)
    await db.commit()
    await db.refresh(new_key)

    # Update runtime config
    await _sync_config(db)

    return _key_out(new_key)


@router.patch("/api-keys/{key_id}", response_model=ApiKeyOut)
async def toggle_api_key(key_id: str, data: ApiKeyToggle, db: AsyncSession = Depends(get_db)):
    row = await db.get(ApiKey, key_id)
    if not row:
        raise HTTPException(404, "API key not found")
    row.is_active = data.is_active
    await db.commit()
    await db.refresh(row)
    await _sync_config(db)
    return _key_out(row)


@router.delete("/api-keys/{key_id}")
async def delete_api_key(key_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(ApiKey, key_id)
    if not row:
        raise HTTPException(404, "API key not found")
    await db.delete(row)
    await db.commit()
    await _sync_config(db)
    return {"ok": True}
