from moviepy import VideoFileClip


def get_video_duration(video_path: str) -> float:
    """Get video duration in seconds."""
    video = VideoFileClip(video_path)
    duration = video.duration
    video.close()
    return duration
