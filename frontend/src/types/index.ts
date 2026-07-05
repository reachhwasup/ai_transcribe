export interface Segment {
  id: string;
  project_id: string;
  index: number;
  start_time: number;
  end_time: number;
  text: string;
  original_text: string;
  speaker: string;
  voice_profile: string;
  voice_name: string;
  emotion: string;
  audio_url: string;
  audio_speed: number;
  created_at: string;
  updated_at: string;
}

export interface VideoClip {
  id: string;
  project_id: string;
  index: number;
  source_start: number;
  source_end: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  video_filename: string;
  video_path: string;
  duration: number;
  status: string;
  language: string;
  created_at: string;
  updated_at: string;
  segments: Segment[];
  video_clips: VideoClip[];
}

export interface ProjectListItem {
  id: string;
  name: string;
  description: string;
  video_filename: string;
  duration: number;
  status: string;
  language: string;
  created_at: string;
  updated_at: string;
  segment_count: number;
}
