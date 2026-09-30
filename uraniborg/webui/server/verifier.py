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
"""Builds the inclusion proof verifier (verifier_tools/verify) for the UI.

The build is one fixed command, `go build -o <tools dir>/verifier
./cmd/verifier`, run in the verifier's source directory. Nothing from a
request reaches it. The binary goes to the helper's own cache directory,
outside the source tree, so a build never leaves files in the checkout.
"""

from __future__ import annotations

import datetime
import os
import re
import shutil
import subprocess
import sys
import threading
from typing import Optional

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_DIR = os.path.normpath(os.path.join(HERE, "..", "..", ".."))
DEFAULT_SOURCE = os.path.join(REPO_DIR, "verifier_tools", "verify")
BINARY_NAME = "verifier"
BUILD_TIMEOUT_S = 15 * 60
GO_VERSION_TIMEOUT_S = 10
OUTPUT_LINES = 200
# Where Go's installers put it, for a helper started without it on PATH.
GO_FALLBACKS = ("/usr/local/go/bin/go", "/opt/homebrew/bin/go",
                "/usr/lib/go/bin/go")

STATE_IDLE = "idle"
STATE_RUNNING = "running"
STATE_SUCCEEDED = "succeeded"
STATE_FAILED = "failed"


class BuildError(Exception):
  """Why a build could not start: `reason` is an API error code."""

  def __init__(self, reason: str, message: str):
    super().__init__(message)
    self.reason = reason
    self.message = message


def default_tools_dir() -> str:
  """The per-user cache directory for tools the helper builds."""
  if sys.platform == "darwin":
    base = os.path.expanduser("~/Library/Caches")
  else:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache")
  return os.path.join(base, "uraniborg-helper")


def _now() -> str:
  now = datetime.datetime.now(datetime.timezone.utc)
  return now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)


def _version_tuple(text: Optional[str]) -> Optional[tuple]:
  m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text or "")
  return tuple(int(g or 0) for g in m.groups()) if m else None


class VerifierBuilder:
  """Reports whether the verifier is built, and builds it on request."""

  def __init__(self, source: str = DEFAULT_SOURCE,
               tools_dir: Optional[str] = None, go: Optional[str] = None,
               env: Optional[dict] = None):
    self.source = os.path.abspath(source)
    self.tools_dir = os.path.abspath(tools_dir or default_tools_dir())
    self._go = go
    self._env = env
    self._lock = threading.Lock()
    self._state = STATE_IDLE
    self._output: list = []
    self._started_at: Optional[str] = None
    self._finished_at: Optional[str] = None
    self._error: Optional[str] = None
    self._proc: Optional[subprocess.Popen] = None
    self._versions: dict = {}

  @property
  def binary(self) -> str:
    return os.path.join(self.tools_dir, BINARY_NAME)

  @property
  def go(self) -> Optional[str]:
    if self._go:
      return self._go
    found = shutil.which("go")
    if found:
      return found
    for candidate in GO_FALLBACKS:
      if os.access(candidate, os.X_OK):
        return candidate
    return None

  def source_found(self) -> bool:
    return os.path.isfile(os.path.join(self.source, "go.mod")) and os.path.isdir(
        os.path.join(self.source, "cmd", "verifier"))

  def go_required(self) -> Optional[str]:
    """The `go` directive of the verifier's go.mod, e.g. "1.25.0"."""
    try:
      with open(os.path.join(self.source, "go.mod"), encoding="utf-8") as f:
        for line in f:
          m = re.match(r"\s*go\s+(\d+\.\d+(?:\.\d+)?)\s*$", line)
          if m:
            return m.group(1)
    except OSError:
      pass
    return None

  def go_version(self, go: str) -> Optional[str]:
    """`go env GOVERSION`, e.g. "go1.26.4"; cached per go binary."""
    if go not in self._versions:
      try:
        proc = subprocess.run([go, "env", "GOVERSION"], capture_output=True,
                              text=True, timeout=GO_VERSION_TIMEOUT_S,
                              check=False, env=self._env)
        out = proc.stdout.strip()
        self._versions[go] = out if proc.returncode == 0 and out else None
      except (OSError, subprocess.TimeoutExpired):
        self._versions[go] = None
    return self._versions[go]

  def status(self) -> dict:
    go = self.go
    body = {
        "sourceDir": self.source,
        "sourceFound": self.source_found(),
        "binary": self.binary,
        "built": os.path.isfile(self.binary) and os.access(self.binary, os.X_OK),
    }
    required = self.go_required()
    if required:
      body["goRequired"] = required
    if go:
      body["go"] = go
      version = self.go_version(go)
      if version:
        body["goVersion"] = version
        have, need = _version_tuple(version), _version_tuple(required)
        if have and need:
          body["goOutdated"] = have < need
    with self._lock:
      build = {"state": self._state, "output": list(self._output)}
      for key, value in (("startedAt", self._started_at),
                         ("finishedAt", self._finished_at),
                         ("error", self._error)):
        if value is not None:
          build[key] = value
    body["build"] = build
    return body

  def start(self) -> None:
    """Starts a build in the background. Raises BuildError if it cannot."""
    go = self.go
    if not self.source_found():
      raise BuildError("source_not_found",
                       "The verifier source was not found at %s." % self.source)
    if not go:
      raise BuildError("go_not_found",
                       "Go is not installed or not on PATH. Install Go, then "
                       "restart the helper.")
    with self._lock:
      if self._state == STATE_RUNNING:
        raise BuildError("busy", "The verifier is already being built.")
      self._state = STATE_RUNNING
      self._output = []
      self._started_at = _now()
      self._finished_at = None
      self._error = None
    threading.Thread(target=self._build, args=(go,), daemon=True).start()

  def _append(self, line: str) -> None:
    with self._lock:
      self._output.append(line)
      del self._output[:-OUTPUT_LINES]

  def _finish(self, error: Optional[str]) -> None:
    with self._lock:
      self._state = STATE_FAILED if error else STATE_SUCCEEDED
      self._error = error
      self._finished_at = _now()
      self._proc = None

  def _build(self, go: str) -> None:
    tmp = "%s.tmp-%d" % (self.binary, os.getpid())
    try:
      os.makedirs(self.tools_dir, exist_ok=True)
      argv = [go, "build", "-o", tmp, "./cmd/verifier"]
      self._append("$ " + " ".join(argv))
      proc = subprocess.Popen(argv, cwd=self.source, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                              text=True, errors="replace", env=self._env)
      with self._lock:
        self._proc = proc
      timer = threading.Timer(BUILD_TIMEOUT_S, proc.kill)
      timer.daemon = True
      timer.start()
      try:
        for line in proc.stdout:
          self._append(line.rstrip("\n"))
        code = proc.wait()
      finally:
        timer.cancel()
        proc.stdout.close()
      if code != 0:
        self._finish("go build failed (exit code %d)." % code)
        return
      if not os.path.isfile(tmp):
        self._finish("go build reported success but wrote no binary.")
        return
      os.replace(tmp, self.binary)
      self._append("Built %s" % self.binary)
      self._finish(None)
    except OSError as e:
      self._finish("Could not run go build: %s" % e)
    except Exception as e:  # pylint: disable=broad-except
      self._finish("Unexpected error: %s" % e)
    finally:
      if os.path.exists(tmp):
        try:
          os.remove(tmp)
        except OSError:
          pass

  def shutdown(self) -> None:
    """Stops a build still running (the helper is exiting)."""
    with self._lock:
      proc = self._proc
    if proc and proc.poll() is None:
      proc.kill()
