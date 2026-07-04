import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import settings
from backend.database.db import init_db
from backend.api.routes import projects, transcripts, export, settings as settings_route


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # Sync persisted settings (TTS engine, Gemini model, etc.) into the
    # in-memory config singleton so they take effect without requiring the
    # user to visit the Settings page first.
    from backend.database.db import async_session
    from backend.api.routes.settings import _sync_config
    async with async_session() as db:
        await _sync_config(db)

    # Reset voxcpm engine to edge-tts on startup (voxcpm loads 8GB model into RAM)
    if settings.tts_engine == "voxcpm":
        settings.tts_engine = "edge-tts"
        from backend.database.models import AppSetting
        async with async_session() as db:
            row = await db.get(AppSetting, "tts_engine")
            if row:
                row.value = "edge-tts"
            else:
                db.add(AppSetting(key="tts_engine", value="edge-tts"))
            await db.commit()

    yield


app = FastAPI(
    title="AI Video Transcript - Khmer",
    description="AI-powered video transcription to Khmer using Gemini Pro",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes
app.include_router(projects.router, prefix="/api")
app.include_router(transcripts.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(settings_route.router, prefix="/api")

# Serve uploaded video files
os.makedirs(settings.upload_dir, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "ai-transcript-khmer"}
