from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from backend.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=False,
    connect_args={"timeout": 60} if "sqlite" in settings.database_url else {},
)

if "sqlite" in settings.database_url:
    @event.listens_for(engine.sync_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA cache_size=-64000")  # 64MB cache
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.close()

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        yield session


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # Migrations & Performance Indexes
        migration_statements = [
            "ALTER TABLE segments ADD COLUMN voice_profile VARCHAR(10) DEFAULT 'female'",
            "ALTER TABLE segments ADD COLUMN emotion VARCHAR(50) DEFAULT 'neutral'",
            "ALTER TABLE projects ADD COLUMN preview_path VARCHAR(1000) DEFAULT ''",
            "ALTER TABLE projects ADD COLUMN preview_status VARCHAR(20) DEFAULT 'none'",
            "ALTER TABLE video_clips ADD COLUMN transition_type VARCHAR(50) DEFAULT 'none'",
            "ALTER TABLE video_clips ADD COLUMN transition_duration FLOAT DEFAULT 0.5",
            "ALTER TABLE projects ADD COLUMN source_project_id VARCHAR(36) DEFAULT ''",
            "ALTER TABLE projects ADD COLUMN part_index INTEGER DEFAULT 0",
            "ALTER TABLE projects ADD COLUMN part_count INTEGER DEFAULT 0",
            "ALTER TABLE projects ADD COLUMN part_offset FLOAT DEFAULT 0.0",
            "ALTER TABLE segments ADD COLUMN voice_fx VARCHAR(20) DEFAULT 'normal'",
            "ALTER TABLE projects ADD COLUMN timeline_cleared BOOLEAN DEFAULT 0",
            "ALTER TABLE projects ADD COLUMN batch_id VARCHAR(36) DEFAULT ''",
            "ALTER TABLE projects ADD COLUMN batch_name VARCHAR(255) DEFAULT ''",
            "ALTER TABLE projects ADD COLUMN batch_index INTEGER DEFAULT 0",
            "CREATE INDEX IF NOT EXISTS ix_segments_project_time ON segments (project_id, start_time)",
            "CREATE INDEX IF NOT EXISTS ix_segments_project_speaker ON segments (project_id, speaker)",
            "CREATE INDEX IF NOT EXISTS ix_video_clips_project_index ON video_clips (project_id, index)",
        ]
        for stmt in migration_statements:
            try:
                await conn.execute(text(stmt))
            except Exception:
                pass  # Already exists or applied
