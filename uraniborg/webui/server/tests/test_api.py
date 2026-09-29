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
"""End-to-end tests of the helper's JSON API and event stream."""

import http.client
import json
import os
import stat
import sys
import time
import unittest

import _support
import _http
import helper_http
import runs

TIMEOUT_S = 15


def write_fake_adb(directory, stdout, exit_code=0):
  path = os.path.join(directory, "adb")
  with open(path, "w") as f:
    f.write("#!/bin/sh\ncat <<'EOF'\n%sEOF\nexit %d\n" % (stdout, exit_code))
  os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
  return path


class ApiTestCase(_http.HelperServerTestCase):
  """A helper whose runs use fake_automate.py with a chosen scenario."""

  scenario = "success"
  adb = None

  def make_helper(self):
    env = dict(os.environ, FAKE_AUTOMATE_SCENARIO=self.scenario,
               FAKE_AUTOMATE_DELAY="0.01")
    manager = runs.RunManager(self.script, python=sys.executable,
                              kill_grace_s=2, env=env)
    return helper_http.Helper(script=self.script, dist=self.dist,
                              token=_http.TOKEN, run_manager=manager,
                              adb=self.adb, log_stream=self.log)

  @property
  def output(self):
    return os.path.join(self.tmp, "out")

  def start_run(self, options=None):
    options = dict({"output": self.output}, **(options or {}))
    status, body = self.json_request("POST", "/api/runs", options)
    self.assertEqual(status, 201, body)
    return body["id"]

  def get_run(self, run_id):
    status, body = self.json_request("GET", "/api/runs/" + run_id)
    self.assertEqual(status, 200, body)
    return body

  def wait_for(self, run_id, predicate, message):
    deadline = time.monotonic() + TIMEOUT_S
    while time.monotonic() < deadline:
      snap = self.get_run(run_id)
      if predicate(snap):
        return snap
      time.sleep(0.02)
    self.fail("Timed out waiting for " + message)

  def wait_done(self, run_id):
    return self.wait_for(run_id, lambda s: s["state"] not in ("running",),
                         "the run to finish")

  def stream(self, run_id, headers=None, query=""):
    """Reads the whole SSE stream; returns [(id, event, data)]."""
    conn = http.client.HTTPConnection("127.0.0.1", self.port,
                                      timeout=TIMEOUT_S)
    path = "/api/runs/%s/stream?token=%s%s" % (run_id, _http.TOKEN, query)
    conn.request("GET", path, headers=dict({"Host": self.host},
                                           **(headers or {})))
    resp = conn.getresponse()
    self.assertEqual(resp.status, 200)
    self.assertTrue(resp.getheader("Content-Type").startswith(
        "text/event-stream"))
    raw = resp.read().decode("utf-8")
    conn.close()
    messages = []
    for block in raw.split("\n\n"):
      fields = {}
      for line in block.split("\n"):
        if not line or line.startswith(":"):
          continue
        key, _, value = line.partition(": ")
        fields[key] = value
      if "event" in fields:
        messages.append((int(fields["id"]) if "id" in fields else None,
                         fields["event"], json.loads(fields["data"])))
    return messages


# --- Health and validation ----------------------------------------------------


class HealthAndValidateTest(ApiTestCase):

  def test_health(self):
    status, body = self.json_request("GET", "/api/health")
    self.assertEqual(status, 200)
    self.assertEqual(body["helperVersion"], helper_http.HELPER_VERSION)
    self.assertEqual(body["eventsSchema"], 1)
    self.assertTrue(body["scriptFound"])
    self.assertEqual(body["defaults"]["output"],
                     os.path.join(os.path.dirname(_support.FAKE_SCRIPT),
                                  "results"))
    self.assertEqual(body["defaults"]["prefetchConcurrency"], 16)
    self.assertEqual(body["defaults"]["prefetchTimeout"], 600)
    self.assertNotIn("activeRun", body)

  def test_validate_returns_argv(self):
    status, body = self.json_request(
        "POST", "/api/validate",
        {"serials": ["emulator-5554"], "output": self.output})
    self.assertEqual(status, 200)
    self.assertTrue(body["ok"])
    self.assertEqual(body["argv"], ["--serial=emulator-5554",
                                    "--output=" + self.output])
    self.assertNotIn("options", body)

  def test_validate_returns_errors(self):
    status, body = self.json_request("POST", "/api/validate",
                                     {"shell": "rm -rf /"})
    self.assertEqual(status, 200)
    self.assertFalse(body["ok"])
    self.assertIn("shell", body["errors"])

  def test_start_rejects_invalid_options(self):
    status, body = self.json_request("POST", "/api/runs", {"serials": "x"})
    self.assertEqual(status, 422)
    self.assertEqual(body["error"]["reason"], "invalid_options")
    self.assertIn("serials", body["errors"])
    self.assertEqual(self.json_request("GET", "/api/runs")[1]["runs"], [])


