from __future__ import annotations
import os
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Depends, UploadFile, File
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings as app_config
from backend.database.db import get_db
from backend.database.models import ApiKey, AppSetting

router = APIRouter(prefix="/settings", tags=["settings"])


AVAILABLE_MODELS = [
    {"id": "gemini-3.8-flash", "name": "Gemini 3.8 Flash", "description": "Newest and fastest — best transcription quality (Recommended)"},
    {"id": "gemini-3.7-flash", "name": "Gemini 3.7 Flash", "description": "Previous generation, slower"},
    {"id": "gemini-3.6-flash", "name": "Gemini 3.6 Flash", "description": "Multimodal speech recognition"},
    {"id": "gemini-3.5-flash", "name": "Gemini 3.5 Flash", "description": "High accuracy, fast transcription"},
    {"id": "gemini-3.5-flash-lite", "name": "Gemini 3.5 Flash Lite", "description": "Ultra-fast, lower quality — more script mix-ups"},
]


# --- Pydantic schemas ---

class ApiKeyOut(BaseModel):
    id: str
    label: str
    preview: str
    is_active: bool
    created_at: str
    # False only for a blank key. Gemini accepts several key formats, so the shape of a key
    # says nothing about whether it works — only a real request does.
    usable: bool = True


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
    separation_pace: str = "balanced"
    available_models: List[dict]
    api_keys: List[ApiKeyOut]


