from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from backend.config import settings

engine = create_async_engine(settings.database_url, echo=False)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        yield session


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Add voice_profile column if missing (migration for existing DBs)
        try:
            await conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE segments ADD COLUMN voice_profile VARCHAR(10) DEFAULT 'female'"
                )
            )
        except Exception:
            pass  # Column already exists
        # Add emotion column if missing
        try:
            await conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE segments ADD COLUMN emotion VARCHAR(50) DEFAULT 'neutral'"
                )
            )
        except Exception:
            pass  # Column already exists
