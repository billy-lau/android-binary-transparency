#!/usr/bin/env python3
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
"""Read-only access to the Hubble artifacts a run produced.

Only a fixed list of text artifacts is ever read, and only from a results
directory that a run in this helper session reported, inside that run's own
output directory. APKs, SELinux files and anything else are never served.
"""

from __future__ import annotations

import os

# What Analyze can load (see src/analyze/lib/parse.ts), in the layout that
# automate_observation.py writes: <results_dir>/results/<name>.
ARTIFACTS = (
    "packages.txt",
    "preinstalled_packages.txt",
    "certificates.txt",
    "build.txt",
    "hardware.txt",
    "device_properties.txt",
    "binaries.txt",
    "libraries.txt",
    "packages_with_inclusion_proof_signal.txt",
    "preinstalled_packages_with_inclusion_proof_signal.txt",
)
MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024


class ResultsError(Exception):
  """The results cannot be served. `reason` is a stable code."""

  def __init__(self, reason: str, message: str):
    super().__init__(message)
    self.reason = reason
    self.message = message


def _inside(path: str, root: str) -> bool:
  return os.path.commonpath([path, root]) == root


def load_results(results_dir: str, output_root: str) -> dict:
  """Reads the allow-listed artifacts of one device's results.

  Args:
    results_dir: device_finished.results_dir, as reported by the run.
    output_root: the results directory the run was told to write into
      (options.results_root() of its --output).

  Returns:
    {dir, files: [{name, text}], skipped: [{name, reason}]}. `files` has the
    InputFile[] shape that the Analyze store's loadFiles() takes.

  Raises:
    ResultsError: the directory is outside the run's output, or unreadable.
  """
  real_root = os.path.realpath(output_root)
  real_dir = os.path.realpath(results_dir)
  if not _inside(real_dir, real_root):
    raise ResultsError("outside_output",
                       "The reported results directory is outside the run's "
                       "output directory.")
  artifacts_dir = os.path.join(real_dir, "results")
  if (os.path.islink(artifacts_dir) or not os.path.isdir(artifacts_dir)):
    raise ResultsError("no_results", "No results directory at {}.".format(
        artifacts_dir))

  files, skipped = [], []
  total = 0
  for name in ARTIFACTS:
    path = os.path.join(artifacts_dir, name)
    if os.path.islink(path):
      skipped.append({"name": name, "reason": "symlink"})
      continue
    if not os.path.isfile(path):
      continue
    size = os.path.getsize(path)
    if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_BYTES:
      skipped.append({"name": name, "reason": "too_large"})
      continue
    total += size
    with open(path, encoding="utf-8", errors="replace") as f:
      files.append({"name": name, "text": f.read()})
  return {"dir": results_dir, "files": files, "skipped": skipped}
