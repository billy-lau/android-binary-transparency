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
"""HTTP helpers for the helper's API tests."""

import http.client
import io
import json
import os
import tempfile
import unittest

import _support
import helper_http

TOKEN = "test-token-0123456789"


class HelperServerTestCase(unittest.TestCase):
  """Starts a real helper on a free port with a temporary dist/."""

  dev_origin = None
  script = _support.FAKE_SCRIPT

  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.tmp = os.path.realpath(tmp.name)
    self.dist = os.path.join(self.tmp, "dist")
    os.makedirs(os.path.join(self.dist, "assets"))
    with open(os.path.join(self.dist, "index.html"), "w") as f:
      f.write("<!doctype html><title>t</title>")
    with open(os.path.join(self.dist, "assets", "app.js"), "w") as f:
      f.write("console.log(1)")
    self.helper = self.make_helper()
    self.server = self.helper.serve_in_thread(0)
    self.addCleanup(self.server.server_close)
    self.addCleanup(self.server.shutdown)
    self.addCleanup(self.helper.runs.shutdown, 2)
    self.port = self.helper.port
    self.host = "127.0.0.1:%d" % self.port

  def make_helper(self):
    return helper_http.Helper(script=self.script, dist=self.dist, token=TOKEN,
                              dev_origin=self.dev_origin,
                              log_stream=self.log)

  @property
  def log(self):
    """The helper's request log, kept in memory so tests stay quiet."""
    if not hasattr(self, "_log"):
      self._log = io.StringIO()
    return self._log

  def request(self, method, path, body=None, headers=None, token=TOKEN,
              host=None, raw_body=None):
    """Returns (status, headers dict with lower-case keys, body bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
    all_headers = {"Host": host or self.host}
    if token is not None:
      all_headers[helper_http.TOKEN_HEADER] = token
    data = raw_body
    if body is not None:
      data = json.dumps(body).encode("utf-8")
      all_headers["Content-Type"] = "application/json"
    all_headers.update(headers or {})
    conn.request(method, path, body=data, headers=all_headers)
    resp = conn.getresponse()
    payload = resp.read()
    result = (resp.status, {k.lower(): v for k, v in resp.getheaders()},
              payload)
    conn.close()
    return result

  def json_request(self, method, path, body=None, **kwargs):
    status, headers, payload = self.request(method, path, body, **kwargs)
    return status, json.loads(payload.decode("utf-8")) if payload else None
