export interface Segment {
  id: string;
  project_id: string;
  index: number;
  start_time: number;
  end_time: number;
  text: string;
  original_text: string;
  speaker: string;
  gender?: string;
  voice_profile: string;
  voice_name: string;
  emotion: string;
  voice_fx?: string;
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
  preview_status?: string; // none | generating | ready | error
  duration: number;
  status: string;
  language: string;
  created_at: string;
  updated_at: string;
  // Set when this project is one part of a longer video that was split on upload.
  source_project_id?: string;
  part_index?: number;   // 1-based; 0 / undefined means this is not a part
  part_count?: number;
  part_offset?: number;  // where this part starts in the original, in seconds
  /** Every clip was deleted from the timeline; the video file is kept only so undo works */
  timeline_cleared?: boolean;
  segments: Segment[];
  video_clips: VideoClip[];
}

export interface ProjectListItem {
  id: string;
  name: string;
  description: string;
  video_filename: string;
  source_project_id?: string;
  part_index?: number;
  /** Made with others from one folder: shown together, in the folder's order */
  batch_id?: string;
  batch_name?: string;
  batch_index?: number;
  part_count?: number;
  duration: number;
  status: string;
  language: string;
  created_at: string;
  updated_at: string;
  segment_count: number;
  dubbed_count?: number;
  /** Spoken captions that name no speaker; they are all dubbed in one default voice */
  unnamed_count?: number;
  transcribe_warning?: string;
}
