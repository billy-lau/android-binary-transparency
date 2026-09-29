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
"""The helper's security model, tested over real HTTP."""

import unittest

import _support  # noqa: F401  (sets sys.path)
import _http
import helper_http


class TokenTest(_http.HelperServerTestCase):

  def test_missing_token(self):
    status, body = self.json_request("GET", "/api/health", token=None)
    self.assertEqual(status, 401)
    self.assertEqual(body["error"]["reason"], "bad_token")

  def test_wrong_token(self):
    status, _ = self.json_request("GET", "/api/health", token="nope")
    self.assertEqual(status, 401)

  def test_right_token(self):
    status, body = self.json_request("GET", "/api/health")
    self.assertEqual(status, 200)
    self.assertEqual(body["eventsSchema"], 1)

  def test_unknown_endpoints_need_the_token_too(self):
    # Nothing about the API surface is revealed without the token.
    status, _ = self.json_request("GET", "/api/nope", token=None)
    self.assertEqual(status, 401)
    status, _ = self.json_request("GET", "/api/nope")
    self.assertEqual(status, 404)

  def test_query_token_only_works_for_the_stream(self):
    status, _ = self.json_request("GET", "/api/health?token=" + _http.TOKEN,
                                  token=None)
    self.assertEqual(status, 401)
    status, _ = self.json_request(
        "GET", "/api/runs/0123456789abcdef/stream?token=" + _http.TOKEN,
        token=None)
    self.assertEqual(status, 404)  # authorized; the run just does not exist

  def test_static_files_need_no_token(self):
    # The token reaches the page in the URL fragment, which is never sent.
    status, _, body = self.request("GET", "/", token=None)
    self.assertEqual(status, 200)
    self.assertIn(b"<title>t</title>", body)

  def test_generated_tokens_are_long_and_distinct(self):
    a, b = helper_http.Helper(), helper_http.Helper()
    self.assertNotEqual(a.token, b.token)
    self.assertGreaterEqual(len(a.token), 43)  # 32 random bytes, base64url


class HostAndOriginTest(_http.HelperServerTestCase):

  def test_localhost_names_are_accepted(self):
    for host in ("127.0.0.1:%d" % self.port, "localhost:%d" % self.port,
                 "LOCALHOST:%d" % self.port):
      with self.subTest(host):
        status, _ = self.json_request("GET", "/api/health", host=host)
        self.assertEqual(status, 200)

  def test_rebound_host_is_rejected(self):
    for host in ("evil.example:%d" % self.port, "127.0.0.1", "127.0.0.1:1"):
      with self.subTest(host):
        status, body = self.json_request("GET", "/api/health", host=host)
        self.assertEqual(status, 421)
        self.assertEqual(body["error"]["reason"], "bad_host")

  def test_static_files_check_the_host_too(self):
    status, _, _ = self.request("GET", "/", token=None, host="evil.example")
    self.assertEqual(status, 421)

  def test_same_origin_is_accepted(self):
    status, _ = self.json_request(
        "GET", "/api/health", headers={"Origin": "http://" + self.host})
    self.assertEqual(status, 200)

  def test_foreign_origin_is_rejected(self):
    for origin in ("https://evil.example", "http://localhost:5173", "null"):
      with self.subTest(origin):
        status, body = self.json_request("GET", "/api/health",
                                         headers={"Origin": origin})
        self.assertEqual(status, 403)
        self.assertEqual(body["error"]["reason"], "bad_origin")

  def test_preflight_gets_no_cors_headers(self):
    status, headers, _ = self.request(
        "OPTIONS", "/api/runs", token=None,
        headers={"Origin": "https://evil.example",
                 "Access-Control-Request-Method": "POST",
                 "Access-Control-Request-Headers": "x-uraniborg-token"})
    self.assertEqual(status, 403)
    self.assertFalse([h for h in headers if h.startswith("access-control-")])


