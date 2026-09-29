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
"""Runs automate_observation.py and tracks each run from its --events stream.

The run's outcome comes only from the script's events (see "Machine-Readable
Progress" in docs/automate_observation.md), never from its exit code: early
exits still exit 0, and a stream without run_finished means failure.

Everything a run produces is kept as numbered entries, so a browser that
reconnects can ask for what it missed:
  * "event": one JSON event from the script's stdout, verbatim.
  * "log": one line of stderr (or an unexpected stdout line, or a note from
    the helper itself).
  * "state": the run's status snapshot, whenever it changes.
Events and state entries are all kept; log lines are capped.
"""

from __future__ import annotations

import bisect
import collections
import datetime
import heapq
import json
import os
import re
import secrets
import signal
import subprocess
import sys
import threading
from typing import Optional

EVENTS_SCHEMA = 1
DEFAULT_KILL_GRACE_S = 10.0
DEFAULT_LOG_CAP = 50000
MAX_LINE_BYTES = 1024 * 1024
# How long to wait for stdout/stderr to reach EOF once the script has exited.
# A daemon it started (such as the adb server) may inherit the pipes and keep
# them open indefinitely.
PIPE_DRAIN_TIMEOUT_S = 2.0

# automate_observation.py's log format: "LEVEL:file:func(line): message".
LOG_RE = re.compile(
    r"^(DEBUG|INFO|WARNING|ERROR|CRITICAL):([^:\s]+):([\w<>]+)\((\d+)\): ?(.*)$")

# Helper-side error reasons, alongside the script's own (run_finished.error).
REASON_VERSION_MISMATCH = "version_mismatch"
REASON_NO_RESULT = "no_result"
REASON_KILLED = "killed"


class Busy(Exception):
  """Another run is still active."""


class InputNotAllowed(Exception):
  """The run is not waiting for a newline on stdin."""


