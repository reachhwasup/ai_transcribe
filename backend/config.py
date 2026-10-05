from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.6-flash"
    # the model that edits pictures (removing the title from a poster); text models cannot
    gemini_image_model: str = "gemini-2.5-flash-image"
    # Codex (ChatGPT's agent) as a second engine. The path is found by itself when left empty;
    # the model is the one Codex runs the job with, and "" leaves it to Codex's own default.
    codex_path: str = ""
    codex_model: str = "gpt-6.1-sol"
    speaker_voice: str = "female"
    tts_engine: str = "edge-tts"  # edge-tts | voxcpm
    voxcpm_model_path: str = "openbmb/VoxCPM2"
    # 10 is the figure in the model card's examples, but at 10 steps Khmer lines came out
    # saying the wrong words about a third of the time; 30 was reliable and costs well under
    # a second more per line on this machine.
    voxcpm_inference_steps: int = 30
    # how hard vocal/BGM isolation drives the GPU: fast | balanced | cool (rests between chunks)
    separation_pace: str = "balanced"
    # How closely generation follows the reference voice. Higher holds the character better
    # but can sound stiff; 2.0 is the VoxCPM default.
    voxcpm_cfg_value: float = 2.0
    database_url: str = "sqlite+aiosqlite:///./data/app.db"
    upload_dir: str = "./uploads"

    class Config:
        env_file = ".env"


settings = Settings()

# Ensure directories exist
Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
Path("./data").mkdir(parents=True, exist_ok=True)
