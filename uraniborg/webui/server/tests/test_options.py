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
"""Tests for options.py: the option schema and its argv."""

import json
import os
import stat
import sys
import tempfile
import unittest
from unittest import mock

import _support  # noqa: F401  (sets sys.path)
import options


def _load_cases():
  with open(_support.OPTION_CASES, encoding="utf-8") as f:
    return json.load(f)


# --- Shared fixture (also run by the browser mirror) ---

class OptionCasesTest(unittest.TestCase):

  def test_fixture_cases(self):
    fixture = _load_cases()
    default_output = fixture["defaultOutput"]
    for case in fixture["cases"]:
      with self.subTest(case["name"]):
        normalized, errors = options.normalize(case["options"], default_output)
        if "errors" in case:
          self.assertEqual(sorted(errors), sorted(case["errors"]))
        else:
          self.assertEqual(errors, {})
          self.assertEqual(options.build_argv(normalized), case["argv"])

  def test_every_case_has_one_expectation(self):
    for case in _load_cases()["cases"]:
      with self.subTest(case["name"]):
        self.assertEqual(("argv" in case) + ("errors" in case), 1)


# --- Script compatibility ---

class ScriptCompatibilityTest(unittest.TestCase):
  """The argv the UI can produce must parse with the real script's own
  argparse, and never trigger its "ignored flag combination" warnings."""

  @classmethod
  def setUpClass(cls):
    sys.path.insert(0, _support.SCRIPTS_PYTHON_DIR)
    try:
      import automate_observation  # pylint: disable=import-outside-toplevel
      import inclusion_proof_check  # pylint: disable=import-outside-toplevel
    except ImportError as e:  # pragma: no cover
      raise unittest.SkipTest("automate_observation not importable: %s" % e)
    finally:
      sys.path.remove(_support.SCRIPTS_PYTHON_DIR)
    cls.script = automate_observation
    cls.proof = inclusion_proof_check

  def test_prefetch_defaults_match_the_script(self):
    self.assertEqual(options.DEFAULT_PREFETCH_CONCURRENCY,
                     self.proof.DEFAULT_PREFETCH_CONCURRENCY)
    self.assertEqual(options.DEFAULT_PREFETCH_TIMEOUT,
                     self.proof.DEFAULT_PREFETCH_TIMEOUT)

  def test_fixture_argv_parses_without_warnings(self):
    fixture = _load_cases()
    for case in fixture["cases"]:
      if "argv" not in case:
        continue
      with self.subTest(case["name"]):
        argv = ["automate_observation.py", *case["argv"], "--events", "-"]
        with mock.patch.object(sys, "argv", argv):
          args = self.script.parse_arguments()
        self.assertEqual(self.script.validate_argument_combinations(args), [])
        self.assertEqual(args.events, "-")

  def test_values_reach_the_script_intact(self):
    normalized, errors = options.normalize({
        "serials": ["-weird", "host:5555"],
        "hubble": {"mode": "apk", "path": "/a b/hubble.apk"},
        "output": "/out dir",
        "inclusionProof": {"enabled": True, "verifierPath": "/v",
                           "prefetchConcurrency": 4},
    }, "/default")
    self.assertEqual(errors, {})
    argv = ["automate_observation.py", *options.build_argv(normalized)]
    with mock.patch.object(sys, "argv", argv):
      args = self.script.parse_arguments()
    self.assertEqual(args.serial, ["-weird", "host:5555"])
    self.assertEqual(args.hubble, "/a b/hubble.apk")
    self.assertEqual(args.output, "/out dir")
    self.assertEqual(args.cache_prefetch_concurrency, 4)

  def test_results_root(self):
    # Mirrors extract_results_and_apks(), which cannot be called without adb:
    # "results" is appended unless the path already ends in it.
    for output, expected in (("/tmp/x", "/tmp/x/results"),
                             ("/tmp/x/", "/tmp/x/results"),
                             ("/tmp/x/results", "/tmp/x/results"),
                             ("/tmp/x/results/", "/tmp/x/results")):
      with self.subTest(output):
        self.assertEqual(os.path.normpath(options.results_root(output)),
                         expected)


