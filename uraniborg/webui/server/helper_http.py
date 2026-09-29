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
"""HTTP side of the helper: the built UI plus a small JSON API under /api.

Both come from the same 127.0.0.1 origin, so the UI's existing
`connect-src 'self'` CSP already allows the API and no CORS is involved.
Security model (see server/README.md):
  * bound to 127.0.0.1 only;
  * every /api request needs the per-process token in X-Uraniborg-Token
    (the SSE stream alone takes it as ?token=, because EventSource cannot
    set headers); a custom header also forces a CORS preflight, which is
    refused;
  * Host must name this server (DNS rebinding), and Origin, when sent, must
    be this server or --dev-origin;
  * one run at a time, capped request bodies, no framing.
"""

from __future__ import annotations

import argparse
import hmac
import http.server
import json
import mimetypes
import os
import platform
import re
import secrets
import shutil
import signal
import subprocess
import sys
import threading
import traceback
import urllib.parse
import webbrowser
from typing import Optional

import options as options_mod
import results as results_mod
import runs as runs_mod

HELPER_VERSION = "0.1.0"
DEFAULT_PORT = 8765
MAX_BODY_BYTES = 64 * 1024
ADB_TIMEOUT_S = 10
SSE_HEARTBEAT_S = 15
TOKEN_HEADER = "X-Uraniborg-Token"

HERE = os.path.dirname(os.path.abspath(__file__))
URANIBORG_DIR = os.path.normpath(os.path.join(HERE, "..", ".."))
DEFAULT_SCRIPT = os.path.join(URANIBORG_DIR, "scripts", "python",
                              "automate_observation.py")
DEFAULT_DIST = os.path.normpath(os.path.join(HERE, "..", "dist"))
HUBBLE_LATEST = os.path.join(URANIBORG_DIR, "prebuilts", "APK", "latest")

_RUN = r"([0-9a-f]{16})"
ROUTES = [
    ("GET", re.compile(r"^/api/health$"), "health"),
    ("GET", re.compile(r"^/api/devices$"), "devices"),
    ("POST", re.compile(r"^/api/validate$"), "validate"),
    ("GET", re.compile(r"^/api/runs$"), "list_runs"),
    ("POST", re.compile(r"^/api/runs$"), "start_run"),
    ("GET", re.compile(r"^/api/runs/" + _RUN + r"$"), "get_run"),
    ("GET", re.compile(r"^/api/runs/" + _RUN + r"/stream$"), "stream"),
    ("POST", re.compile(r"^/api/runs/" + _RUN + r"/input$"), "input"),
    ("POST", re.compile(r"^/api/runs/" + _RUN + r"/cancel$"), "cancel"),
    ("GET", re.compile(r"^/api/runs/" + _RUN + r"/results/([^/]+)$"), "results"),
]
STREAM_ROUTE = ROUTES[6][1]

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


def parse_adb_devices(output: str) -> list:
  """Parses `adb devices -l` into [{serial, state, model?, product?, device?}]."""
  devices = []
  for line in output.splitlines():
    line = line.strip()
    if not line or line.startswith("List of devices") or line.startswith("*"):
      continue
    parts = line.split()
    if len(parts) < 2:
      continue
    serial, rest = parts[0], parts[1:]
    if rest[:2] == ["no", "permissions"]:
      # "no permissions (user in plugdev group; ...)": skip the explanation.
      state = "no permissions"
      rest = [p for p in rest if ":" in p and not p.startswith("(")]
    else:
      state, rest = rest[0], rest[1:]
    entry = {"serial": serial, "state": state}
    for part in rest:
      key, sep, value = part.partition(":")
      if sep and key in ("model", "product", "device") and value:
        entry[key] = value
    devices.append(entry)
  return devices


