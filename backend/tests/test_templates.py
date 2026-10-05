import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.api.routes import templates as tp
from backend.api.routes.project_settings import load_editor_settings, save_editor_settings
from backend.database.db import Base
from backend.database.models import Project


class TemplateTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.cwd = os.getcwd()
        os.chdir(self.dir.name)                      # logo urls are paths from the working directory
        self.uploads = patch.object(tp.settings, "upload_dir", "./uploads")
        self.uploads.start()
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self.db = async_sessionmaker(self.engine, expire_on_commit=False)()
        os.makedirs("uploads/ep1/watermarks")
        with open("uploads/ep1/watermarks/logo.png", "wb") as f:
            f.write(b"png")
        self.db.add_all([
            Project(id="ep1", name="Episode 1", video_path="uploads/ep1/a.mp4"),
            Project(id="ep2", name="Episode 2", video_path="uploads/ep2/b.mp4"),
            Project(id="bare", name="Bare"),
        ])
        await save_editor_settings(self.db, "ep1", {
            "caption_style": {"sizePct": 6}, "video_filter": {"preset": "vivid", "steps": [["saturate", 1.4]]},
            "logo": {"url": "/uploads/ep1/watermarks/logo.png", "enabled": True},
            "blur_shapes": [{"x": 1}],
        })
        await save_editor_settings(self.db, "ep2", {"aspect_ratio": "9:16", "blur_shapes": [{"x": 2}]})
        await self.db.commit()

    async def asyncTearDown(self):
        await self.db.close()
        await self.engine.dispose()
        self.uploads.stop()
        os.chdir(self.cwd)
        self.dir.cleanup()

    async def test_a_template_carries_the_look_to_another_project_and_leaves_the_rest(self):
        made = await tp.create_template(tp.TemplateCreate(name="My series", project_id="ep1", platform="tiktok"), self.db)
        self.assertEqual(sorted(made["has"]), ["caption_style", "logo", "video_filter"])

        out = await tp.apply_template(made["id"], "ep2", self.db)
        self.assertEqual((sorted(out["applied"]), out["platform"]), (["caption_style", "logo", "video_filter"], "tiktok"))
        ep2 = await load_editor_settings(self.db, "ep2")
        self.assertEqual(ep2["caption_style"], {"sizePct": 6})
        self.assertEqual(ep2["aspect_ratio"], "9:16")            # not in the template: kept
        self.assertEqual(ep2["blur_shapes"], [{"x": 2}])          # blur boxes belong to one video
        self.assertEqual(ep2["logo"]["url"], "/uploads/ep2/watermarks/logo.png")
        self.assertTrue(os.path.isfile("uploads/ep2/watermarks/logo.png"))

    async def test_the_template_still_works_after_its_project_is_gone(self):
        made = await tp.create_template(tp.TemplateCreate(name="My series", project_id="ep1"), self.db)
        os.remove("uploads/ep1/watermarks/logo.png")
        await tp.apply_template(made["id"], "ep2", self.db)
        self.assertTrue(os.path.isfile("uploads/ep2/watermarks/logo.png"))

    async def test_saving_under_the_same_name_replaces_it_and_delete_removes_it(self):
        first = await tp.create_template(tp.TemplateCreate(name="My series", project_id="ep1"), self.db)
        second = await tp.create_template(tp.TemplateCreate(name="my SERIES", project_id="ep1"), self.db)
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(await tp.list_templates(self.db)), 1)
        await tp.delete_template(first["id"], self.db)
        self.assertEqual(await tp.list_templates(self.db), [])

    async def test_a_project_with_no_look_cannot_be_saved_as_one(self):
        with self.assertRaises(HTTPException) as caught:
            await tp.create_template(tp.TemplateCreate(name="Empty", project_id="bare"), self.db)
        self.assertEqual(caught.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
