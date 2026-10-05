import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, Float, Text, DateTime, ForeignKey, Integer, Boolean
from sqlalchemy.orm import relationship
from backend.database.db import Base


def generate_uuid():
    return str(uuid.uuid4())


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String(255), nullable=False)
    description = Column(Text, default="")
    video_filename = Column(String(500), default="")
    video_path = Column(String(1000), default="")
    audio_path = Column(String(1000), default="")
    # Lightweight 720p proxy for the editor preview player (see generate_preview).
    preview_path = Column(String(1000), default="")
    preview_status = Column(String(20), default="none")  # none, generating, ready, error
    duration = Column(Float, default=0.0)
    status = Column(String(50), default="created")  # created, uploading, transcribing, completed, error
    language = Column(String(10), default="km")  # km = Khmer
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    # Set when this project is one part of a longer video that was split on upload.
    # part_offset is where this part begins in the original, so the parts can be joined back.
    source_project_id = Column(String, default="")
    part_index = Column(Integer, default=0)     # 1-based; 0 means "not a part"
    part_count = Column(Integer, default=0)
    part_offset = Column(Float, default=0.0)
    # Set when the last clip is deleted from the timeline. The video file is kept (so undo
    # can bring the clip back), but the clip must not be recreated the next time the project
    # is opened.
    timeline_cleared = Column(Boolean, default=False)
    # Set when this project was made with others from one folder: they are shown together,
    # in the folder's order, the way the parts of a split are.
    batch_id = Column(String, default="")
    batch_name = Column(String(255), default="")
    batch_index = Column(Integer, default=0)    # 1-based place in the folder; 0 means "not in one"

    segments = relationship("Segment", back_populates="project", cascade="all, delete-orphan", order_by="Segment.start_time")
    video_clips = relationship("VideoClip", back_populates="project", cascade="all, delete-orphan", order_by="VideoClip.index")


class Segment(Base):
    __tablename__ = "segments"

    id = Column(String, primary_key=True, default=generate_uuid)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    index = Column(Integer, nullable=False)
    start_time = Column(Float, nullable=False, index=True)  # seconds
    end_time = Column(Float, nullable=False)  # seconds
    text = Column(Text, default="")
    original_text = Column(Text, default="")  # original transcription before edits
    speaker = Column(String(100), default="")
    voice_profile = Column(String(10), default="female")
    voice_name = Column(String(100), default="")
    emotion = Column(String(50), default="neutral")
    # How the line is heard, not how it is spoken: an inner thought, a dream or memory, a
    # phone line. Applied as an effect over the generated voice.
    voice_fx = Column(String(20), default="normal")
    audio_url = Column(String(1000), default="")
    audio_speed = Column(Float, default=1.0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="segments")


class VideoClip(Base):
    __tablename__ = "video_clips"

    id = Column(String, primary_key=True, default=generate_uuid)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    index = Column(Integer, nullable=False, default=0, index=True)
    source_start = Column(Float, nullable=False, default=0.0)
    source_end = Column(Float, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="video_clips")


class ProjectVersion(Base):
    """A named snapshot of a project's edit — captions, voices, cuts and overlays — that can be
    restored later. Voice audio is referenced, not copied; files stay on disk for this."""
    __tablename__ = "project_versions"

    id = Column(String, primary_key=True, default=generate_uuid)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    auto = Column(Boolean, default=False)    # saved by the app before a destructive step
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    segment_count = Column(Integer, default=0)
    voiced_count = Column(Integer, default=0)
    clip_count = Column(Integer, default=0)
    timeline_seconds = Column(Float, default=0.0)
    data = Column(Text, nullable=False)       # JSON: segments, clips, overlays


class ApiKey(Base):
    __tablename__ = "api_keys"

    id = Column(String, primary_key=True, default=generate_uuid)
    label = Column(String(255), default="")
    key = Column(String(500), nullable=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class AppSetting(Base):
    __tablename__ = "app_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, default="")


