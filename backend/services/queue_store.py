"""Keeping a job queue across a restart.

The render queue and the pipeline queue hold their jobs in memory. That was fine for a render
or two, but a batch left running overnight was lost if the server restarted — including the
automatic reload that follows any change to the code. Each queue now writes its list to the
database whenever it changes and reads it back on startup.

Nothing is written until `enable()` is called at application startup, so importing a queue
module (in a test, a script) never touches the database.
"""
from __future__ import annotations

import json

_enabled = False


def enable() -> None:
    global _enabled
    _enabled = True


async def save(key: str, payload: dict) -> None:
    if not _enabled:
        return
    from backend.database.db import async_session
    from backend.database.models import AppSetting

    try:
        async with async_session() as db:
            row = await db.get(AppSetting, key)
            value = json.dumps(payload, ensure_ascii=False)
            if row:
                row.value = value
            else:
                db.add(AppSetting(key=key, value=value))
            await db.commit()
    except Exception as exc:   # a queue that cannot be saved still runs
        print(f"[queue] could not save {key}: {type(exc).__name__}", flush=True)


async def load(key: str) -> dict:
    from backend.database.db import async_session
    from backend.database.models import AppSetting

    try:
        async with async_session() as db:
            row = await db.get(AppSetting, key)
            data = json.loads(row.value) if row and row.value else {}
            return data if isinstance(data, dict) else {}
    except Exception as exc:
        print(f"[queue] could not load {key}: {type(exc).__name__}", flush=True)
        return {}