# --- Filesystem checks ---

class CheckPathsTest(unittest.TestCase):

  def setUp(self):
    self.tmp = tempfile.TemporaryDirectory()
    self.addCleanup(self.tmp.cleanup)
    self.dir = os.path.realpath(self.tmp.name)
    self.apk = self._file("hubble.apk")
    self.verifier = self._file("verifier", executable=True)

  def _file(self, name, executable=False):
    path = os.path.join(self.dir, name)
    with open(path, "w") as f:
      f.write("x")
    if executable:
      os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path

  def _validate(self, raw):
    return options.validate(raw, os.path.join(self.dir, "results"))

  def test_valid_paths(self):
    result = self._validate({
        "hubble": {"mode": "apk", "path": self.apk},
        "output": self.dir,
        "inclusionProof": {"enabled": True, "verifierPath": self.verifier,
                           "cacheDir": self.dir},
    })
    self.assertTrue(result["ok"], result["errors"])
    self.assertEqual(result["warnings"], [])

  def test_symlink_to_an_apk_is_accepted(self):
    # Like prebuilts/APK/latest, which has no .apk extension itself.
    link = os.path.join(self.dir, "latest")
    os.symlink(self.apk, link)
    result = self._validate({"hubble": {"mode": "apk", "path": link}})
    self.assertTrue(result["ok"], result["errors"])

  def test_apk_errors(self):
    not_apk = self._file("hubble.zip")
    for path, message in ((os.path.join(self.dir, "missing.apk"), "No such file."),
                          (self.dir, "Not a file."),
                          (not_apk, "Must be (or link to) an .apk file.")):
      with self.subTest(path):
        result = self._validate({"hubble": {"mode": "apk", "path": path}})
        self.assertEqual(result["errors"], {"hubble.path": message})
        self.assertIsNone(result["options"])
        self.assertTrue(result["argv"], "the preview still shows the command")

  def test_verifier_errors(self):
    not_exec = self._file("plain")
    for path, message in ((os.path.join(self.dir, "nope"), "No such file."),
                          (self.dir, "Not a file."),
                          (not_exec, "Not executable.")):
      with self.subTest(path):
        result = self._validate(
            {"inclusionProof": {"enabled": True, "verifierPath": path}})
        self.assertEqual(result["errors"],
                         {"inclusionProof.verifierPath": message})

  def test_new_output_dir_is_a_warning(self):
    result = self._validate({"output": os.path.join(self.dir, "new", "deeper")})
    self.assertTrue(result["ok"])
    self.assertEqual(len(result["warnings"]), 1)
    self.assertIn("Output directory does not exist yet", result["warnings"][0])

  def test_output_that_is_a_file(self):
    result = self._validate({"output": self.apk})
    self.assertEqual(result["errors"], {"output": "Exists but is not a directory."})

  def test_output_whose_results_dir_is_a_file(self):
    self._file("results")
    result = self._validate({"output": self.dir})
    self.assertIn("output", result["errors"])

  @unittest.skipIf(os.geteuid() == 0, "root can write anywhere")
  def test_output_that_cannot_be_created(self):
    locked = os.path.join(self.dir, "locked")
    os.mkdir(locked, 0o500)
    self.addCleanup(os.chmod, locked, 0o700)
    result = self._validate({"output": os.path.join(locked, "out")})
    self.assertEqual(result["errors"],
                     {"output": "Does not exist and cannot be created."})

  def test_tilde_is_expanded(self):
    with mock.patch.dict(os.environ, {"HOME": self.dir}):
      result = self._validate({"output": "~/out"})
    self.assertTrue(result["ok"], result["errors"])
    self.assertIn("--output=" + os.path.join(self.dir, "out"), result["argv"])

  def test_structural_errors_skip_path_checks(self):
    result = self._validate({"debug": "yes",
                             "hubble": {"mode": "apk", "path": "/nope.apk"}})
    self.assertEqual(result["errors"], {"debug": "Must be true or false."})
    self.assertEqual(result["argv"], [])


if __name__ == "__main__":
  unittest.main()
