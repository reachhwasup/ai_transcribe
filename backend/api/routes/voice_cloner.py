from __future__ import annotations
import os
import uuid
import shutil
import asyncio
import subprocess
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings as app_config
from backend.database.db import get_db
from backend.database.models import VoiceProfile, AppSetting

router = APIRouter(prefix="/voice-cloner", tags=["voice-cloner"])

ALLOWED_AUDIO_EXTS = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aac", ".webm", ".opus"}


class VoiceProfileOut(BaseModel):
    id: str
    name: str
    prompt_text: str
    audio_url: str
    created_at: str


class TranscribeRequest(BaseModel):
    prompt_text: Optional[str] = None  # if provided, use this; else auto-transcribe


def _profile_out(vp: VoiceProfile) -> VoiceProfileOut:
    rel = os.path.relpath(vp.audio_path, ".")
    return VoiceProfileOut(
        id=vp.id,
        name=vp.name,
        prompt_text=vp.prompt_text or "",
        audio_url="/" + rel.replace("\\", "/"),
        created_at=vp.created_at.isoformat() if vp.created_at else "",
    )


@router.get("/profiles", response_model=List[VoiceProfileOut])
async def list_profiles(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(VoiceProfile).order_by(VoiceProfile.created_at))
    return [_profile_out(vp) for vp in result.scalars().all()]


def _convert_to_wav(src_path: str, wav_path: str) -> None:
    """Convert any audio file to 16kHz mono WAV using ffmpeg."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    result = subprocess.run(
        [ffmpeg, "-y", "-i", src_path, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav_path],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg conversion failed: {result.stderr[-200:]}")


async def _auto_transcribe(wav_path: str) -> str:
    """Transcribe audio using Gemini. Returns the spoken text."""
    api_key = app_config.gemini_api_key
    if not api_key:
        raise RuntimeError("No Gemini API key configured — cannot auto-transcribe")

    def _run():
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(app_config.gemini_model or "gemini-2.5-flash")
        audio_file = genai.upload_file(path=wav_path, mime_type="audio/wav")
        response = model.generate_content(
            [
                "Transcribe exactly what is spoken in this audio clip. "
                "Return only the transcription text, nothing else. "
                "If multiple languages are spoken, transcribe all of them.",
                audio_file,
            ]
        )
        try:
            genai.delete_file(audio_file.name)
        except Exception:
            pass
        return response.text.strip()

    return await asyncio.to_thread(_run)


@router.post("/profiles", response_model=VoiceProfileOut)
async def upload_profile(
    name: str = Form(...),
    prompt_text: str = Form(""),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    if not name.strip():
        raise HTTPException(400, "Name cannot be empty")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in ALLOWED_AUDIO_EXTS:
        raise HTTPException(400, f"Unsupported format. Use: {', '.join(sorted(ALLOWED_AUDIO_EXTS))}")

    profiles_dir = os.path.join(app_config.upload_dir, "voice_profiles")
    os.makedirs(profiles_dir, exist_ok=True)

    file_id = str(uuid.uuid4())
    tmp_path = os.path.join(profiles_dir, f"{file_id}_tmp{ext}")
    with open(tmp_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    wav_path = os.path.join(profiles_dir, f"{file_id}.wav")
    try:
        _convert_to_wav(tmp_path, wav_path)
    except Exception as e:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)
        raise HTTPException(500, f"Audio conversion failed: {e}")
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)

    # Auto-transcribe if no transcript provided
    final_transcript = prompt_text.strip()
    if not final_transcript:
        try:
            print(f"[voice clone] Auto-transcribing {wav_path} …")
            final_transcript = await _auto_transcribe(wav_path)
            print(f"[voice clone] Transcript: {final_transcript!r}")
        except Exception as e:
            print(f"[voice clone] Auto-transcribe failed: {e}")
            final_transcript = ""

    vp = VoiceProfile(
        name=name.strip(),
        audio_path=wav_path,
        prompt_text=final_transcript,
    )
    db.add(vp)
    await db.commit()
    await db.refresh(vp)

    return _profile_out(vp)


@router.patch("/profiles/{profile_id}/transcript", response_model=VoiceProfileOut)
async def update_transcript(
    profile_id: str,
    data: TranscribeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update or auto-transcribe the transcript for an existing voice profile."""
    vp = await db.get(VoiceProfile, profile_id)
    if not vp:
        raise HTTPException(404, "Voice profile not found")

    if data.prompt_text is not None:
        # Manual transcript provided
        vp.prompt_text = data.prompt_text.strip()
    else:
        # Auto-transcribe
        try:
            print(f"[voice clone] Auto-transcribing {vp.audio_path} …")
            vp.prompt_text = await _auto_transcribe(vp.audio_path)
            print(f"[voice clone] Transcript: {vp.prompt_text!r}")
        except Exception as e:
            raise HTTPException(500, f"Auto-transcription failed: {e}")

    await db.commit()
    await db.refresh(vp)

    # Update runtime config if this is the active clone
    if app_config.active_voice_clone_id == profile_id:
        app_config.active_voice_clone_text = vp.prompt_text

    return _profile_out(vp)


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str, db: AsyncSession = Depends(get_db)):
    vp = await db.get(VoiceProfile, profile_id)
    if not vp:
        raise HTTPException(404, "Voice profile not found")

    if app_config.active_voice_clone_id == profile_id:
        app_config.active_voice_clone_id = ""
        app_config.active_voice_clone_path = ""
        app_config.active_voice_clone_text = ""
        row = await db.get(AppSetting, "active_voice_clone_id")
        if row:
            row.value = ""
        else:
            db.add(AppSetting(key="active_voice_clone_id", value=""))

    try:
        if vp.audio_path and os.path.exists(vp.audio_path):
            os.remove(vp.audio_path)
    except Exception:
        pass

    await db.delete(vp)
    await db.commit()
    return {"ok": True}
