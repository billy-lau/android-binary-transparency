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
"""Directory listings for the UI's path picker.

A browser never reveals a picked file's real path, so the Browse dialog asks
the helper instead. Only names and kinds are returned: never file contents,
sizes or times. Anyone holding the token can already run adb and the script,
so this adds little, but it is still read-only and one directory at a time.
"""

from __future__ import annotations

import os
import stat
from typing import Optional

MAX_ENTRIES = 5000


class ListError(Exception):
  """`status` and `reason` are what the API answers."""

  def __init__(self, status: int, reason: str, message: str):
    super().__init__(message)
    self.status = status
    self.reason = reason
    self.message = message


def _entry(directory: str, name: str) -> dict:
  full = os.path.join(directory, name)
  try:
    mode = os.stat(full).st_mode  # follows symlinks, like the script will
  except OSError:
    mode = None  # a dangling link, or no permission to look
  is_dir = mode is not None and stat.S_ISDIR(mode)
  entry = {"name": name, "dir": is_dir}
  if mode is not None and not is_dir and os.access(full, os.X_OK):
    entry["exec"] = True
  if os.path.islink(full):
    entry["link"] = True
  return entry


def list_dir(path: Optional[str]) -> dict:
  """Lists the directory nearest to `path`.

  `path` may be a directory, a file (its directory is listed and the file
  is reported as `selected`), or a path that does not exist yet, such as a
  new output directory (its closest existing parent is listed). Empty means
  the home directory. A leading `~` is expanded, as it is for the options.
  """
  home = os.path.expanduser("~")
  requested = os.path.expanduser(path) if path else home
  if not os.path.isabs(requested):
    raise ListError(400, "not_absolute", "Use an absolute path.")
  if "\0" in requested:
    raise ListError(400, "bad_path", "Not a valid path.")
  requested = os.path.normpath(requested)

  directory = requested
  selected = None
  if os.path.exists(directory) and not os.path.isdir(directory):
    selected = os.path.basename(directory)
    directory = os.path.dirname(directory)
  while not os.path.isdir(directory):
    parent = os.path.dirname(directory)
    if parent == directory:
      break
    directory = parent
  # The part of the request that does not exist yet (e.g. "run1" of a new
  # output directory), so a picker can keep it rather than pick the parent.
  missing = None
  if selected is None and directory != requested:
    missing = os.path.relpath(requested, directory)

  try:
    names = os.listdir(directory)
  except PermissionError:
    raise ListError(403, "permission_denied",
                    "No permission to list %s." % directory) from None
  except OSError as e:
    raise ListError(404, "not_found",
                    "Cannot list %s: %s" % (directory, e.strerror)) from None

  entries = [_entry(directory, name) for name in names]
  entries.sort(key=lambda e: (not e["dir"], e["name"].casefold(), e["name"]))
  body = {
      "path": directory,
      "home": home,
      "entries": entries[:MAX_ENTRIES],
  }
  parent = os.path.dirname(directory)
  if parent != directory:
    body["parent"] = parent
  if selected:
    body["selected"] = selected
  if missing:
    body["missing"] = missing
  if len(entries) > MAX_ENTRIES:
    body["truncated"] = True
  return body
