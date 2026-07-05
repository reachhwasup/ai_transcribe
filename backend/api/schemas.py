from __future__ import annotations
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class SegmentCreate(BaseModel):
    start_time: float
    end_time: float
    text: str
    speaker: str = ""
    voice_profile: str = "female"
    emotion: str = "neutral"


class SegmentUpdate(BaseModel):
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    text: Optional[str] = None
    speaker: Optional[str] = None
    voice_profile: Optional[str] = None
    voice_name: Optional[str] = None
    emotion: Optional[str] = None
    audio_url: Optional[str] = None
    audio_speed: Optional[float] = None


class SegmentResponse(BaseModel):
    id: str
    project_id: str
    index: int
    start_time: float
    end_time: float
    text: str
    original_text: str
    speaker: str
    voice_profile: str
    voice_name: str
    emotion: str
    audio_url: str
    audio_speed: float
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ProjectCreate(BaseModel):
    name: str
    description: str = ""
    language: str = "km"


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    language: Optional[str] = None


class VideoClipResponse(BaseModel):
    id: str
    project_id: str
    index: int
    source_start: float
    source_end: float
    created_at: datetime

    class Config:
        from_attributes = True


class ProjectResponse(BaseModel):
    id: str
    name: str
    description: str
    video_filename: str
    video_path: str
    duration: float
    status: str
    language: str
    created_at: datetime
    updated_at: datetime
    segments: List[SegmentResponse] = []
    video_clips: List[VideoClipResponse] = []

    class Config:
        from_attributes = True


class ProjectListResponse(BaseModel):
    id: str
    name: str
    description: str
    video_filename: str
    duration: float
    status: str
    language: str
    created_at: datetime
    updated_at: datetime
    segment_count: int = 0

    class Config:
        from_attributes = True


class TranscribeRequest(BaseModel):
    language: str = "km"


class ExportFormat(BaseModel):
    format: str = "srt"  # srt, vtt, txt, json


class SplitClipRequest(BaseModel):
    time: float = 0.0
    source_start: float = 0.0
    source_end: float = 0.0  # playhead time on the timeline
