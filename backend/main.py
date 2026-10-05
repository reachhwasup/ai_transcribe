import os
import asyncio
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import settings
from backend.database.db import init_db
from backend.api.routes import (
    projects, series, transcripts, caption_repair, ai_content, timeline_sync, export, clips, render_queue, pipeline, join, app_update, templates, video_tools, voice_generation, video_parts, text_overlay, versions, assets, project_settings,
    settings as settings_route,
)


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

    from backend.services.video_service import cleanup_stale_temp_files
    cleanup_stale_temp_files(settings.upload_dir)

    # Pick up the work that was queued or in progress when the server last stopped
    from backend.services import queue_store
    queue_store.enable()
    resumed = await pipeline.restore() + await render_queue.restore()
    await join.restore()
    if resumed:
        print(f"[queue] resuming {resumed} job(s) from before the restart", flush=True)

    cleanup_task = asyncio.create_task(pipeline.cleanup_loop())
    join_task = asyncio.create_task(join.watch_loop())
    try:
        yield
    finally:
        for task in (cleanup_task, join_task):
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


app = FastAPI(
    title="AI Video Transcript - Khmer",
    description="AI-powered video transcription to Khmer using Gemini Pro",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    GZipMiddleware,
    minimum_size=1000,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routes — sub-routers with deeper paths must be registered first
app.include_router(transcripts.router, prefix="/api")
app.include_router(caption_repair.router, prefix="/api")
app.include_router(ai_content.router, prefix="/api")
app.include_router(timeline_sync.router, prefix="/api")
app.include_router(clips.router, prefix="/api")
app.include_router(video_tools.router, prefix="/api")
app.include_router(voice_generation.router, prefix="/api")
app.include_router(export.router, prefix="/api")
app.include_router(render_queue.router, prefix="/api")
app.include_router(pipeline.router, prefix="/api")
app.include_router(join.router, prefix="/api")
app.include_router(app_update.router, prefix="/api")
app.include_router(series.router, prefix="/api")
app.include_router(templates.router, prefix="/api")
app.include_router(video_parts.router, prefix="/api")
app.include_router(text_overlay.router, prefix="/api")
app.include_router(versions.router, prefix="/api")
app.include_router(assets.router, prefix="/api")
app.include_router(project_settings.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
app.include_router(settings_route.router, prefix="/api")

# Serve uploaded video files
os.makedirs(settings.upload_dir, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "ai-transcript-khmer"}


# The desktop app has no Vite server in front of it: when the frontend has been built, this
# server hands out the pages too. In development the folder is simply not looked at — the
# browser talks to Vite on :5173, which proxies /api and /uploads here.
FRONTEND_DIST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "dist")


def frontend_file(path: str, dist: str = FRONTEND_DIST) -> str | None:
    """The built file to answer a page request with: the file itself when the path names one,
    otherwise index.html — the app's own router reads the address. None for anything that is
    the API's or the uploads' to answer, and when nothing has been built."""
    index = os.path.join(dist, "index.html")
    if path.startswith(("api/", "uploads/")) or path in ("api", "uploads") or not os.path.isfile(index):
        return None
    wanted = os.path.normpath(os.path.join(dist, path))
    if path and wanted.startswith(dist + os.sep) and os.path.isfile(wanted):
        return wanted
    return index


@app.get("/{path:path}", include_in_schema=False)
async def frontend(path: str):
    from fastapi import HTTPException
    from fastapi.responses import FileResponse

    found = frontend_file(path)
    if not found:
        raise HTTPException(404, "Not found")
    # the page is small and names its scripts by content hash: never cached, so a rebuilt app
    # is picked up at once, while the hashed files under assets/ are cached as usual
    headers = {"Cache-Control": "no-cache"} if found.endswith("index.html") else None
    return FileResponse(found, headers=headers)
