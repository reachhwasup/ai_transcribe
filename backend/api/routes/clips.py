"""Non-destructive timeline clip editing (split, trim, reorder, append)."""
import asyncio
import os
import shutil
import uuid
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional, List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database.db import get_db
from backend.database.models import Project, Segment, VideoClip
from backend.api.schemas import SplitClipRequest, VideoClipResponse, SegmentResponse

router = APIRouter(prefix="/projects/{project_id}/export", tags=["export"])


# --- Video Clips (non-destructive timeline editing) ---
# NOTE: These must be defined before the /{format} catch-all route

@router.get("/clips", response_model=List[VideoClipResponse])
async def get_clips(
    project_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get all video clips for a project, ordered by index. Auto-creates initial clip if needed."""
    import uuid as _uuid

    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    clips = list(result.scalars().all())

    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()

    # Auto-create initial clip for existing projects that have a video but no clips — unless
    # the clips are gone because the user deleted them, or the video they removed from the
    # timeline comes straight back on the next reload.
    if not clips:
        if project and project.video_path and project.duration and project.duration > 0 and not project.timeline_cleared:
            initial_clip = VideoClip(
                id=str(_uuid.uuid4()),
                project_id=project_id,
                index=0,
                source_start=0.0,
                source_end=project.duration,
            )
            db.add(initial_clip)
            await db.commit()
            clips = [initial_clip]
    elif clips:
        actual_dur = project.duration if (project and project.duration and project.duration > 0) else 0.0
        if project and project.video_path and os.path.exists(project.video_path):
            try:
                from backend.services.video_service import get_duration_ffprobe
                probe_dur = get_duration_ffprobe(project.video_path)
                if probe_dur > 0:
                    actual_dur = probe_dur
                    if project.duration != probe_dur:
                        project.duration = probe_dur
            except Exception:
                pass

        modified = False
        for i, c in enumerate(clips):
            if c.source_end <= c.source_start:
                c.source_end = round(c.source_start + 5.0, 2)
                modified = True
            if actual_dur > 0 and c.source_end > actual_dur + 0.1:
                c.source_end = round(actual_dur, 2)
                modified = True

        if modified:
            await db.commit()

    return [VideoClipResponse.model_validate(c) for c in clips]


@router.post("/clips/split", response_model=List[VideoClipResponse])
async def split_clip_at_playhead(
    project_id: str,
    body: SplitClipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Split the clip at the playhead timeline position into two clips."""
    import uuid as _uuid

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Get all clips ordered by index
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    clips = list(result.scalars().all())

    if not clips:
        raise HTTPException(400, "No video clips found. Upload a video first.")

    playhead_time = body.time

    # Find which clip contains this source time position
    target_clip = None
    for clip in clips:
        if clip.source_start < playhead_time < clip.source_end:
            target_clip = clip
            break

    if not target_clip:
        raise HTTPException(400, "Playhead is not inside any clip")

    # Split at the source position directly
    source_split_point = playhead_time

    # Create two new clips from the target
    clip1 = VideoClip(
        id=str(_uuid.uuid4()),
        project_id=project_id,
        index=target_clip.index,
        source_start=target_clip.source_start,
        source_end=source_split_point,
    )
    clip2 = VideoClip(
        id=str(_uuid.uuid4()),
        project_id=project_id,
        index=target_clip.index + 1,
        source_start=source_split_point,
        source_end=target_clip.source_end,
    )

    # Delete the original clip
    await db.delete(target_clip)
    await db.flush()

    # Re-index all clips after the split point
    remaining = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    existing = list(remaining.scalars().all())

    # Insert new clips
    db.add(clip1)
    db.add(clip2)

    # Shift indices of clips that come after
    for c in existing:
        if c.index >= clip2.index:
            c.index += 1

    await db.commit()

    # Re-fetch all clips with correct ordering
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    all_clips = list(result.scalars().all())

    # Normalize indices to be sequential
    for i, c in enumerate(all_clips):
        c.index = i
    await db.commit()

    return [VideoClipResponse.model_validate(c) for c in all_clips]


@router.delete("/clips/{clip_id}")
async def delete_clip(
    project_id: str,
    clip_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Delete a video clip (non-destructive). The source video is kept intact."""
    result = await db.execute(
        select(VideoClip).where(VideoClip.id == clip_id, VideoClip.project_id == project_id)
    )
    clip = result.scalar_one_or_none()
    if not clip:
        raise HTTPException(404, "Clip not found")

    await db.delete(clip)
    await db.commit()

    # Re-index remaining clips
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    remaining_clips = list(result.scalars().all())
    for i, c in enumerate(remaining_clips):
        c.index = i
    if not remaining_clips:
        project = await db.get(Project, project_id)
        if project:
            project.timeline_cleared = True
    await db.commit()

    return {
        "status": "ok",
        "remaining_clips": len(remaining_clips),
        "video_rebuilt": False,
        "clips": [VideoClipResponse.model_validate(c) for c in remaining_clips],
    }


class UpdateClipRequest(BaseModel):
    source_start: Optional[float] = None
    source_end: Optional[float] = None


@router.patch("/clips/{clip_id}", response_model=VideoClipResponse)
async def update_clip(
    project_id: str,
    clip_id: str,
    body: UpdateClipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Update a clip's source boundaries."""
    result = await db.execute(
        select(VideoClip).where(VideoClip.id == clip_id, VideoClip.project_id == project_id)
    )
    clip = result.scalar_one_or_none()
    if not clip:
        raise HTTPException(404, "Clip not found")

    if body.source_start is not None and body.source_end is not None:
        result_proj = await db.execute(select(Project).where(Project.id == project_id))
        project = result_proj.scalar_one_or_none()
        if not project:
            raise HTTPException(404, "Project not found")

        new_start = max(0.0, body.source_start)
        new_end = min(body.source_end, project.duration or body.source_end)
        if new_end - new_start < 0.1:
            raise HTTPException(400, "Clip must be at least 0.1s long")

        clip.source_start = new_start
        clip.source_end = new_end

    await db.commit()
    return VideoClipResponse.model_validate(clip)


@router.put("/clips/restore", response_model=List[VideoClipResponse])
async def restore_clips(
    project_id: str,
    clips_data: List[SplitClipRequest],
    db: AsyncSession = Depends(get_db),
):
    """Restore clips from a snapshot (for undo/redo). Replaces all clips with the provided list."""
    import uuid as _uuid

    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    # Delete all existing clips
    existing = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id)
    )
    for c in existing.scalars().all():
        await db.delete(c)
    await db.flush()

    project.timeline_cleared = not clips_data

    # Create new clips from snapshot
    for i, clip_data in enumerate(clips_data):
        clip = VideoClip(
            id=str(_uuid.uuid4()),
            project_id=project_id,
            index=i,
            source_start=clip_data.source_start,
            source_end=clip_data.source_end,
        )
        db.add(clip)

    await db.commit()

    # Re-fetch and return
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    return [VideoClipResponse.model_validate(c) for c in result.scalars().all()]


