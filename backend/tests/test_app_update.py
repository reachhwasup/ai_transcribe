import os
import tempfile
import time
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from backend.api.routes import app_update as au


class AppUpdateTest(unittest.IsolatedAsyncioTestCase):
    """The app knows when the code has moved on, and brings itself up to date."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, "frontend", "src"))
        os.makedirs(os.path.join(self.root, "backend", "venv"))
        self.page = os.path.join(self.root, "frontend", "src", "App.tsx")
        self.code = os.path.join(self.root, "backend", "main.py")
        self.touch(self.page, 1000), self.touch(self.code, 1000)
        self.touch(os.path.join(self.root, "backend", "venv", "lib.py"), 9000)       # not the app's own code
        for name, value in (("ROOT", self.root), ("FRONTEND", os.path.join(self.root, "frontend")),
                            ("DIST_INDEX", os.path.join(self.root, "frontend", "dist", "index.html"))):
            patcher = patch.object(au, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def touch(self, path, when):
        open(path, "a").close()
        os.utime(path, (when, when))

    def owned(self, yes=True):
        return patch.dict(os.environ, {"DUBBING_STUDIO_OWNED": "1"} if yes else {}, clear=not yes)

    def test_nothing_is_behind_when_built_and_started_after_the_last_change(self):
        with self.owned():
            found = au.status(built_at=2000, started_at=2000)
        self.assertEqual((found["pages_behind"], found["server_behind"], found["update_ready"]), (False, False, False))

    def test_changed_pages_and_changed_server_code_are_each_noticed(self):
        with self.owned():
            self.touch(self.page, 3000)
            self.assertEqual(au.status(2000, 2000)["pages_behind"], True)
            self.assertEqual(au.status(2000, 2000)["server_behind"], False)
            self.touch(self.code, 3000)
            self.assertEqual(au.status(4000, 2000)["server_behind"], True)

    def test_a_development_server_is_never_asked_to_restart(self):
        self.touch(self.code, 3000)
        with self.owned(False):
            found = au.status(2000, 2000)
        self.assertEqual((found["server_behind"], found["can_restart"]), (False, False))

    async def test_updating_builds_the_pages_and_restarts_only_when_the_server_changed(self):
        self.touch(self.page, time.time() + 50)
        with self.owned(), patch.object(au, "build_pages", AsyncMock()) as build, patch.object(au, "restart_soon") as restart:
            self.assertEqual(await au.update_now(), {"pages_built": True, "restarting": False})
            build.assert_awaited_once()
            restart.assert_not_called()
            self.touch(self.code, time.time() + 50)
            self.assertEqual((await au.update_now())["restarting"], True)
            restart.assert_called_once()

    async def test_a_failed_build_changes_nothing_and_restarts_nothing(self):
        self.touch(self.page, time.time() + 50), self.touch(self.code, time.time() + 50)
        failing = AsyncMock(side_effect=HTTPException(500, "The pages could not be built"))
        with self.owned(), patch.object(au, "build_pages", failing), patch.object(au, "restart_soon") as restart:
            with self.assertRaises(HTTPException):
                await au.update_now()
        restart.assert_not_called()
        self.assertFalse(au._building)


if __name__ == "__main__":
    unittest.main()