class Helper:
  """Configuration and shared state behind the HTTP handler."""

  def __init__(self, script: str = DEFAULT_SCRIPT, dist: str = DEFAULT_DIST,
               token: Optional[str] = None, dev_origin: Optional[str] = None,
               run_manager: Optional[runs_mod.RunManager] = None,
               adb: Optional[str] = None, log_stream=None):
    self.script = os.path.abspath(script)
    self.dist = os.path.abspath(dist)
    self.token = token or secrets.token_urlsafe(32)
    self.dev_origin = dev_origin.rstrip("/") if dev_origin else None
    self.runs = run_manager or runs_mod.RunManager(self.script)
    self._adb = adb
    # None means sys.stderr, looked up when writing.
    self.log_stream = log_stream
    self.port: Optional[int] = None
    self.allowed_hosts: set = set()
    self.allowed_origins: set = set()

  @property
  def adb(self) -> Optional[str]:
    return self._adb or shutil.which("adb")

  @property
  def default_output(self) -> str:
    # Where the script writes when run from its own directory, as the helper
    # does. Always passed explicitly, so a copied command matches.
    return os.path.join(os.path.dirname(self.script), "results")

  def bind(self, port: int) -> http.server.ThreadingHTTPServer:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.helper = self
    self.port = server.server_address[1]
    self.allowed_hosts = {"127.0.0.1:%d" % self.port,
                          "localhost:%d" % self.port}
    self.allowed_origins = {"http://" + h for h in self.allowed_hosts}
    if self.dev_origin:
      self.allowed_origins.add(self.dev_origin)
      # The Vite proxy forwards the browser's Host unchanged.
      self.allowed_hosts.add(urllib.parse.urlsplit(self.dev_origin).netloc)
    return server

  def serve_in_thread(self, port: int = 0) -> http.server.ThreadingHTTPServer:
    """Starts serving in the background (for tests). Returns the server."""
    server = self.bind(port)
    # A short poll interval keeps server.shutdown() quick.
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05},
                     daemon=True).start()
    return server

  def health(self) -> dict:
    defaults = {
        "output": self.default_output,
        "prefetchConcurrency": options_mod.DEFAULT_PREFETCH_CONCURRENCY,
        "prefetchTimeout": options_mod.DEFAULT_PREFETCH_TIMEOUT,
    }
    if os.path.exists(HUBBLE_LATEST):
      defaults["hubbleLatest"] = HUBBLE_LATEST
    active = self.runs.active()
    body = {
        "helperVersion": HELPER_VERSION,
        "eventsSchema": runs_mod.EVENTS_SCHEMA,
        "scriptPath": self.script,
        "scriptFound": os.path.isfile(self.script),
        "python": platform.python_version(),
        "platform": sys.platform,
        "defaults": defaults,
    }
    if self.adb:
      body["adbPath"] = self.adb
    if active:
      body["activeRun"] = active.id
    return body


