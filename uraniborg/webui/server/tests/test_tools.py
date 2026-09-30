#
# Copyright 2026 Uraniborg authors.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Tests of the Browse dialog's listing and the verifier build."""

import os
import stat
import tempfile
import time
import unittest

import _http
import fsbrowse
import helper_http
import verifier

TIMEOUT_S = 15

# A stand-in for `go`: answers `go env GOVERSION`, and for `go build -o OUT
# ./cmd/verifier` writes an executable OUT, unless FAKE_GO_FAIL is set.
FAKE_GO = """#!/bin/sh
if [ "$1" = env ]; then echo "${FAKE_GO_VERSION:-go1.26.1}"; exit 0; fi
if [ "$1" = build ]; then
  echo "go: downloading example.com/mod v1.0.0"
  if [ -n "$FAKE_GO_SLEEP" ]; then sleep "$FAKE_GO_SLEEP"; fi
  if [ -n "$FAKE_GO_FAIL" ]; then echo "cmd/verifier/verifier.go:1: boom"; exit 1; fi
  [ -f go.mod ] || { echo "not in the module"; exit 1; }
  printf '#!/bin/sh\\necho verifier\\n' > "$3"
  chmod +x "$3"
  exit 0
fi
exit 2
"""


def make_executable(path, content):
  with open(path, "w") as f:
    f.write(content)
  os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
  return path


def make_source(root, go_directive="1.25.0"):
  source = os.path.join(root, "verify")
  os.makedirs(os.path.join(source, "cmd", "verifier"))
  with open(os.path.join(source, "go.mod"), "w") as f:
    f.write("module example.com/verify\n\ngo %s\n\nrequire (\n)\n" % go_directive)
  return source


class FsListTest(unittest.TestCase):

  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.root = os.path.realpath(tmp.name)
    os.makedirs(os.path.join(self.root, "b-dir"))
    os.makedirs(os.path.join(self.root, "A-dir"))
    with open(os.path.join(self.root, "c.apk"), "w") as f:
      f.write("x")
    make_executable(os.path.join(self.root, "verifier"), "#!/bin/sh\n")
    os.symlink(os.path.join(self.root, "c.apk"), os.path.join(self.root, "latest"))
    os.symlink(os.path.join(self.root, "gone"), os.path.join(self.root, "dangling"))

  def test_lists_dirs_first_then_files_by_name(self):
    body = fsbrowse.list_dir(self.root)
    self.assertEqual(body["path"], self.root)
    self.assertEqual(body["parent"], os.path.dirname(self.root))
    self.assertEqual([e["name"] for e in body["entries"]],
                     ["A-dir", "b-dir", "c.apk", "dangling", "latest", "verifier"])
    by_name = {e["name"]: e for e in body["entries"]}
    self.assertTrue(by_name["A-dir"]["dir"])
    self.assertEqual(by_name["verifier"], {"name": "verifier", "dir": False, "exec": True})
    self.assertEqual(by_name["latest"], {"name": "latest", "dir": False, "link": True})
    self.assertEqual(by_name["dangling"], {"name": "dangling", "dir": False, "link": True})
    self.assertNotIn("selected", body)

  def test_a_file_lists_its_directory_and_selects_it(self):
    body = fsbrowse.list_dir(os.path.join(self.root, "c.apk"))
    self.assertEqual(body["path"], self.root)
    self.assertEqual(body["selected"], "c.apk")
    self.assertNotIn("missing", body)

  def test_a_missing_path_lists_the_closest_existing_parent(self):
    body = fsbrowse.list_dir(os.path.join(self.root, "b-dir", "new", "deeper"))
    self.assertEqual(body["path"], os.path.join(self.root, "b-dir"))
    self.assertNotIn("selected", body)
    # What does not exist yet is reported, so a picker can keep it.
    self.assertEqual(body["missing"], os.path.join("new", "deeper"))

  def test_an_existing_directory_has_nothing_missing(self):
    self.assertNotIn("missing", fsbrowse.list_dir(self.root))
    self.assertNotIn("missing", fsbrowse.list_dir(self.root + "/"))

  def test_blank_and_tilde_mean_home(self):
    home = os.path.expanduser("~")
    self.assertEqual(fsbrowse.list_dir("")["path"], home)
    self.assertEqual(fsbrowse.list_dir(None)["home"], home)
    self.assertEqual(fsbrowse.list_dir("~")["path"], home)

  def test_relative_paths_are_refused(self):
    with self.assertRaises(fsbrowse.ListError) as cm:
      fsbrowse.list_dir("relative/path")
    self.assertEqual((cm.exception.status, cm.exception.reason), (400, "not_absolute"))

  def test_root_has_no_parent(self):
    self.assertNotIn("parent", fsbrowse.list_dir("/"))

  @unittest.skipIf(os.geteuid() == 0, "root can list anything")
  def test_unreadable_directory(self):
    locked = os.path.join(self.root, "locked")
    os.makedirs(locked)
    os.chmod(locked, 0)
    self.addCleanup(os.chmod, locked, 0o700)
    with self.assertRaises(fsbrowse.ListError) as cm:
      fsbrowse.list_dir(locked)
    self.assertEqual((cm.exception.status, cm.exception.reason), (403, "permission_denied"))

  def test_truncates_huge_directories(self):
    many = os.path.join(self.root, "many")
    os.makedirs(many)
    for i in range(12):
      open(os.path.join(many, "f%02d" % i), "w").close()
    original = fsbrowse.MAX_ENTRIES
    fsbrowse.MAX_ENTRIES = 10
    self.addCleanup(setattr, fsbrowse, "MAX_ENTRIES", original)
    body = fsbrowse.list_dir(many)
    self.assertEqual(len(body["entries"]), 10)
    self.assertTrue(body["truncated"])