class DevOriginTest(_http.HelperServerTestCase):
  dev_origin = "http://localhost:5173"

  def test_dev_origin_and_its_host_are_accepted(self):
    status, _ = self.json_request(
        "GET", "/api/health", host="localhost:5173",
        headers={"Origin": "http://localhost:5173"})
    self.assertEqual(status, 200)

  def test_other_origins_are_still_rejected(self):
    status, _ = self.json_request(
        "GET", "/api/health", headers={"Origin": "http://localhost:4173"})
    self.assertEqual(status, 403)


class HeadersTest(_http.HelperServerTestCase):

  def test_every_response_refuses_framing(self):
    for method, path, token in (("GET", "/", None),
                                ("GET", "/api/health", _http.TOKEN),
                                ("GET", "/api/health", None),
                                ("GET", "/missing.js", None)):
      with self.subTest(path=path, token=bool(token)):
        _, headers, _ = self.request(method, path, token=token)
        self.assertEqual(headers["x-frame-options"], "DENY")
        self.assertEqual(headers["content-security-policy"],
                         "frame-ancestors 'none'")
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["referrer-policy"], "no-referrer")

  def test_api_responses_are_not_cached(self):
    _, headers, _ = self.request("GET", "/api/health")
    self.assertEqual(headers["cache-control"], "no-store")
    self.assertTrue(headers["content-type"].startswith("application/json"))

  def test_server_header_does_not_reveal_python(self):
    _, headers, _ = self.request("GET", "/")
    self.assertNotIn("Python", headers.get("server", ""))


class BodyTest(_http.HelperServerTestCase):

  def test_oversized_body(self):
    status, headers, _ = self.request(
        "POST", "/api/validate", raw_body=b"{" + b" " * 70000 + b"}",
        headers={"Content-Type": "application/json"})
    self.assertEqual(status, 413)

  def test_body_must_be_json(self):
    status, _, _ = self.request("POST", "/api/validate", raw_body=b"a=1",
                                headers={"Content-Type":
                                         "application/x-www-form-urlencoded"})
    self.assertEqual(status, 415)

  def test_malformed_json(self):
    status, _, _ = self.request("POST", "/api/validate", raw_body=b"{nope",
                                headers={"Content-Type": "application/json"})
    self.assertEqual(status, 400)

  def test_wrong_method(self):
    status, body = self.json_request("GET", "/api/validate")
    self.assertEqual(status, 405)
    status, _, _ = self.request("POST", "/index.html", token=None,
                                raw_body=b"", headers={})
    self.assertEqual(status, 405)


class StaticTest(_http.HelperServerTestCase):

  def test_serves_assets_with_types(self):
    status, headers, body = self.request("GET", "/assets/app.js", token=None)
    self.assertEqual(status, 200)
    self.assertTrue(headers["content-type"].startswith("text/javascript"))
    self.assertEqual(body, b"console.log(1)")

  def test_traversal_is_refused(self):
    for path in ("/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd",
                 "/assets/../../dist-secret"):
      with self.subTest(path):
        status, _, _ = self.request("GET", path, token=None)
        self.assertEqual(status, 404)

  def test_symlink_out_of_dist_is_refused(self):
    import os  # pylint: disable=import-outside-toplevel
    secret = os.path.join(self.tmp, "secret.txt")
    with open(secret, "w") as f:
      f.write("secret")
    os.symlink(secret, os.path.join(self.dist, "leak.txt"))
    status, _, body = self.request("GET", "/leak.txt", token=None)
    self.assertEqual(status, 404)
    self.assertNotIn(b"secret", body)


class LoggingTest(_http.HelperServerTestCase):

  def test_token_never_reaches_the_log(self):
    self.request("GET", "/api/runs/0123456789abcdef/stream?token="
                 + _http.TOKEN, token=None)
    self.request("GET", "/api/health?token=" + _http.TOKEN, token=None)
    self.assertIn("token=<redacted>", self.log.getvalue())
    self.assertNotIn(_http.TOKEN, self.log.getvalue())


if __name__ == "__main__":
  unittest.main()