class Handler(http.server.BaseHTTPRequestHandler):
  server_version = "UraniborgHelper/" + HELPER_VERSION
  sys_version = ""
  protocol_version = "HTTP/1.0"

  @property
  def helper(self) -> Helper:
    return self.server.helper

  # --- Plumbing --------------------------------------------------------------

  def log_request(self, code="-", size="-"):
    # Successful GETs (static files, polling, streams) are routine noise.
    if self.command != "GET" or (isinstance(code, int) and code >= 400):
      super().log_request(code, size)

  def log_message(self, fmt, *args):
    # The stream URL carries the token; never write it anywhere.
    message = re.sub(r"token=[^&\s\"]*", "token=<redacted>", fmt % args)
    (self.helper.log_stream or sys.stderr).write("helper: %s\n" % message)

  def end_headers(self):
    self._headers_sent = True
    self.send_header("X-Frame-Options", "DENY")
    self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
    self.send_header("X-Content-Type-Options", "nosniff")
    self.send_header("Referrer-Policy", "no-referrer")
    super().end_headers()

  def _send(self, status: int, body: bytes, content_type: str,
            extra: Optional[dict] = None) -> None:
    self.send_response(status)
    self.send_header("Content-Type", content_type)
    self.send_header("Content-Length", str(len(body)))
    for key, value in (extra or {}).items():
      self.send_header(key, value)
    self.end_headers()
    if self.command != "HEAD":
      self.wfile.write(body)

  def _json(self, status: int, body) -> None:
    self._send(status, json.dumps(body).encode("utf-8"),
               "application/json; charset=utf-8",
               {"Cache-Control": "no-store"})

  def _error(self, status: int, reason: str, message: str, **extra) -> None:
    body = {"error": {"reason": reason, "message": message}}
    body.update(extra)
    self._json(status, body)

  def _read_json(self):
    """The request body as JSON, or None after sending an error response."""
    content_type = (self.headers.get("Content-Type") or "").split(";")[0]
    if content_type.strip().lower() != "application/json":
      self._error(415, "unsupported_media_type",
                  "Send the body as application/json.")
      return None
    try:
      length = int(self.headers.get("Content-Length") or 0)
    except ValueError:
      length = -1
    if length < 0:
      self._error(400, "bad_request", "Invalid Content-Length.")
      return None
    if length > MAX_BODY_BYTES:
      self._error(413, "body_too_large",
                  "Request bodies are limited to %d bytes." % MAX_BODY_BYTES)
      return None
    raw = self.rfile.read(length) if length else b"{}"
    try:
      return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
      self._error(400, "bad_json", "The request body is not valid JSON.")
      return None

  # --- Dispatch --------------------------------------------------------------

  def do_GET(self):
    self._dispatch()

  def do_HEAD(self):
    self._dispatch()

  def do_POST(self):
    self._dispatch()

  def do_OPTIONS(self):
    # A CORS preflight: answer without any Access-Control-Allow-* header, so
    # the browser refuses the cross-origin request it was asking about.
    if self._host_ok():
      self._error(403, "cross_origin", "Cross-origin requests are not allowed.")

  def do_PUT(self):
    self._dispatch()

  def do_DELETE(self):
    self._dispatch()

  def _host_ok(self) -> bool:
    host = (self.headers.get("Host") or "").lower()
    if host not in self.helper.allowed_hosts:
      self._error(421, "bad_host", "Unexpected Host header.")
      return False
    return True

  def _dispatch(self):
    try:
      url = urllib.parse.urlsplit(self.path)
      path = url.path
      if not self._host_ok():
        return
      if path == "/api" or path.startswith("/api/"):
        self._dispatch_api(path, urllib.parse.parse_qs(url.query))
      elif self.command in ("GET", "HEAD"):
        self._static(path)
      else:
        self._error(405, "method_not_allowed", "Method not allowed.")
    except (BrokenPipeError, ConnectionResetError):
      pass
    except Exception:  # pylint: disable=broad-except
      # A bug in a handler: log it, and give the UI a usable error instead of
      # a dropped connection. Mid-response (e.g. a stream), just close.
      self.log_message("internal error handling %s %s\n%s", self.command,
                       self.path, traceback.format_exc().rstrip())
      if not getattr(self, "_headers_sent", False):
        try:
          self._error(500, "internal_error",
                      "The helper hit an unexpected error; see its log.")
        except OSError:
          pass

  def _dispatch_api(self, path: str, query: dict) -> None:
    origin = self.headers.get("Origin")
    if origin is not None and origin.rstrip("/") not in self.helper.allowed_origins:
      self._error(403, "bad_origin", "Requests from %s are not allowed." % origin)
      return
    token = self.headers.get(TOKEN_HEADER)
    if token is None and STREAM_ROUTE.match(path) and self.command == "GET":
      token = (query.get("token") or [None])[0]
    if not token or not hmac.compare_digest(token.encode("utf-8"),
                                            self.helper.token.encode("utf-8")):
      self._error(401, "bad_token",
                  "Missing or wrong token. Open the URL the helper printed.")
      return
    path_matched = False
    for method, pattern, name in ROUTES:
      m = pattern.match(path)
      if not m:
        continue
      path_matched = True
      if method == self.command or (method == "GET" and self.command == "HEAD"):
        getattr(self, "api_" + name)(query, *m.groups())
        return
    if path_matched:
      self._error(405, "method_not_allowed", "Method not allowed.")
    else:
      self._error(404, "not_found", "No such endpoint.")

  def _run_or_404(self, run_id: str):
    run = self.helper.runs.get(run_id)
    if run is None:
      self._error(404, "no_such_run", "No such run in this helper session.")
    return run

  # --- API -------------------------------------------------------------------

  def api_health(self, query):
    self._json(200, self.helper.health())

  def api_devices(self, query):
    adb = self.helper.adb
    if not adb:
      self._error(503, "adb_not_found", "adb is not installed or not on PATH.")
      return
    try:
      proc = subprocess.run([adb, "devices", "-l"], capture_output=True,
                            text=True, timeout=ADB_TIMEOUT_S, check=False)
    except subprocess.TimeoutExpired:
      self._error(504, "adb_timeout", "`adb devices` did not answer in %d s."
                  % ADB_TIMEOUT_S)
      return
    except OSError as e:
      self._error(503, "adb_failed", "Could not run adb: %s" % e)
      return
    if proc.returncode != 0:
      self._error(502, "adb_failed", "`adb devices` failed: %s"
                  % (proc.stderr.strip() or "exit code %d" % proc.returncode))
      return
    self._json(200, {"devices": parse_adb_devices(proc.stdout)})

  def api_validate(self, query):
    raw = self._read_json()
    if raw is None:
      return
    result = options_mod.validate(raw, self.helper.default_output)
    result.pop("options")
    self._json(200, result)

  def api_list_runs(self, query):
    self._json(200, {"runs": self.helper.runs.list()})

  def api_start_run(self, query):
    raw = self._read_json()
    if raw is None:
      return
    result = options_mod.validate(raw, self.helper.default_output)
    if not result["ok"]:
      self._error(422, "invalid_options", "Some options are not valid.",
                  errors=result["errors"], warnings=result["warnings"])
      return
    if not os.path.isfile(self.helper.script):
      self._error(503, "script_not_found",
                  "automate_observation.py not found at %s." % self.helper.script)
      return
    output_root = options_mod.results_root(result["options"]["output"])
    try:
      run = self.helper.runs.start(result["argv"], output_root)
    except runs_mod.Busy:
      active = self.helper.runs.active()
      self._error(409, "busy", "Another run is still in progress.",
                  activeRun=active.id if active else None)
      return
    except OSError as e:
      self._error(500, "spawn_failed", "Could not start the script: %s" % e)
      return
    self._json(201, {"id": run.id, "warnings": result["warnings"]})

  def api_get_run(self, query, run_id):
    run = self._run_or_404(run_id)
    if run:
      with run.cond:
        snap = run.snapshot()
      self._json(200, snap)

  def api_input(self, query, run_id):
    run = self._run_or_404(run_id)
    if not run:
      return
    try:
      run.send_newline()
    except runs_mod.InputNotAllowed as e:
      self._error(409, "not_waiting_for_input", str(e))
      return
    self._json(200, {"ok": True})

  def api_cancel(self, query, run_id):
    run = self._run_or_404(run_id)
    if not run:
      return
    if not run.cancel(self.helper.runs.kill_grace_s):
      self._error(409, "not_running", "The run has already finished.")
      return
    self._json(202, {"ok": True})

  def api_results(self, query, run_id, serial):
    run = self._run_or_404(run_id)
    if not run:
      return
    serial = urllib.parse.unquote(serial)
    with run.cond:
      device = dict(run.devices.get(serial) or {})
    if not device.get("resultsDir"):
      self._error(404, "no_results", "This run reported no results for %s."
                  % serial)
      return
    try:
      body = results_mod.load_results(device["resultsDir"], run.output_root)
    except results_mod.ResultsError as e:
      self._error(403 if e.reason == "outside_output" else 404, e.reason,
                  e.message)
      return
    self._json(200, body)

  def api_stream(self, query, run_id):
    """Server-sent events: a state snapshot, then every entry after the last
    one the browser saw (Last-Event-ID, or ?lastEventId= on a fresh page)."""
    run = self._run_or_404(run_id)
    if not run:
      return
    try:
      last = int(self.headers.get("Last-Event-ID")
                 or (query.get("lastEventId") or ["0"])[0])
    except ValueError:
      last = 0
    self.send_response(200)
    self.send_header("Content-Type", "text/event-stream; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("X-Accel-Buffering", "no")
    self.end_headers()
    if self.command == "HEAD":
      return

    def write(chunk: str) -> None:
      self.wfile.write(chunk.encode("utf-8"))
      self.wfile.flush()

    with run.cond:
      snap = run.snapshot()
    write("retry: 2000\n\nevent: state\ndata: %s\n\n" % json.dumps(snap))
    while True:
      with run.cond:
        entries = run.entries_after(last)
        if not entries and not run.done:
          run.cond.wait(timeout=SSE_HEARTBEAT_S)
          entries = run.entries_after(last)
        finished = run.done
      if entries:
        write("".join("id: %d\nevent: %s\ndata: %s\n\n"
                      % (seq, kind, json.dumps(data))
                      for seq, kind, data in entries))
        last = entries[-1][0]
      elif finished:
        # Tells the browser to close; otherwise EventSource reconnects.
        write("event: end\ndata: {}\n\n")
        return
      else:
        write(": ping\n\n")

  # --- Static UI -------------------------------------------------------------

  def _static(self, path: str) -> None:
    dist = os.path.realpath(self.helper.dist)
    index = os.path.join(dist, "index.html")
    if not os.path.isfile(index):
      self._send(503, b"The UI is not built. Run `npm run build` in "
                      b"uraniborg/webui, or use `npm run dev` together with "
                      b"--dev-origin.\n", "text/plain; charset=utf-8")
      return
    rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
    full = os.path.realpath(os.path.join(dist, rel))
    if os.path.commonpath([full, dist]) != dist or not os.path.isfile(full):
      self._send(404, b"Not found.\n", "text/plain; charset=utf-8")
      return
    ext = os.path.splitext(full)[1].lower()
    content_type = (CONTENT_TYPES.get(ext) or mimetypes.guess_type(full)[0]
                    or "application/octet-stream")
    with open(full, "rb") as f:
      body = f.read()
    self._send(200, body, content_type, {"Cache-Control": "no-cache"})


def parse_arguments(argv=None) -> argparse.Namespace:
  parser = argparse.ArgumentParser(
      description="Serves Uraniborg Explorer and lets it run "
                  "automate_observation.py on this computer.",
      formatter_class=argparse.ArgumentDefaultsHelpFormatter)
  parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                      help="Port on 127.0.0.1 to listen on; 0 picks a free one.")
  parser.add_argument("--dist", default=DEFAULT_DIST,
                      help="The built UI (npm run build).")
  parser.add_argument("--script", default=DEFAULT_SCRIPT,
                      help="The automate_observation.py to run.")
  parser.add_argument("--dev-origin", default=None, metavar="ORIGIN",
                      help="Also accept API requests proxied by the Vite dev "
                           "server at ORIGIN, e.g. http://localhost:5173.")
  parser.add_argument("--open", action="store_true",
                      help="Open the UI in the default browser.")
  return parser.parse_args(argv)


