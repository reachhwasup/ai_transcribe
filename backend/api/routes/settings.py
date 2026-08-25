from __future__ import annotations
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings as app_config
from backend.database.db import get_db
from backend.database.models import ApiKey, AppSetting

router = APIRouter(prefix="/settings", tags=["settings"])

AVAILABLE_MODELS = [
    {"id": "gemini-flash-latest", "name": "Gemini Flash Latest", "description": "Always latest stable Flash model (Recommended)"},
    {"id": "gemini-2.5-flash", "name": "Gemini 2.5 Flash", "description": "High accuracy, fast transcription"},
    {"id": "gemini-flash-lite-latest", "name": "Gemini Flash Lite", "description": "Lightweight, fastest responses"},
    {"id": "gemini-2.5-pro", "name": "Gemini 2.5 Pro", "description": "Deep reasoning & large context"},
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
    voxcpm_model_path: str
    voxcpm_inference_steps: int
    available_models: List[dict]
    api_keys: List[ApiKeyOut]


class SettingsUpdate(BaseModel):
    gemini_model: Optional[str] = None
    speaker_voice: Optional[str] = None
    tts_engine: Optional[str] = None
    voxcpm_model_path: Optional[str] = None
    voxcpm_inference_steps: Optional[int] = None


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
    voxcpm_model_path = await _get_setting(db, "voxcpm_model_path", app_config.voxcpm_model_path)

    # If the stored model was deprecated/removed, fall back to default
    valid_ids = [m["id"] for m in AVAILABLE_MODELS]
    if model not in valid_ids:
        model = app_config.gemini_model if app_config.gemini_model in valid_ids else valid_ids[0]
        await _set_setting(db, "gemini_model", model)

    steps_str = await _get_setting(db, "voxcpm_inference_steps", str(app_config.voxcpm_inference_steps))
    try:
        steps = max(1, int(steps_str))
    except ValueError:
        steps = 3

    app_config.gemini_model = model
    app_config.speaker_voice = voice
    app_config.tts_engine = tts_engine
    app_config.voxcpm_model_path = voxcpm_model_path
    app_config.voxcpm_inference_steps = steps

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
        voxcpm_model_path=app_config.voxcpm_model_path,
        voxcpm_inference_steps=app_config.voxcpm_inference_steps,
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
        if data.tts_engine not in ("edge-tts", "voxcpm"):
            raise HTTPException(400, "Invalid TTS engine. Choose 'edge-tts' or 'voxcpm'.")
        await _set_setting(db, "tts_engine", data.tts_engine)

    if data.voxcpm_model_path is not None:
        await _set_setting(db, "voxcpm_model_path", data.voxcpm_model_path.strip())

    if data.voxcpm_inference_steps is not None:
        await _set_setting(db, "voxcpm_inference_steps", str(max(1, data.voxcpm_inference_steps)))

    await db.commit()
    await _sync_config(db)

    return SettingsResponse(
        gemini_model=app_config.gemini_model,
        speaker_voice=app_config.speaker_voice,
        tts_engine=app_config.tts_engine,
        voxcpm_model_path=app_config.voxcpm_model_path,
        voxcpm_inference_steps=app_config.voxcpm_inference_steps,
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


# ==========================================
# Voice Profiles Management & Sample Preview
# ==========================================

class VoiceProfileItem(BaseModel):
    id: str
    name: str
    gender: str = "female"  # "female" | "male" | "child" | "elderly"
    voice_name: str = "km-KH-SreymomNeural"
    engine: str = "edge-tts"  # "edge-tts" | "voxcpm"
    language: str = "km"
    pitch: str = "+0Hz"
    rate: str = "+0%"
    emotion: str = "neutral"
    description: str = ""
    sample_audio_url: Optional[str] = ""
    is_built_in: bool = False
    created_at: Optional[str] = None


class VoiceProfileCreate(BaseModel):
    name: str
    gender: str = "female"
    voice_name: str = "km-KH-SreymomNeural"
    engine: str = "edge-tts"
    language: str = "km"
    pitch: Optional[str] = "+0Hz"
    rate: Optional[str] = "+0%"
    emotion: Optional[str] = "neutral"
    description: Optional[str] = ""
    sample_audio_url: Optional[str] = ""


class VoiceProfileUpdate(BaseModel):
    name: Optional[str] = None
    gender: Optional[str] = None
    voice_name: Optional[str] = None
    engine: Optional[str] = None
    language: Optional[str] = None
    pitch: Optional[str] = None
    rate: Optional[str] = None
    emotion: Optional[str] = None
    description: Optional[str] = None
    sample_audio_url: Optional[str] = None


class VoiceSampleGenerateRequest(BaseModel):
    text: Optional[str] = ""
    voice_name: Optional[str] = "km-KH-SreymomNeural"
    voice_profile: Optional[str] = "female"
    engine: Optional[str] = "edge-tts"
    language: Optional[str] = "km"
    pitch: Optional[str] = "+0Hz"
    rate: Optional[str] = "+0%"
    emotion: Optional[str] = "neutral"
    sample_audio_url: Optional[str] = ""


DEFAULT_SAMPLE_VOICE_PROFILES = [
    {
        "id": "builtin_km_male",
        "name": "Male / Man (បុរស)",
        "gender": "male",
        "voice_name": "km-KH-PisethNeural",
        "engine": "edge-tts",
        "language": "km",
        "pitch": "+0Hz",
        "rate": "+0%",
        "emotion": "neutral",
        "description": "Sample voice of an adult man. Confident, resonant masculine voice for male leads, narrators, and dialogue.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_km_female",
        "name": "Female / Woman (ស្ត្រី)",
        "gender": "female",
        "voice_name": "km-KH-SreymomNeural",
        "engine": "edge-tts",
        "language": "km",
        "pitch": "+0Hz",
        "rate": "+0%",
        "emotion": "neutral",
        "description": "Sample voice of an adult woman. Natural, clear, melodious feminine voice for female leads and conversational dialogue.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_km_child_boy",
        "name": "Child Boy (កុមារា)",
        "gender": "child_boy",
        "voice_name": "km-KH-PisethNeural",
        "engine": "edge-tts",
        "language": "km",
        "pitch": "+7Hz",
        "rate": "+5%",
        "emotion": "cheerful",
        "description": "Sample voice of a young boy. Bright, energetic, playful young boy character voice.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_km_child_girl",
        "name": "Child Girl (កុមារី)",
        "gender": "child_girl",
        "voice_name": "km-KH-SreymomNeural",
        "engine": "edge-tts",
        "language": "km",
        "pitch": "+8Hz",
        "rate": "+4%",
        "emotion": "cheerful",
        "description": "Sample voice of a young girl. Sweet, cute, innocent young girl character voice.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_km_grandpa",
        "name": "Grandpa / Lok Ta (លោកតា)",
        "gender": "grandpa",
        "voice_name": "km-KH-PisethNeural",
        "engine": "edge-tts",
        "language": "km",
        "pitch": "-4Hz",
        "rate": "-6%",
        "emotion": "calm",
        "description": "Sample voice of a grandfather. Deep, wise, gentle elder male tone for grandfathers, masters, and sages.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_km_grandma",
        "name": "Grandma / Lok Yeay (លោកយាយ)",
        "gender": "grandma",
        "voice_name": "km-KH-SreymomNeural",
        "engine": "edge-tts",
        "language": "km",
        "pitch": "-2Hz",
        "rate": "-5%",
        "emotion": "calm",
        "description": "Sample voice of a grandmother. Warm, gentle, venerable elder female tone for grandmothers and matriarchs.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_en_andrew",
        "name": "Andrew Multilingual",
        "gender": "male",
        "voice_name": "en-US-AndrewMultilingualNeural",
        "engine": "edge-tts",
        "language": "en",
        "pitch": "+0Hz",
        "rate": "+0%",
        "emotion": "neutral",
        "description": "Dynamic, high-energy multilingual voice for modern podcasts and video hosts.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_en_ava",
        "name": "Ava Multilingual",
        "gender": "female",
        "voice_name": "en-US-AvaMultilingualNeural",
        "engine": "edge-tts",
        "language": "en",
        "pitch": "+0Hz",
        "rate": "+0%",
        "emotion": "neutral",
        "description": "Smooth, cinematic, and expressive female voice for studio production.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_voxcpm_piseth",
        "name": "VoxCPM2 Heroic Male (ពិសិដ្ឋ)",
        "gender": "male",
        "voice_name": "voxcpm-piseth",
        "engine": "voxcpm",
        "language": "km",
        "pitch": "+0Hz",
        "rate": "+0%",
        "emotion": "neutral",
        "description": "2B Autoregressive generative neural model for male leads, narrators, and heroes.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_voxcpm_sreymom",
        "name": "VoxCPM2 Gentle Female (ស្រីមុំ)",
        "gender": "female",
        "voice_name": "voxcpm-sreymom",
        "engine": "voxcpm",
        "language": "km",
        "pitch": "+0Hz",
        "rate": "+0%",
        "emotion": "neutral",
        "description": "Expressive 2B generative female voice for natural cinematic acting and conversational dialogue.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_voxcpm_lokta",
        "name": "VoxCPM2 Elder Master (លោកតា គ្រូធំ)",
        "gender": "grandpa",
        "voice_name": "voxcpm-lokta",
        "engine": "voxcpm",
        "language": "km",
        "pitch": "-3Hz",
        "rate": "-5%",
        "emotion": "calm",
        "description": "Deep, authoritative 2B neural elder tone for grandfathers, masters, and sages.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
    {
        "id": "builtin_voxcpm_lokyeay",
        "name": "VoxCPM2 Wise Matriarch (លោកយាយ ចាស់ទុំ)",
        "gender": "grandma",
        "voice_name": "voxcpm-lokyeay",
        "engine": "voxcpm",
        "language": "km",
        "pitch": "-2Hz",
        "rate": "-4%",
        "emotion": "calm",
        "description": "Warm, emotional 2B neural elder female voice for story narration and matriarchs.",
        "sample_audio_url": "",
        "is_built_in": True,
    },
]


async def _get_custom_voice_profiles(db: AsyncSession) -> List[dict]:
    raw = await _get_setting(db, "custom_voice_profiles", "[]")
    try:
        import json
        profiles = json.loads(raw)
        if isinstance(profiles, list):
            return profiles
    except Exception:
        pass
    return []


async def _save_custom_voice_profiles(db: AsyncSession, profiles: List[dict]) -> None:
    import json
    await _set_setting(db, "custom_voice_profiles", json.dumps(profiles))
    await db.commit()


@router.get("/voice-profiles", response_model=List[VoiceProfileItem])
async def list_voice_profiles(db: AsyncSession = Depends(get_db)):
    """Return all voice profiles: default built-in samples + user custom profiles."""
    custom = await _get_custom_voice_profiles(db)
    combined = list(DEFAULT_SAMPLE_VOICE_PROFILES) + custom
    return combined


@router.post("/voice-profiles", response_model=VoiceProfileItem)
async def create_voice_profile(data: VoiceProfileCreate, db: AsyncSession = Depends(get_db)):
    """Create a new custom voice profile."""
    from datetime import datetime, timezone
    import uuid

    if not data.name.strip():
        raise HTTPException(400, "Voice profile name cannot be empty")

    new_profile = {
        "id": f"custom_{uuid.uuid4().hex[:10]}",
        "name": data.name.strip(),
        "gender": data.gender or "female",
        "voice_name": data.voice_name or "km-KH-SreymomNeural",
        "engine": data.engine or "edge-tts",
        "language": data.language or "km",
        "pitch": data.pitch or "+0Hz",
        "rate": data.rate or "+0%",
        "emotion": data.emotion or "neutral",
        "description": data.description or "",
        "sample_audio_url": data.sample_audio_url or "",
        "is_built_in": False,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    custom = await _get_custom_voice_profiles(db)
    custom.append(new_profile)
    await _save_custom_voice_profiles(db, custom)

    return new_profile


@router.patch("/voice-profiles/{profile_id}", response_model=VoiceProfileItem)
async def update_voice_profile(profile_id: str, data: VoiceProfileUpdate, db: AsyncSession = Depends(get_db)):
    """Update an existing custom voice profile."""
    custom = await _get_custom_voice_profiles(db)
    target = None
    for p in custom:
        if p["id"] == profile_id:
            target = p
            break

    if not target:
        raise HTTPException(404, "Custom voice profile not found or is a built-in profile")

    if data.name is not None:
        target["name"] = data.name.strip()
    if data.gender is not None:
        target["gender"] = data.gender
    if data.voice_name is not None:
        target["voice_name"] = data.voice_name
    if data.engine is not None:
        target["engine"] = data.engine
    if data.language is not None:
        target["language"] = data.language
    if data.pitch is not None:
        target["pitch"] = data.pitch
    if data.rate is not None:
        target["rate"] = data.rate
    if data.emotion is not None:
        target["emotion"] = data.emotion
    if data.description is not None:
        target["description"] = data.description
    if data.sample_audio_url is not None:
        target["sample_audio_url"] = data.sample_audio_url

    await _save_custom_voice_profiles(db, custom)
    return target


@router.delete("/voice-profiles/{profile_id}")
async def delete_voice_profile(profile_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a custom voice profile."""
    custom = await _get_custom_voice_profiles(db)
    filtered = [p for p in custom if p["id"] != profile_id]

    if len(filtered) == len(custom):
        raise HTTPException(404, "Custom voice profile not found or cannot delete built-in profile")

    await _save_custom_voice_profiles(db, filtered)
    return {"ok": True}


@router.post("/voice-profiles/test-sample")
async def generate_voice_profile_sample(req: VoiceSampleGenerateRequest):
    """Generate a real-time speech sample preview for any voice configuration with instant caching."""
    from backend.services.tts_service import generate_segment_audio
    from backend.config import settings as app_settings
    import os
    import hashlib
    import shutil

    test_text = req.text.strip() if req.text else ""
    if not test_text:
        if req.language == "km":
            test_text = "សួស្តី! នេះជាសំឡេងគំរូ។"
        elif req.language == "zh":
            test_text = "你好！这是语音样本试听。"
        else:
            test_text = "Hello! This is a voice sample preview."

    # Cache check
    cache_dir = os.path.join(app_settings.upload_dir, "tts", "samples_cache")
    os.makedirs(cache_dir, exist_ok=True)
    cache_id = hashlib.md5(
        f"{req.voice_name}:{req.voice_profile}:{req.engine}:{req.pitch}:{req.rate}:{req.emotion}:{req.sample_audio_url}:{test_text}".encode()
    ).hexdigest()

    for ext in [".wav", ".mp3"]:
        cached_file = os.path.join(cache_dir, f"{cache_id}{ext}")
        if os.path.exists(cached_file) and os.path.getsize(cached_file) > 500:
            return {"ok": True, "audio_url": f"/uploads/tts/samples_cache/{cache_id}{ext}", "text": test_text}

    try:
        audio_file = await generate_segment_audio(
            text=test_text,
            voice_profile=req.voice_profile or "female",
            rate=req.rate or "+0%",
            pitch=req.pitch or "+0Hz",
            voice_name=req.voice_name or "",
            language=req.language or "km",
            emotion=req.emotion or "neutral",
            engine=req.engine or "",
            reference_audio=req.sample_audio_url or "",
            timesteps=15,
            apply_fx=True,
        )
        if not audio_file or not os.path.exists(audio_file):
            raise HTTPException(500, "Failed to generate voice sample audio")

        ext = os.path.splitext(audio_file)[1] or ".wav"
        dest_cached = os.path.join(cache_dir, f"{cache_id}{ext}")
        try:
            shutil.copy2(audio_file, dest_cached)
            return {"ok": True, "audio_url": f"/uploads/tts/samples_cache/{cache_id}{ext}", "text": test_text}
        except Exception:
            filename = os.path.basename(audio_file)
            return {"ok": True, "audio_url": f"/uploads/tts/{filename}", "text": test_text}
    except Exception as e:
        raise HTTPException(500, f"Speech generation error: {str(e)}")


@router.post("/voice-profiles/upload-sample")
async def upload_voice_profile_sample_audio(
    file: UploadFile = File(...),
):
    """Upload a custom sample/reference audio file for voice profiles or voice cloning."""
    import uuid
    import os
    import shutil

    if not file.filename:
        raise HTTPException(400, "No file uploaded")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in [".mp3", ".wav", ".m4a", ".ogg", ".aac", ".flac"]:
        raise HTTPException(400, "Audio format must be .mp3, .wav, .m4a, .ogg, or .flac")

    samples_dir = os.path.join(app_config.upload_dir, "tts", "samples")
    os.makedirs(samples_dir, exist_ok=True)

    unique_filename = f"sample_{uuid.uuid4()}{ext}"
    dest_path = os.path.join(samples_dir, unique_filename)

    with open(dest_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    audio_url = f"/uploads/tts/samples/{unique_filename}"
    return {"ok": True, "audio_url": audio_url, "filename": file.filename}
