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
"""Tests for results.py: which result files may be served."""

import os
import tempfile
import unittest
from unittest import mock

import _support  # noqa: F401  (sets sys.path)
import results


class LoadResultsTest(unittest.TestCase):

  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.base = os.path.realpath(tmp.name)
    self.root = os.path.join(self.base, "out", "results")
    self.results_dir = os.path.join(self.root, "google", "fp", "000")
    self.artifacts = os.path.join(self.results_dir, "results")
    os.makedirs(self.artifacts)
    os.makedirs(os.path.join(self.results_dir, "selinux"))
    os.makedirs(os.path.join(self.results_dir, "apks"))

  def _write(self, path, text="{}"):
    with open(path, "w") as f:
      f.write(text)

  def test_serves_only_allow_listed_artifacts(self):
    for name in ("packages.txt", "build.txt",
                 "packages_with_inclusion_proof_signal.txt"):
      self._write(os.path.join(self.artifacts, name), name)
    self._write(os.path.join(self.artifacts, "notes.txt"))
    self._write(os.path.join(self.artifacts, "secret.apk"))
    self._write(os.path.join(self.results_dir, "selinux", "plat_sepolicy.cil"))
    self._write(os.path.join(self.results_dir, "apks", "base.apk"))

    body = results.load_results(self.results_dir, self.root)

    self.assertEqual(body["dir"], self.results_dir)
    self.assertEqual(
        {f["name"]: f["text"] for f in body["files"]},
        {"packages.txt": "packages.txt", "build.txt": "build.txt",
         "packages_with_inclusion_proof_signal.txt":
             "packages_with_inclusion_proof_signal.txt"})
    self.assertEqual(body["skipped"], [])

  def test_symlinked_artifact_is_skipped(self):
    outside = os.path.join(self.base, "passwd")
    self._write(outside, "root:x:0:0")
    os.symlink(outside, os.path.join(self.artifacts, "packages.txt"))
    body = results.load_results(self.results_dir, self.root)
    self.assertEqual(body["files"], [])
    self.assertEqual(body["skipped"], [{"name": "packages.txt",
                                        "reason": "symlink"}])

  def test_symlinked_results_directory_is_rejected(self):
    elsewhere = os.path.join(self.base, "elsewhere")
    os.makedirs(elsewhere)
    self._write(os.path.join(elsewhere, "packages.txt"))
    other = os.path.join(self.root, "google", "fp", "001")
    os.makedirs(other)
    os.symlink(elsewhere, os.path.join(other, "results"))
    with self.assertRaises(results.ResultsError) as cm:
      results.load_results(other, self.root)
    self.assertEqual(cm.exception.reason, "no_results")

  def test_directory_outside_the_run_output_is_rejected(self):
    # Results from another run, or another session, live elsewhere.
    other_root = os.path.join(self.base, "other", "results")
    other_dir = os.path.join(other_root, "google", "fp", "000")
    os.makedirs(os.path.join(other_dir, "results"))
    with self.assertRaises(results.ResultsError) as cm:
      results.load_results(other_dir, self.root)
    self.assertEqual(cm.exception.reason, "outside_output")

  def test_dot_dot_escape_is_rejected(self):
    escape = os.path.join(self.root, "..", "..", "..")
    with self.assertRaises(results.ResultsError) as cm:
      results.load_results(escape, self.root)
    self.assertEqual(cm.exception.reason, "outside_output")

  def test_symlink_escape_is_rejected(self):
    outside = os.path.join(self.base, "outside")
    os.makedirs(os.path.join(outside, "results"))
    link = os.path.join(self.root, "google", "link")
    os.symlink(outside, link)
    with self.assertRaises(results.ResultsError) as cm:
      results.load_results(link, self.root)
    self.assertEqual(cm.exception.reason, "outside_output")

  def test_missing_results_subdirectory(self):
    empty = os.path.join(self.root, "google", "fp", "002")
    os.makedirs(empty)
    with self.assertRaises(results.ResultsError) as cm:
      results.load_results(empty, self.root)
    self.assertEqual(cm.exception.reason, "no_results")

  def test_oversized_file_is_skipped(self):
    self._write(os.path.join(self.artifacts, "packages.txt"), "x" * 20)
    self._write(os.path.join(self.artifacts, "build.txt"), "ok")
    with mock.patch.object(results, "MAX_FILE_BYTES", 10):
      body = results.load_results(self.results_dir, self.root)
    self.assertEqual([f["name"] for f in body["files"]], ["build.txt"])
    self.assertEqual(body["skipped"], [{"name": "packages.txt",
                                        "reason": "too_large"}])

  def test_invalid_utf8_is_replaced_not_fatal(self):
    with open(os.path.join(self.artifacts, "build.txt"), "wb") as f:
      f.write(b"ok \xff")
    body = results.load_results(self.results_dir, self.root)
    self.assertEqual(body["files"][0]["text"], "ok \ufffd")


if __name__ == "__main__":
  unittest.main()