def main(argv=None) -> int:
  args = parse_arguments(argv)
  if sys.platform not in ("linux", "darwin"):
    sys.stderr.write("The helper runs automate_observation.py, which supports "
                     "only Linux and macOS.\n")
    return 1
  helper = Helper(script=args.script, dist=args.dist, dev_origin=args.dev_origin)
  try:
    server = helper.bind(args.port)
  except OSError as e:
    sys.stderr.write("Cannot listen on 127.0.0.1:%d: %s\n" % (args.port, e))
    return 1

  url = "http://127.0.0.1:%d/#/?token=%s" % (helper.port, helper.token)
  if not os.path.isfile(os.path.join(helper.dist, "index.html")):
    print("Note: no built UI in %s. Run `npm run build`, or use `npm run dev` "
          "with --dev-origin." % helper.dist)
  if not os.path.isfile(helper.script):
    print("Warning: %s not found; runs will fail. Pass --script." % helper.script)
  print("Uraniborg Explorer: %s" % url)
  if helper.dev_origin:
    print("Dev server:         %s/#/?token=%s" % (helper.dev_origin, helper.token))
  print("Anyone who can see this URL can run adb on your devices; keep it "
        "private. Press Ctrl-C to stop.")
  sys.stdout.flush()
  if args.open:
    webbrowser.open(url)

  def on_sigterm(signum, frame):
    raise KeyboardInterrupt()

  signal.signal(signal.SIGTERM, on_sigterm)
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    print("\nStopping.")
  finally:
    helper.runs.shutdown()
    server.server_close()
  return 0
