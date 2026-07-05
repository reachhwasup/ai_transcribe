from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    speaker_voice: str = "female"
    tts_engine: str = "edge-tts"  # edge-tts | voxcpm
    voxcpm_model_path: str = "openbmb/VoxCPM2"
    voxcpm_inference_steps: int = 3  # 2=fastest, 3=balanced, 5=quality
    database_url: str = "sqlite+aiosqlite:///./data/app.db"
    upload_dir: str = "./uploads"

    class Config:
        env_file = ".env"


settings = Settings()

# Ensure directories exist
Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
Path("./data").mkdir(parents=True, exist_ok=True)
