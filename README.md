# AI Video Transcript to Khmer

AI-powered video transcription and translation to Khmer (ខ្មែរ) using Google Gemini Pro API, with a professional workspace tool and timeline editor.

## Features

- **Video Upload** — Upload MP4, MKV, AVI, MOV, WebM files
- **AI Transcription** — Automatic transcription using Google Gemini (2.5 Flash by default, configurable in Settings)
- **Khmer Translation** — Transcribe and translate audio to Khmer language
- **AI Narration (TTS)** — Generate speech for segments with Microsoft Edge neural voices (edge-tts)
- **Background Music** — Mood analysis and BGM generation, plus vocal/music separation (Demucs)
- **Timeline Editor** — Visual drag-and-resize timeline for adjusting segment timing
- **Transcript Editor** — Edit text, timestamps, and speaker labels
- **Video Tools** — Cut video, burn subtitles, export for platforms
- **Workspace Tool** — Project management with sidebar tools
- **Export** — Export as SRT, VTT, TXT, or JSON
- **Video Player** — Synced playback with transcript highlighting

## Architecture

```
├── backend/          # Python FastAPI server
│   ├── main.py       # App entry point
│   ├── config.py     # Settings & environment
│   ├── api/          # REST API routes
│   ├── database/     # SQLite + SQLAlchemy models
│   └── services/     # Gemini AI, audio processing, export
├── frontend/         # React + TypeScript + Tailwind CSS
│   ├── src/
│   │   ├── components/   # VideoPlayer, TimelineEditor, TranscriptPanel, Sidebar
│   │   ├── pages/        # Dashboard, ProjectEditor
│   │   ├── stores/       # Zustand state management
│   │   └── api/          # API client
│   └── ...
```

## Quick Start

### Prerequisites

- Python 3.11+
- Node.js 18+
- Google Gemini API key ([Get one here](https://aistudio.google.com/apikey))

### 1. Setup Environment

```bash
# Clone and navigate to project
cd ai_transcript

# Create .env file
cp .env.example .env
# Edit .env and add your GEMINI_API_KEY
```

### 2. Start Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate   # macOS/Linux
pip install -r requirements.txt

# Run the server
cd ..
uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### 3. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

### 4. Open the App

Visit **http://localhost:5173** in your browser.

## Usage

1. **Create a Project** — Click "New Project" on the dashboard
2. **Upload Video** — Use the sidebar "Upload Video" button
3. **Generate Transcript** — Click "Generate Transcript" (uses Gemini AI)
4. **Edit Timeline** — Drag segments to adjust timing, resize edges for precision
5. **Edit Text** — Click any segment in the transcript panel to edit
6. **Export** — Download as SRT, VTT, TXT, or JSON

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/projects/` | List all projects |
| POST | `/api/projects/` | Create new project |
| GET | `/api/projects/{id}` | Get project details |
| PATCH | `/api/projects/{id}` | Update project |
| DELETE | `/api/projects/{id}` | Delete project |
| POST | `/api/projects/{id}/upload` | Upload video |
| POST | `/api/projects/{id}/transcripts/generate` | Generate transcript |
| GET | `/api/projects/{id}/transcripts/` | List segments |
| PATCH | `/api/projects/{id}/transcripts/{seg_id}` | Update segment |
| GET | `/api/projects/{id}/export/{format}` | Export (srt/vtt/txt/json) |

## Tech Stack

- **Backend:** FastAPI, SQLAlchemy, SQLite, google-generativeai
- **Frontend:** React 19, TypeScript, Tailwind CSS, Zustand, Vite
- **AI:** Google Gemini 2.5 Flash (configurable), edge-tts narration, Demucs audio separation
- **Video:** MoviePy + ffmpeg for audio extraction and export

## License

MIT