class VerifierBuilderTest(unittest.TestCase):

  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.root = os.path.realpath(tmp.name)
    self.source = make_source(self.root)
    self.tools = os.path.join(self.root, "cache", "tools")
    self.go = make_executable(os.path.join(self.root, "go"), FAKE_GO)

  def builder(self, go="default", **env):
    return verifier.VerifierBuilder(
        source=self.source, tools_dir=self.tools,
        go=self.go if go == "default" else go,
        env=dict(os.environ, **env))

  def wait(self, builder):
    deadline = time.monotonic() + TIMEOUT_S
    while time.monotonic() < deadline:
      status = builder.status()
      if status["build"]["state"] != verifier.STATE_RUNNING:
        return status
      time.sleep(0.02)
    self.fail("build did not finish")

  def test_status_before_building(self):
    status = self.builder().status()
    self.assertEqual(status["sourceDir"], self.source)
    self.assertTrue(status["sourceFound"])
    self.assertFalse(status["built"])
    self.assertEqual(status["binary"], os.path.join(self.tools, "verifier"))
    self.assertEqual(status["go"], self.go)
    self.assertEqual(status["goVersion"], "go1.26.1")
    self.assertEqual(status["goRequired"], "1.25.0")
    self.assertFalse(status["goOutdated"])
    self.assertEqual(status["build"], {"state": "idle", "output": []})

  def test_older_go_is_flagged(self):
    status = self.builder(FAKE_GO_VERSION="go1.22.3").status()
    self.assertTrue(status["goOutdated"])

  def test_builds_into_the_tools_dir_only(self):
    b = self.builder()
    b.start()
    status = self.wait(b)
    self.assertEqual(status["build"]["state"], "succeeded", status)
    self.assertTrue(status["built"])
    self.assertIn("finishedAt", status["build"])
    self.assertTrue(os.access(os.path.join(self.tools, "verifier"), os.X_OK))
    self.assertEqual(os.listdir(self.tools), ["verifier"])
    # Nothing new in the source tree.
    self.assertEqual(sorted(os.listdir(self.source)), ["cmd", "go.mod"])
    self.assertTrue(status["build"]["output"][0].startswith("$ %s build -o " % self.go))
    self.assertIn("go: downloading example.com/mod v1.0.0", status["build"]["output"])

  def test_a_failed_build_keeps_the_previous_binary(self):
    b = self.builder()
    b.start()
    self.wait(b)
    before = os.stat(os.path.join(self.tools, "verifier")).st_mtime_ns

    failing = self.builder(FAKE_GO_FAIL="1")
    failing.start()
    status = self.wait(failing)
    self.assertEqual(status["build"]["state"], "failed")
    self.assertEqual(status["build"]["error"], "go build failed (exit code 1).")
    self.assertIn("cmd/verifier/verifier.go:1: boom", status["build"]["output"])
    self.assertTrue(status["built"])
    self.assertEqual(os.stat(os.path.join(self.tools, "verifier")).st_mtime_ns, before)
    self.assertEqual(os.listdir(self.tools), ["verifier"])

  def test_one_build_at_a_time(self):
    b = self.builder(FAKE_GO_SLEEP="1")
    b.start()
    with self.assertRaises(verifier.BuildError) as cm:
      b.start()
    self.assertEqual(cm.exception.reason, "busy")
    self.wait(b)

  def test_no_go(self):
    b = self.builder(go=None)
    b._go = None
    original = verifier.GO_FALLBACKS
    verifier.GO_FALLBACKS = ()
    self.addCleanup(setattr, verifier, "GO_FALLBACKS", original)
    path = os.environ.get("PATH", "")
    os.environ["PATH"] = self.source  # no go here
    self.addCleanup(os.environ.__setitem__, "PATH", path)
    self.assertNotIn("go", b.status())
    with self.assertRaises(verifier.BuildError) as cm:
      b.start()
    self.assertEqual(cm.exception.reason, "go_not_found")

  def test_no_source(self):
    b = verifier.VerifierBuilder(source=os.path.join(self.root, "nope"),
                                 tools_dir=self.tools, go=self.go)
    self.assertFalse(b.status()["sourceFound"])
    with self.assertRaises(verifier.BuildError) as cm:
      b.start()
    self.assertEqual(cm.exception.reason, "source_not_found")

  def test_default_source_is_the_repo_verifier(self):
    self.assertTrue(verifier.DEFAULT_SOURCE.endswith(
        os.path.join("verifier_tools", "verify")))
    self.assertTrue(os.path.isfile(os.path.join(verifier.DEFAULT_SOURCE, "go.mod")))

  def test_default_tools_dir_is_outside_the_repo(self):
    tools = verifier.default_tools_dir()
    self.assertTrue(tools.endswith("uraniborg-helper"))
    self.assertFalse(tools.startswith(verifier.REPO_DIR + os.sep))