def _now() -> str:
  now = datetime.datetime.now(datetime.timezone.utc)
  return now.strftime("%Y-%m-%dT%H:%M:%S.") + "{:03d}Z".format(
      now.microsecond // 1000)


def parse_log_line(line: str, source: str) -> dict:
  entry = {"ts": _now(), "source": source, "message": line}
  m = LOG_RE.match(line)
  if m:
    entry.update(level=m.group(1), file=m.group(2), func=m.group(3),
                 line=int(m.group(4)), message=m.group(5))
  return entry


class Run:
  """One invocation of the script. All mutable state is guarded by `cond`."""

  def __init__(self, run_id: str, argv: list, output_root: str,
               log_cap: int = DEFAULT_LOG_CAP):
    self.id = run_id
    self.argv = list(argv)
    self.output_root = output_root
    self.cond = threading.Condition()
    self.proc: Optional[subprocess.Popen] = None
    self.done = False

    self._seq = 0
    self._events: list = []  # (seq, kind, data), never trimmed
    self._logs = collections.deque(maxlen=log_cap)  # (seq, "log", data)

    self.state = "running"
    self.started_at = _now()
    self.finished_at: Optional[str] = None
    self.exit_code: Optional[int] = None
    self.error: Optional[dict] = None
    self.devices: dict = {}  # serial -> {status, model?, resultsDir?, error?}
    self.pending_prompt: Optional[dict] = None
    self.last_prompt_outcome: Optional[str] = None
    self.run_finished: Optional[dict] = None
    self.cancel_requested = False
    self.anomalies = 0
    self._version_mismatch = False

  # --- Entries -------------------------------------------------------------

  def _append(self, kind: str, data: dict) -> None:
    """Records an entry and wakes up streams. Caller holds `cond`."""
    self._seq += 1
    entry = (self._seq, kind, data)
    if kind == "log":
      self._logs.append(entry)
    else:
      self._events.append(entry)
    self.cond.notify_all()

  def _append_state(self) -> None:
    self._append("state", self.snapshot())

  def entries_after(self, last_seq: int) -> list:
    """Entries numbered after `last_seq`, oldest first. Caller holds `cond`.

    Both stores are in sequence order, so this bisects instead of scanning:
    a stream that is keeping up pays O(log n) per wake-up, not O(n). The key
    `(last_seq + 1,)` sorts before any entry with that number and after every
    earlier one, and seqs are unique, so the data dicts are never compared.
    """
    key = (last_seq + 1,)
    events = self._events[bisect.bisect_left(self._events, key):]
    logs = self._logs
    # Indexing a deque is cheap near its ends, which is where a caught-up
    # stream reads.
    start = bisect.bisect_left(logs, key)
    new_logs = [logs[i] for i in range(start, len(logs))]
    if not events:
      return new_logs
    if not new_logs:
      return events
    return list(heapq.merge(events, new_logs))

  def log(self, message: str, level: str = "INFO") -> None:
    """Adds a note from the helper itself to the run's log."""
    with self.cond:
      self._append("log", {"ts": _now(), "source": "helper", "level": level,
                           "message": message})

  def snapshot(self) -> dict:
    """GET /api/runs/:id. Caller holds `cond` (or accepts a torn read)."""
    snap = {
        "id": self.id,
        "state": self.state,
        "argv": self.argv,
        "startedAt": self.started_at,
        "devices": {serial: dict(d) for serial, d in self.devices.items()},
        "anomalies": self.anomalies,
    }
    for key, value in (("finishedAt", self.finished_at),
                       ("exitCode", self.exit_code),
                       ("error", self.error),
                       ("pendingPrompt", self.pending_prompt),
                       ("lastPromptOutcome", self.last_prompt_outcome)):
      if value is not None:
        snap[key] = value
    return snap

  # --- Script output -------------------------------------------------------

  def handle_stdout_line(self, line: str) -> None:
    try:
      event = json.loads(line)
    except ValueError:
      event = None
    with self.cond:
      if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        # With --events -, stdout carries only events. Keep the line, but it
        # does not fail the run.
        self.anomalies += 1
        entry = parse_log_line(line, "stdout")
        entry.update(level="WARNING", anomaly=True)
        self._append("log", entry)
        return
      if self._version_mismatch:
        return
      if event.get("v") != EVENTS_SCHEMA:
        self._version_mismatch = True
        self.error = {
            "reason": REASON_VERSION_MISMATCH,
            "message": "The script speaks events schema v{}; this helper "
                       "understands v{}. Update the helper and the script "
                       "together.".format(event.get("v"), EVENTS_SCHEMA)}
        self._append("event", event)
        self._kill(signal.SIGKILL)
        self._append_state()
        return
      changed = self._apply_event(event)
      self._append("event", event)
      if changed:
        self._append_state()

  def _apply_event(self, event: dict) -> bool:
    """Updates the run from one event. Returns whether the snapshot changed.

    Unknown event types and fields are ignored, as the schema allows new ones
    without a version bump.
    """
    kind = event["type"]
    device = event.get("device")
    if kind == "devices":
      info = {d.get("serial"): d for d in event.get("devices") or []
              if isinstance(d, dict)}
      for serial in list(event.get("selected") or []) + list(
          event.get("missing") or []):
        entry = self.devices.setdefault(serial, {"status": "pending"})
        model = (info.get(serial) or {}).get("model")
        if model:
          entry["model"] = model
      return True
    if kind == "device_started" and device:
      self.devices.setdefault(device, {})["status"] = "running"
      return True
    if kind == "prompt":
      self.pending_prompt = {
          "device": device, "kind": event.get("kind"),
          "message": event.get("message"),
          "expectsInput": bool(event.get("expects_input"))}
      self.last_prompt_outcome = None
      return True
    if kind == "prompt_resolved":
      pending = self.pending_prompt
      if pending and pending["device"] == device and \
          pending["kind"] == event.get("kind"):
        self.pending_prompt = None
      self.last_prompt_outcome = event.get("outcome")
      return True
    if kind == "device_finished" and device:
      entry = self.devices.setdefault(device, {})
      entry["status"] = event.get("status")
      if event.get("results_dir"):
        entry["resultsDir"] = event["results_dir"]
      if event.get("error"):
        entry["error"] = event["error"]
      return True
    if kind == "run_finished":
      self.run_finished = event
      return False  # the outcome is settled when the process exits
    return False

  def handle_stderr_line(self, line: str) -> None:
    with self.cond:
      self._append("log", parse_log_line(line, "stderr"))

  def finish(self, returncode: int) -> None:
    """Settles the outcome once the script has exited."""
    with self.cond:
      self.exit_code = returncode
      self.finished_at = _now()
      self.pending_prompt = None
      finished = self.run_finished
      if self._version_mismatch:
        self.state = "failed"
      elif finished is not None:
        error = finished.get("error")
        if finished.get("ok") is True:
          self.state = "succeeded"
        elif self.cancel_requested and (error or {}).get("reason") == "terminated":
          self.state = "cancelled"
        else:
          self.state = "failed"
        self.error = error
      elif self.cancel_requested:
        self.state = "cancelled"
        self.error = {"reason": REASON_KILLED,
                      "message": "The script did not stop when asked and was "
                                 "killed, so it could not report a result. "
                                 "Check the device: Hubble may still be "
                                 "installed."}
      else:
        self.state = "failed"
        self.error = {"reason": REASON_NO_RESULT,
                      "message": "The script ended without reporting a result "
                                 "(exit code {}).".format(returncode)}
      self.done = True
      self._append_state()

  # --- Control ---------------------------------------------------------------

  def _kill(self, sig: int) -> None:
    """Signals the script's whole process group (adb, gradlew, ...)."""
    if self.proc is None or self.proc.poll() is not None:
      return
    try:
      os.killpg(self.proc.pid, sig)
    except (ProcessLookupError, PermissionError):
      pass

  def send_newline(self) -> None:
    """Answers a pending prompt that expects input.

    Raises:
      InputNotAllowed: nothing is waiting for input.
    """
    with self.cond:
      prompt = self.pending_prompt
      if self.done or not prompt or not prompt["expectsInput"]:
        raise InputNotAllowed("The run is not waiting for input.")
      try:
        self.proc.stdin.write(b"\n")
        self.proc.stdin.flush()
      except (BrokenPipeError, OSError, ValueError):
        raise InputNotAllowed("The script is no longer reading input.")
      self._append("log", {"ts": _now(), "source": "helper", "level": "INFO",
                           "message": "Sent a newline to answer {}.".format(
                               prompt["kind"])})

  def cancel(self, grace_s: float) -> bool:
    """Asks the script to stop: SIGTERM now, SIGKILL after `grace_s`.

    With --events, the script reports run_finished (reason "terminated")
    before it dies, so the browser still gets a final summary.

    Returns:
      False if the run had already finished.
    """
    with self.cond:
      if self.done:
        return False
      if self.cancel_requested:
        return True
      self.cancel_requested = True
      self._append("log", {"ts": _now(), "source": "helper", "level": "INFO",
                           "message": "Cancel requested: sent SIGTERM."})
      self._kill(signal.SIGTERM)

    def escalate():
      try:
        self.proc.wait(timeout=grace_s)
      except subprocess.TimeoutExpired:
        with self.cond:
          self._append("log", {
              "ts": _now(), "source": "helper", "level": "WARNING",
              "message": "The script did not stop within {:g} s: sent "
                         "SIGKILL.".format(grace_s)})
          self._kill(signal.SIGKILL)

    threading.Thread(target=escalate, name="cancel-" + self.id,
                     daemon=True).start()
    return True


class RunManager:
  """Starts runs, one at a time, and keeps them for the helper's lifetime."""

  def __init__(self, script: str, python: str = sys.executable,
               kill_grace_s: float = DEFAULT_KILL_GRACE_S,
               log_cap: int = DEFAULT_LOG_CAP, env: Optional[dict] = None):
    self.script = script
    self.python = python
    self.kill_grace_s = kill_grace_s
    self.log_cap = log_cap
    self.env = env
    self._lock = threading.Lock()
    self._runs: dict = {}  # id -> Run, in start order
    self._active: Optional[Run] = None

  def get(self, run_id: str) -> Optional[Run]:
    with self._lock:
      return self._runs.get(run_id)

  def list(self) -> list:
    with self._lock:
      runs = list(self._runs.values())
    return [{"id": r.id, "state": r.state, "startedAt": r.started_at}
            for r in runs]

  def active(self) -> Optional[Run]:
    with self._lock:
      if self._active is not None and self._active.done:
        self._active = None
      return self._active

  def start(self, argv: list, output_root: str) -> Run:
    """Spawns the script with `argv` plus `--events -`.

    Raises:
      Busy: another run is still active.
      OSError: the script could not be started.
    """
    with self._lock:
      if self._active is not None and not self._active.done:
        raise Busy()
      run = Run(secrets.token_hex(8), argv, output_root, self.log_cap)
      env = dict(os.environ if self.env is None else self.env)
      env["PYTHONUNBUFFERED"] = "1"
      run.proc = subprocess.Popen(
          [self.python, self.script, *argv, "--events", "-"],
          stdin=subprocess.PIPE, stdout=subprocess.PIPE,
          stderr=subprocess.PIPE, cwd=os.path.dirname(self.script),
          env=env, start_new_session=True, close_fds=True)
      self._runs[run.id] = run
      self._active = run
    with run.cond:
      run._append_state()
    self._pump(run)
    return run

  def _pump(self, run: Run) -> None:
    def read(stream, handle):
      # Each reader closes its own stream at EOF, which may come long after
      # the script exits if a daemon it started inherited the pipe.
      with stream:
        for raw in iter(lambda: stream.readline(MAX_LINE_BYTES), b""):
          handle(raw.decode("utf-8", errors="replace").rstrip("\r\n"))

    readers = [
        threading.Thread(target=read, args=(run.proc.stdout,
                                            run.handle_stdout_line),
                         name="stdout-" + run.id, daemon=True),
        threading.Thread(target=read, args=(run.proc.stderr,
                                            run.handle_stderr_line),
                         name="stderr-" + run.id, daemon=True),
    ]
    for t in readers:
      t.start()

    def wait():
      returncode = run.proc.wait()
      for t in readers:
        t.join(timeout=PIPE_DRAIN_TIMEOUT_S)
      try:
        run.proc.stdin.close()
      except OSError:
        pass
      run.finish(returncode)

    threading.Thread(target=wait, name="wait-" + run.id, daemon=True).start()

  def shutdown(self, timeout_s: float = 5.0) -> None:
    """Stops the active run, if any, so no script outlives the helper.

    The script runs in its own session, so Ctrl-C on the helper's terminal
    does not reach it.
    """
    run = self.active()
    if run is None:
      return
    run.cancel(min(self.kill_grace_s, timeout_s))
    try:
      run.proc.wait(timeout=timeout_s + 1)
    except subprocess.TimeoutExpired:
      run._kill(signal.SIGKILL)