class InternalErrorTest(ApiTestCase):

  def test_handler_bug_returns_json_500(self):
    def boom():
      raise RuntimeError("simulated bug")
    self.helper.health = boom
    status, body = self.json_request("GET", "/api/health")
    self.assertEqual(status, 500)
    self.assertEqual(body["error"]["reason"], "internal_error")
    self.assertIn("RuntimeError: simulated bug", self.log.getvalue())
    # The server keeps serving.
    self.helper.health = lambda: {"ok": True}
    self.assertEqual(self.json_request("GET", "/api/health")[0], 200)


class MissingScriptTest(ApiTestCase):

  @property
  def script(self):
    return os.path.join(self.tmp, "missing.py")

  def test_start_needs_the_script(self):
    status, body = self.json_request("POST", "/api/runs",
                                     {"output": self.output})
    self.assertEqual(status, 503)
    self.assertEqual(body["error"]["reason"], "script_not_found")
    self.assertFalse(self.json_request("GET", "/api/health")[1]["scriptFound"])


# --- Runs ---------------------------------------------------------------------


class SuccessfulRunTest(ApiTestCase):

  def test_run_to_completion_and_results(self):
    run_id = self.start_run({"serials": ["FAKE0001"]})
    snap = self.wait_done(run_id)
    self.assertEqual(snap["state"], "succeeded", snap)
    self.assertEqual(snap["exitCode"], 0)
    self.assertEqual(snap["argv"], ["--serial=FAKE0001",
                                    "--output=" + self.output])
    self.assertEqual(snap["devices"]["FAKE0001"]["status"], "success")

    status, body = self.json_request(
        "GET", "/api/runs/%s/results/FAKE0001" % run_id)
    self.assertEqual(status, 200, body)
    names = {f["name"] for f in body["files"]}
    self.assertIn("packages.txt", names)
    self.assertTrue(all(f["text"] for f in body["files"]))

    status, body = self.json_request(
        "GET", "/api/runs/%s/results/OTHER" % run_id)
    self.assertEqual(status, 404)
    self.assertEqual(body["error"]["reason"], "no_results")

    runs_list = self.json_request("GET", "/api/runs")[1]["runs"]
    self.assertEqual([r["id"] for r in runs_list], [run_id])

  def test_stream_replays_and_ends(self):
    run_id = self.start_run()
    self.wait_done(run_id)
    messages = self.stream(run_id)
    self.assertEqual(messages[0][1], "state")
    self.assertEqual(messages[-1][1], "end")
    events = [d for _, kind, d in messages if kind == "event"]
    self.assertEqual(events[0]["type"], "run_started")
    self.assertEqual(events[-1]["type"], "run_finished")
    ids = [i for i, _, _ in messages if i is not None]
    self.assertEqual(ids, sorted(ids))

    # Resuming after an id sends only what came later.
    middle = ids[len(ids) // 2]
    resumed = self.stream(run_id, headers={"Last-Event-ID": str(middle)})
    self.assertEqual([i for i, _, _ in resumed if i is not None],
                     [i for i in ids if i > middle])
    by_query = self.stream(run_id, query="&lastEventId=%d" % middle)
    self.assertEqual([i for i, _, _ in by_query if i is not None],
                     [i for i in ids if i > middle])

  def test_input_without_a_prompt(self):
    run_id = self.start_run()
    self.wait_done(run_id)
    status, body = self.json_request("POST", "/api/runs/%s/input" % run_id, {})
    self.assertEqual(status, 409)
    self.assertEqual(body["error"]["reason"], "not_waiting_for_input")

  def test_cancel_after_finish(self):
    run_id = self.start_run()
    self.wait_done(run_id)
    status, body = self.json_request("POST", "/api/runs/%s/cancel" % run_id, {})
    self.assertEqual(status, 409)
    self.assertEqual(body["error"]["reason"], "not_running")

  def test_unknown_run(self):
    status, body = self.json_request("GET", "/api/runs/0123456789abcdef")
    self.assertEqual(status, 404)
    self.assertEqual(body["error"]["reason"], "no_such_run")


class HangingRunTest(ApiTestCase):

  scenario = "hang"

  def test_busy_then_cancel(self):
    run_id = self.start_run()
    self.assertEqual(self.json_request("GET", "/api/health")[1]["activeRun"],
                     run_id)
    status, body = self.json_request("POST", "/api/runs",
                                     {"output": self.output})
    self.assertEqual(status, 409)
    self.assertEqual(body["error"]["reason"], "busy")
    self.assertEqual(body["activeRun"], run_id)

    status, _ = self.json_request("POST", "/api/runs/%s/cancel" % run_id, {})
    self.assertEqual(status, 202)
    snap = self.wait_done(run_id)
    self.assertEqual(snap["state"], "cancelled", snap)
    self.assertNotIn("activeRun", self.json_request("GET", "/api/health")[1])


class XiaomiRunTest(ApiTestCase):

  scenario = "xiaomi"

  def test_input_answers_the_prompt(self):
    run_id = self.start_run()
    for _ in range(2):  # The fake asks twice, like a slow manual install.
      self.wait_for(run_id, lambda s: s.get("pendingPrompt"), "a prompt")
      status, body = self.json_request(
          "POST", "/api/runs/%s/input" % run_id, {})
      self.assertEqual(status, 200, body)
    snap = self.wait_done(run_id)
    self.assertEqual(snap["state"], "succeeded", snap)


class EarlyExitRunTest(ApiTestCase):

  scenario = "early_exit"

  def test_early_exit_is_a_failure(self):
    snap = self.wait_done(self.start_run())
    self.assertEqual(snap["state"], "failed", snap)
    self.assertEqual(snap["error"]["reason"], "no_devices")


# --- Devices ------------------------------------------------------------------


class DevicesTest(ApiTestCase):

  @property
  def adb(self):
    return write_fake_adb(self.tmp, (
        "List of devices attached\n"
        "emulator-5554          device product:sdk_gphone64_arm64 "
        "model:sdk_gphone64_arm64 device:emu64a transport_id:1\n"
        "R58M123               unauthorized transport_id:2\n"))

  def test_devices(self):
    status, body = self.json_request("GET", "/api/devices")
    self.assertEqual(status, 200, body)
    self.assertEqual(body["devices"], [
        {"serial": "emulator-5554", "state": "device",
         "product": "sdk_gphone64_arm64", "model": "sdk_gphone64_arm64",
         "device": "emu64a"},
        {"serial": "R58M123", "state": "unauthorized"},
    ])


class FailingAdbTest(ApiTestCase):

  @property
  def adb(self):
    return write_fake_adb(self.tmp, "", exit_code=1)

  def test_adb_failure(self):
    status, body = self.json_request("GET", "/api/devices")
    self.assertEqual(status, 502)
    self.assertEqual(body["error"]["reason"], "adb_failed")


class MissingAdbTest(ApiTestCase):

  @property
  def adb(self):
    return os.path.join(self.tmp, "no-such-adb")

  def test_adb_missing(self):
    status, body = self.json_request("GET", "/api/devices")
    self.assertEqual(status, 503)
    self.assertEqual(body["error"]["reason"], "adb_failed")


class ParseAdbDevicesTest(unittest.TestCase):

  def test_states(self):
    output = (
        "* daemon not running; starting now at tcp:5037\n"
        "* daemon started successfully\n"
        "List of devices attached\n"
        "AAA  device usb:1-1 product:p model:Pixel_8 device:shiba\n"
        "BBB  offline transport_id:3\n"
        "CCC  unauthorized usb:1-2 transport_id:4\n"
        "DDD  no permissions (user in plugdev group; are your udev rules "
        "wrong?); see [http://developer.android.com/tools/device.html] "
        "usb:1-3 transport_id:5\n"
        "\n")
    self.assertEqual(helper_http.parse_adb_devices(output), [
        {"serial": "AAA", "state": "device", "product": "p",
         "model": "Pixel_8", "device": "shiba"},
        {"serial": "BBB", "state": "offline"},
        {"serial": "CCC", "state": "unauthorized"},
        {"serial": "DDD", "state": "no permissions"},
    ])

  def test_empty(self):
    self.assertEqual(helper_http.parse_adb_devices(
        "List of devices attached\n\n"), [])


if __name__ == "__main__":
  unittest.main()
