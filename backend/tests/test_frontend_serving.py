import os
import tempfile
import unittest

from backend.main import frontend_file


class FrontendServingTest(unittest.TestCase):
    """The desktop app's pages come from the built frontend; the API is never shadowed."""

    def setUp(self):
        self.dist = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.dist, "assets"))
        for name in ("index.html", "assets/app-abc.js", "favicon.svg"):
            open(os.path.join(self.dist, name), "w").close()

    def test_files_are_served_and_app_addresses_get_the_page(self):
        index = os.path.join(self.dist, "index.html")
        self.assertEqual(frontend_file("", self.dist), index)
        self.assertEqual(frontend_file("project/123", self.dist), index)          # the app's router reads it
        self.assertEqual(frontend_file("assets/app-abc.js", self.dist), os.path.join(self.dist, "assets", "app-abc.js"))
        self.assertEqual(frontend_file("favicon.svg", self.dist), os.path.join(self.dist, "favicon.svg"))

    def test_the_api_and_uploads_are_left_alone(self):
        for path in ("api/nothing-here", "api", "uploads/x/film.mp4"):
            self.assertIsNone(frontend_file(path, self.dist))

    def test_nothing_outside_the_build_is_handed_out(self):
        secret = os.path.join(os.path.dirname(self.dist), "secret.txt")
        open(secret, "w").close()
        self.addCleanup(os.remove, secret)
        self.assertEqual(frontend_file("../secret.txt", self.dist), os.path.join(self.dist, "index.html"))

    def test_without_a_build_there_is_nothing_to_serve(self):
        self.assertIsNone(frontend_file("", tempfile.mkdtemp()))


if __name__ == "__main__":
    unittest.main()