class ReorderClipsRequest(BaseModel):
    clip_ids: List[str]


@router.put("/clips/reorder", response_model=List[VideoClipResponse])
async def reorder_clips(
    project_id: str,
    body: ReorderClipsRequest,
    db: AsyncSession = Depends(get_db),
):
    """Reorder video clips by updating their index order."""
    result = await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id)
    )
    clips_by_id = {c.id: c for c in result.scalars().all()}

    for new_idx, clip_id in enumerate(body.clip_ids):
        if clip_id in clips_by_id:
            clips_by_id[clip_id].index = new_idx

    await db.commit()

    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    all_clips = list(result.scalars().all())
    return [VideoClipResponse.model_validate(c) for c in all_clips]


class AddClipRequest(BaseModel):
    source_start: float = 0.0
    source_end: float
    index: Optional[int] = None


@router.post("/clips/add", response_model=List[VideoClipResponse])
async def add_clip_to_timeline(
    project_id: str,
    body: AddClipRequest,
    db: AsyncSession = Depends(get_db),
):
    """Add a new video clip slice to the timeline."""
    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    clips = list(result.scalars().all())

    next_idx = body.index if body.index is not None else len(clips)
    new_clip = VideoClip(
        id=str(uuid.uuid4()),
        project_id=project_id,
        index=next_idx,
        source_start=max(0.0, body.source_start),
        source_end=max(body.source_start + 0.1, body.source_end),
    )
    db.add(new_clip)
    await db.commit()

    # Refresh and return
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    return [VideoClipResponse.model_validate(c) for c in result.scalars().all()]