class ToolsApiTest(_http.HelperServerTestCase):

  def make_helper(self):
    self.source = make_source(self.tmp)
    self.go = make_executable(os.path.join(self.tmp, "go"), FAKE_GO)
    builder = verifier.VerifierBuilder(source=self.source,
                                       tools_dir=os.path.join(self.tmp, "tools"),
                                       go=self.go)
    return helper_http.Helper(script=self.script, dist=self.dist,
                              token=_http.TOKEN, log_stream=self.log,
                              verifier=builder)

  def test_fs_list(self):
    status, body = self.json_request(
        "GET", "/api/fs/list?path=" + os.path.join(self.tmp, "dist", "index.html"))
    self.assertEqual(status, 200)
    self.assertEqual(body["path"], os.path.join(self.tmp, "dist"))
    self.assertEqual(body["selected"], "index.html")
    self.assertEqual([e["name"] for e in body["entries"]], ["assets", "index.html"])

  def test_fs_list_errors_and_token(self):
    status, body = self.json_request("GET", "/api/fs/list?path=rel")
    self.assertEqual((status, body["error"]["reason"]), (400, "not_absolute"))
    status, _ = self.json_request("GET", "/api/fs/list", token=None)
    self.assertEqual(status, 401)

  def test_verifier_build_round_trip(self):
    status, body = self.json_request("GET", "/api/verifier")
    self.assertEqual(status, 200)
    self.assertFalse(body["built"])
    status, body = self.json_request("POST", "/api/verifier/build", {})
    self.assertEqual(status, 202, body)
    self.assertIn(body["build"]["state"], ("running", "succeeded"))
    deadline = time.monotonic() + TIMEOUT_S
    while body["build"]["state"] == "running" and time.monotonic() < deadline:
      time.sleep(0.02)
      _, body = self.json_request("GET", "/api/verifier")
    self.assertEqual(body["build"]["state"], "succeeded", body)
    self.assertTrue(body["built"])

  def test_verifier_build_needs_post_and_token(self):
    status, _ = self.json_request("GET", "/api/verifier/build")
    self.assertEqual(status, 405)
    status, _ = self.json_request("POST", "/api/verifier/build", {}, token=None)
    self.assertEqual(status, 401)

  def test_verifier_build_without_source(self):
    self.helper.verifier.source = os.path.join(self.tmp, "missing")
    status, body = self.json_request("POST", "/api/verifier/build", {})
    self.assertEqual((status, body["error"]["reason"]), (503, "source_not_found"))


if __name__ == "__main__":
  unittest.main()
