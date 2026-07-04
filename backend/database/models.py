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
    duration = Column(Float, default=0.0)
    status = Column(String(50), default="created")  # created, uploading, transcribing, completed, error
    language = Column(String(10), default="km")  # km = Khmer
    bgm_url = Column(String(1000), default="")
    bgm_volume = Column(Float, default=0.3)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    segments = relationship("Segment", back_populates="project", cascade="all, delete-orphan", order_by="Segment.start_time")
    video_clips = relationship("VideoClip", back_populates="project", cascade="all, delete-orphan", order_by="VideoClip.index")


class Segment(Base):
    __tablename__ = "segments"

    id = Column(String, primary_key=True, default=generate_uuid)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    index = Column(Integer, nullable=False)
    start_time = Column(Float, nullable=False)  # seconds
    end_time = Column(Float, nullable=False)  # seconds
    text = Column(Text, default="")
    original_text = Column(Text, default="")  # original transcription before edits
    speaker = Column(String(100), default="")
    voice_profile = Column(String(10), default="female")
    voice_name = Column(String(100), default="")
    emotion = Column(String(50), default="neutral")
    audio_url = Column(String(1000), default="")
    audio_speed = Column(Float, default=1.0)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="segments")


class VideoClip(Base):
    __tablename__ = "video_clips"

    id = Column(String, primary_key=True, default=generate_uuid)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    index = Column(Integer, nullable=False, default=0)
    source_start = Column(Float, nullable=False, default=0.0)
    source_end = Column(Float, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    project = relationship("Project", back_populates="video_clips")


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


class VoiceProfile(Base):
    __tablename__ = "voice_profiles"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String(255), nullable=False)
    audio_path = Column(String(1000), nullable=False)
    prompt_text = Column(Text, default="")
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
