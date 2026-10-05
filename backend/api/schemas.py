from __future__ import annotations
from datetime import datetime
from typing import Optional, List
from pydantic import BaseModel


class SegmentUpdate(BaseModel):
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    text: Optional[str] = None
    speaker: Optional[str] = None
    voice_profile: Optional[str] = None
    voice_name: Optional[str] = None
    emotion: Optional[str] = None
    voice_fx: Optional[str] = None
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
    voice_fx: str = "normal"
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
    # one of several projects made together from a folder
    batch_id: str = ""
    batch_name: str = ""
    batch_index: int = 0


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
    preview_status: str = "none"
    duration: float
    status: str
    language: str
    created_at: datetime
    updated_at: datetime
    source_project_id: str = ""
    part_index: int = 0
    part_count: int = 0
    part_offset: float = 0.0
    batch_id: Optional[str] = ""
    batch_name: Optional[str] = ""
    batch_index: Optional[int] = 0
    # every clip was deleted from the timeline; the video file is kept only for undo
    timeline_cleared: Optional[bool] = False
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
    source_project_id: str = ""
    part_index: int = 0
    part_count: int = 0
    batch_id: Optional[str] = ""
    batch_name: Optional[str] = ""
    batch_index: Optional[int] = 0
    segment_count: int = 0
    dubbed_count: int = 0      # captions that already have a generated voice
    unnamed_count: int = 0     # spoken captions that name no speaker — all dubbed in one default voice
    transcribe_warning: str = ""   # stretches the last transcription could not cover

    class Config:
        from_attributes = True


class TranscribeRequest(BaseModel):
    language: str = "km"


class SplitClipRequest(BaseModel):
    time: float = 0.0
    source_start: float = 0.0
    source_end: float = 0.0  # playhead time on the timeline