class SettingsUpdate(BaseModel):
    gemini_model: Optional[str] = None
    speaker_voice: Optional[str] = None
    tts_engine: Optional[str] = None
    voxcpm_model_path: Optional[str] = None
    voxcpm_inference_steps: Optional[int] = None
    separation_pace: Optional[str] = None


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
        usable=bool((k.key or "").strip()),
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
    pace = await _get_setting(db, "separation_pace", app_config.separation_pace)
    app_config.separation_pace = pace if pace in ("fast", "balanced", "cool") else "balanced"

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
        separation_pace=app_config.separation_pace,
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

    if data.separation_pace is not None:
        if data.separation_pace not in ("fast", "balanced", "cool"):
            raise HTTPException(400, "Invalid pace. Choose 'fast', 'balanced' or 'cool'.")
        await _set_setting(db, "separation_pace", data.separation_pace)

    await db.commit()
    await _sync_config(db)

    return SettingsResponse(
        gemini_model=app_config.gemini_model,
        speaker_voice=app_config.speaker_voice,
        tts_engine=app_config.tts_engine,
        voxcpm_model_path=app_config.voxcpm_model_path,
        voxcpm_inference_steps=app_config.voxcpm_inference_steps,
        separation_pace=app_config.separation_pace,
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
    eq: Optional[dict] = None
    group_id: str = ""
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
    group_id: str = ""
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
    group_id: Optional[str] = None
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


class PronunciationEntry(BaseModel):
    word: str
    say_as: str
    # when this word's spoken form was last set; a dub made before it still says it the old way
    changed_at: float = 0.0


@router.get("/pronunciations", response_model=List[PronunciationEntry])
async def list_pronunciations(db: AsyncSession = Depends(get_db)):
    """Words the voice engine should pronounce a specific way (captions are unaffected)."""
    import json

    raw = await _get_setting(db, "pronunciations", "[]")
    try:
        entries = json.loads(raw)
    except ValueError:
        entries = []
    return [PronunciationEntry(**e) for e in entries if e.get("word") and e.get("say_as")]


@router.put("/pronunciations", response_model=List[PronunciationEntry])
async def save_pronunciations(
    entries: List[PronunciationEntry],
    db: AsyncSession = Depends(get_db),
):
    import json

    from backend.services.tts_service import set_pronunciations

    import time

    try:
        before = {e.get("word"): e for e in json.loads(await _get_setting(db, "pronunciations", "[]"))}
    except ValueError:
        before = {}
    cleaned = []
    for e in entries:
        word, say = e.word.strip(), e.say_as.strip()
        if not word or not say:
            continue
        old = before.get(word)
        same = bool(old) and old.get("say_as") == say
        # an entry that was already there before stale dubs were tracked has no time: unknown
        cleaned.append({"word": word, "say_as": say, "changed_at": float(old.get("changed_at") or 0.0) if same else time.time()})
    await _set_setting(db, "pronunciations", json.dumps(cleaned, ensure_ascii=False))
    await db.commit()
    set_pronunciations(cleaned)  # take effect without a restart
    return [PronunciationEntry(**e) for e in cleaned]


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

    await _validate_voice_group(db, data.group_id)
    new_profile = {
        "group_id": data.group_id,
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

    if data.group_id is not None:
        await _validate_voice_group(db, data.group_id)
        target["group_id"] = data.group_id
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
        old_sample = target.get("sample_audio_url")
        if old_sample and old_sample != data.sample_audio_url:
            s_path = old_sample.lstrip("/")
            if os.path.exists(s_path):
                try:
                    os.remove(s_path)
                except OSError:
                    pass
        target["sample_audio_url"] = data.sample_audio_url

    await _save_custom_voice_profiles(db, custom)
    return target


@router.delete("/voice-profiles/{profile_id}")
async def delete_voice_profile(profile_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a custom voice profile and its sample audio file."""
    custom = await _get_custom_voice_profiles(db)
    target = next((p for p in custom if p["id"] == profile_id), None)
    if not target:
        raise HTTPException(404, "Custom voice profile not found or cannot delete built-in profile")

    if target.get("sample_audio_url"):
        s_path = target["sample_audio_url"].lstrip("/")
        if os.path.exists(s_path):
            try:
                os.remove(s_path)
            except OSError:
                pass

    filtered = [p for p in custom if p["id"] != profile_id]
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


class VoiceGroupCreate(BaseModel):
    name: str


async def _get_voice_groups(db: AsyncSession) -> List[dict]:
    import json
    return json.loads(await _get_setting(db, "voice_groups", "[]"))


async def _validate_voice_group(db: AsyncSession, group_id: str) -> None:
    if group_id and not any(g["id"] == group_id for g in await _get_voice_groups(db)):
        raise HTTPException(400, "Voice group not found")


@router.get("/voice-groups")
async def list_voice_groups(db: AsyncSession = Depends(get_db)):
    return await _get_voice_groups(db)


@router.post("/voice-groups")
async def create_voice_group(data: VoiceGroupCreate, db: AsyncSession = Depends(get_db)):
    import json
    import uuid
    name = data.name.strip()
    if not name or len(name) > 80:
        raise HTTPException(400, "Enter a group name of 1–80 characters")
    groups = await _get_voice_groups(db)
    if any(g["name"].casefold() == name.casefold() for g in groups):
        raise HTTPException(409, "A voice group with that name already exists")
    group = {"id": f"group_{uuid.uuid4().hex[:12]}", "name": name}
    groups.append(group)
    await _set_setting(db, "voice_groups", json.dumps(groups))
    await db.commit()
    return group


async def _stale_dubs(db: AsyncSession) -> list[tuple]:
    """Dubbed lines that say a dictionary word the old way: the line has the word, and its voice
    file was made before the word's spoken form was last set. [(segment, word)]."""
    import json
    import os

    from backend.database.models import Segment
    from backend.services.tts_service import says_word

    try:
        entries = json.loads(await _get_setting(db, "pronunciations", "[]"))
    except ValueError:
        entries = []
    entries = [e for e in entries if e.get("word") and float(e.get("changed_at") or 0) > 0]
    if not entries:
        return []
    segments = (await db.execute(select(Segment).where(Segment.audio_url != "", Segment.audio_url.is_not(None)))).scalars().all()
    found = []
    for seg in segments:
        hits = [e for e in entries if says_word(seg.text or "", e["word"])]
        if not hits:
            continue
        try:
            made = os.path.getmtime((seg.audio_url or "").lstrip("/"))
        except OSError:
            continue
        newest = max(hits, key=lambda e: float(e["changed_at"]))
        if made < float(newest["changed_at"]):
            found.append((seg, newest["word"]))
    return found


@router.get("/pronunciations/stale")
async def stale_pronunciations(db: AsyncSession = Depends(get_db)):
    """How many dubbed lines still say each word the way it was said before."""
    words: dict[str, int] = {}
    projects = set()
    for seg, word in await _stale_dubs(db):
        words[word] = words.get(word, 0) + 1
        projects.add(seg.project_id)
    return {"lines": sum(words.values()), "projects": len(projects), "words": words}


@router.post("/pronunciations/redub")
async def redub_stale_pronunciations(db: AsyncSession = Depends(get_db)):
    """Clear those dubs and queue their projects for dubbing, which voices only what is missing."""
    from backend.api.routes import pipeline
    from backend.api.routes.voice_generation import _active_voice_streams

    stale = await _stale_dubs(db)
    busy = {seg.project_id for seg, _ in stale if seg.project_id in _active_voice_streams}
    cleared: dict[str, int] = {}
    for seg, _ in stale:
        if seg.project_id in busy:
            continue
        seg.audio_url, seg.audio_speed = "", 1.0      # the file stays, for undo
        cleared[seg.project_id] = cleared.get(seg.project_id, 0) + 1
    await db.commit()
    queued = 0
    for project_id in cleared:
        try:
            await pipeline.add_to_pipeline(project_id, pipeline.PipelineOptions(captions=False, dub=True), db)
            queued += 1
        except HTTPException:
            pass
    return {"lines": sum(cleared.values()), "projects": len(cleared), "queued": queued, "busy": len(busy)}


class ListenRequest(BaseModel):
    text: str
    voice_profile: str = "female"


@router.post("/pronunciations/listen")
async def listen_to_pronunciation(body: ListenRequest):
    """The text spoken as a dub would say it, dictionary applied — to check an entry by ear."""
    import os

    from fastapi.responses import FileResponse
    from starlette.background import BackgroundTask

    from backend.services.tts_service import generate_segment_audio

    text = body.text.strip()[:200]
    if not text:
        raise HTTPException(400, "Nothing to say")
    try:
        path = await generate_segment_audio(text=text, voice_profile=body.voice_profile, language="km", apply_fx=False)
    except Exception as exc:
        raise HTTPException(502, f"The voice could not be made: {exc}") from exc
    media = "audio/wav" if path.lower().endswith(".wav") else "audio/mpeg"
    return FileResponse(path, media_type=media, background=BackgroundTask(lambda: os.path.exists(path) and os.remove(path)))