@router.post("/clips/append-file", response_model=List[VideoClipResponse])
async def append_video_file_to_timeline(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """Upload a new video file and append it seamlessly to the project master video and timeline."""
    proj_result = await db.execute(select(Project).where(Project.id == project_id))
    project = proj_result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    project_dir = os.path.join(settings.upload_dir, project_id)
    os.makedirs(project_dir, exist_ok=True)

    ext = os.path.splitext(file.filename or "video.mp4")[1].lower() or ".mp4"
    temp_clip_path = os.path.join(project_dir, f"temp_clip_{uuid.uuid4()}{ext}")

    content = await file.read()
    with open(temp_clip_path, "wb") as f:
        f.write(content)

    return await append_clip_file(project, db, temp_clip_path, file.filename or "video.mp4")


async def append_clip_file(project: Project, db: AsyncSession, temp_clip_path: str, filename: str):
    """Append a video file already on disk to the end of the project (it is moved or removed).
    Shared by the upload endpoint and the Assets library."""
    project_id = project.id
    project_dir = os.path.join(settings.upload_dir, project_id)
    ext = os.path.splitext(filename)[1].lower() or ".mp4"

    try:
        from backend.services.video_service import get_duration_ffprobe, concatenate_video_files
        new_clip_dur = get_duration_ffprobe(temp_clip_path)
    except Exception:
        new_clip_dur = 5.0

    # Deleting a clip only takes it off the timeline; the file stays. With every clip gone the
    # old video is no longer part of the edit, so a new one replaces it. Joined onto the end
    # instead, the new video began a minute (or an hour) into the file, behind footage nobody
    # could see, and anything timed from zero — an imported subtitle — landed on the hidden part.
    has_video = bool(project.video_path) and os.path.exists(project.video_path)
    if has_video:
        on_timeline = (await db.execute(
            select(VideoClip.id).where(VideoClip.project_id == project_id).limit(1)
        )).first()
        if not on_timeline:
            from backend.services.video_service import clear_derived_audio
            for stale in (project.video_path, project.preview_path, os.path.join(project_dir, "preview.mp4")):
                if stale and os.path.isfile(stale):
                    try:
                        os.remove(stale)
                    except OSError:
                        pass
            clear_derived_audio(project_dir)   # the stems were separated from the old video
            project.preview_path = ""
            project.preview_status = "none"
            has_video = False

    project.timeline_cleared = False
    if not has_video:
        master_path = os.path.join(project_dir, f"master_{uuid.uuid4()}{ext}")
        shutil.move(temp_clip_path, master_path)
        project.video_path = master_path
        project.video_filename = filename
        project.duration = new_clip_dur
        project.status = "uploaded"

        new_clip = VideoClip(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=0,
            source_start=0.0,
            source_end=new_clip_dur,
        )
        db.add(new_clip)
        await db.commit()
    else:
        old_duration = project.duration or get_duration_ffprobe(project.video_path)
        combined_path = os.path.join(project_dir, f"master_{uuid.uuid4()}{ext}")

        total_dur = await asyncio.to_thread(
            concatenate_video_files,
            [project.video_path, temp_clip_path],
            combined_path,
        )

        # Cleanup old master video if it was generated
        if os.path.exists(project.video_path) and "master_" in project.video_path:
            try:
                os.remove(project.video_path)
            except OSError:
                pass
        if os.path.exists(temp_clip_path):
            try:
                os.remove(temp_clip_path)
            except OSError:
                pass

        project.video_path = combined_path
        project.duration = total_dur

        clips_res = await db.execute(
            select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
        )
        clips = list(clips_res.scalars().all())

        if not clips:
            db.add(VideoClip(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=0,
                source_start=0.0,
                source_end=old_duration,
            ))
            next_idx = 1
        else:
            next_idx = len(clips)

        appended_clip = VideoClip(
            id=str(uuid.uuid4()),
            project_id=project_id,
            index=next_idx,
            source_start=old_duration,
            source_end=total_dur,
        )
        db.add(appended_clip)

        # Sanitize existing segments so no segment overshoots old_duration or exceeds 15s
        existing_segs_res = await db.execute(
            select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
        )
        existing_segs = list(existing_segs_res.scalars().all())
        for s in existing_segs:
            if s.end_time > old_duration:
                s.end_time = old_duration
            if (s.end_time - s.start_time) > 15.0:
                char_len = len((s.text or "").strip())
                s.end_time = round(s.start_time + max(2.5, min(char_len * 0.2, 10.0)), 2)

        # If project has transcripts, add a new segment for the appended clip so T1/A1 have an entry
        if existing_segs:
            new_clip_dur = total_dur - old_duration
            db.add(Segment(
                id=str(uuid.uuid4()),
                project_id=project_id,
                index=len(existing_segs),
                start_time=round(old_duration + 0.2, 2),
                end_time=round(min(old_duration + max(2.0, min(new_clip_dur, 5.0)), total_dur), 2),
                text="[New Clip Dialogue]",
                original_text="[New Clip Dialogue]",
                speaker=existing_segs[-1].speaker if existing_segs else "",
                voice_profile=existing_segs[-1].voice_profile if existing_segs else "female",
            ))

        await db.commit()

    # Return all updated clips
    result = await db.execute(
        select(VideoClip)
        .where(VideoClip.project_id == project_id)
        .order_by(VideoClip.index)
    )
    return [VideoClipResponse.model_validate(c) for c in result.scalars().all()]


# --- Removing stretches of the video ------------------------------------------------------
# Clips play back to back, so "timeline time" is the position in the edit and "source time" is
# the position in the file. Cutting a stretch out means rewriting the clips to skip that source
# range AND pulling every later caption earlier by the same amount, or the dub loses sync.

class RemoveRangesRequest(BaseModel):
    ranges: list[list[float]]            # [[start, end], …] in timeline seconds
    dry_run: bool = False
    keep_captions: bool = False          # keep captions inside the cut, pinned to the join



def _merge_ranges(ranges: list[list[float]]) -> list[tuple[float, float]]:
    cleaned = sorted(
        (round(float(a), 3), round(float(b), 3))
        for a, b in ranges if b is not None and a is not None and float(b) > float(a)
    )
    merged: list[list[float]] = []
    for a, b in cleaned:
        if merged and a <= merged[-1][1] + 0.01:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def _surviving_pieces(clips: list, cuts: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """What is left of each clip's SOURCE span once the cut source ranges are taken out."""
    pieces: list[tuple[float, float]] = []
    for clip in sorted(clips, key=lambda c: c.index):
        spans = [(clip.source_start, clip.source_end)]
        for cut_a, cut_b in cuts:
            next_spans = []
            for a, b in spans:
                if cut_b <= a or cut_a >= b:
                    next_spans.append((a, b))
                    continue
                if a < cut_a:
                    next_spans.append((a, cut_a))
                if cut_b < b:
                    next_spans.append((cut_b, b))
            spans = next_spans
        pieces.extend((round(a, 3), round(b, 3)) for a, b in spans if b - a > 0.05)
    return pieces


def _still_shown(start: float, end: float, cuts: list[tuple[float, float]]) -> bool:
    """Is any of this caption still inside the edit after the cuts?"""
    remaining = end - start
    for a, b in cuts:
        overlap = min(end, b) - max(start, a)
        if overlap > 0:
            remaining -= overlap
    return remaining > 0.2


@router.post("/clips/remove-ranges")
async def remove_timeline_ranges(
    project_id: str,
    body: RemoveRangesRequest,
    db: AsyncSession = Depends(get_db),
):
    """Cut stretches out of the edit.

    The ranges are SOURCE seconds — the same clock captions are stored in. Clips are rewritten
    to skip them, which is what pulls the later picture earlier; the captions keep their source
    times and the clip layout does the shifting, so nothing is moved twice. Only captions that
    fall inside a cut are removed, because those moments no longer exist in the edit.
    """
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(404, "Project not found")

    clip_rows = list((await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
    )).scalars().all())
    if not clip_rows:
        raise HTTPException(400, "This project has no video clips to cut")

    timeline_before = sum(c.source_end - c.source_start for c in clip_rows)
    cuts = _merge_ranges(body.ranges)
    if not cuts:
        raise HTTPException(400, "Nothing to remove")

    pieces = _surviving_pieces(clip_rows, cuts)
    if not pieces:
        raise HTTPException(400, "That would remove the whole video")
    timeline_after = sum(b - a for a, b in pieces)

    seg_rows = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())
    doomed = [s for s in seg_rows if not _still_shown(s.start_time, s.end_time, cuts)]

    if body.dry_run:
        return {
            "dry_run": True,
            "ranges": [{"start": a, "end": b, "seconds": round(b - a, 2)} for a, b in cuts],
            "removed_seconds": round(timeline_before - timeline_after, 2),
            "timeline_before": round(timeline_before, 2),
            "timeline_after": round(timeline_after, 2),
            "clips_before": len(clip_rows),
            "clips_after": len(pieces),
            "captions_before": len(seg_rows),
            "captions_kept": len(seg_rows) - len(doomed),
            "captions_dropped": len(doomed),
        }

    from backend.services.project_versions import auto_save

    n = len(cuts)
    await auto_save(db, project_id, f"Before cutting {n} {'stretch' if n == 1 else 'stretches'} from the video")
    for clip in clip_rows:
        await db.delete(clip)
    await db.flush()
    for i, (src_a, src_b) in enumerate(pieces):
        db.add(VideoClip(id=str(uuid.uuid4()), project_id=project_id, index=i,
                         source_start=src_a, source_end=src_b))
    for seg in doomed:
        await db.delete(seg)
    await db.commit()

    final_clips = list((await db.execute(
        select(VideoClip).where(VideoClip.project_id == project_id).order_by(VideoClip.index)
    )).scalars().all())
    final_segs = list((await db.execute(
        select(Segment).where(Segment.project_id == project_id).order_by(Segment.start_time)
    )).scalars().all())
    for i, seg in enumerate(final_segs):
        seg.index = i
    await db.commit()

    return {
        "removed_seconds": round(timeline_before - timeline_after, 2),
        "timeline_before": round(timeline_before, 2),
        "timeline_after": round(sum(c.source_end - c.source_start for c in final_clips), 2),
        "clips": [VideoClipResponse.model_validate(c).model_dump(mode="json") for c in final_clips],
        "captions_kept": len(final_segs),
        "captions_dropped": len(doomed),
        "segments": [SegmentResponse.model_validate(s).model_dump(mode="json") for s in final_segs],
    }
