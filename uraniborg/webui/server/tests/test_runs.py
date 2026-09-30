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
"""Tests for runs.py, driving fake_automate.py through real subprocesses."""

import os
import re
import signal
import sys
import tempfile
import time
import unittest

import _support  # noqa: F401  (sets sys.path)
import runs

TIMEOUT_S = 15


def wait_until(predicate, timeout=TIMEOUT_S, message="condition"):
  deadline = time.monotonic() + timeout
  while time.monotonic() < deadline:
    if predicate():
      return
    time.sleep(0.02)
  raise AssertionError("Timed out waiting for " + message)


def pid_alive(pid):
  try:
    os.kill(pid, 0)
  except ProcessLookupError:
    return False
  return True


class RunsTestBase(unittest.TestCase):

  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.output = os.path.realpath(tmp.name)
    self.managers = []

  def tearDown(self):
    for manager in self.managers:
      manager.shutdown(timeout_s=2)

  def manager(self, scenario, **kwargs):
    env = dict(os.environ, FAKE_AUTOMATE_SCENARIO=scenario,
               FAKE_AUTOMATE_DELAY="0.01")
    manager = runs.RunManager(_support.FAKE_SCRIPT, python=sys.executable,
                              env=env, **kwargs)
    self.managers.append(manager)
    return manager

  def start(self, scenario, argv=None, **kwargs):
    manager = self.manager(scenario, **kwargs)
    argv = argv if argv is not None else ["--output=" + self.output]
    return manager.start(argv, os.path.join(self.output, "results"))

  def finish(self, run):
    wait_until(lambda: run.done, message="the run to finish")
    with run.cond:
      return run.snapshot()

  def events(self, run, type_=None):
    with run.cond:
      entries = run.entries_after(0)
    return [data for _, kind, data in entries
            if kind == "event" and (type_ is None or data["type"] == type_)]

  def logs(self, run):
    with run.cond:
      entries = run.entries_after(0)
    return [data for _, kind, data in entries if kind == "log"]

  def wait_for_event(self, run, predicate, message):
    wait_until(lambda: any(predicate(e) for e in self.events(run)),
               message=message)


# --- Outcomes ---

class OutcomeTest(RunsTestBase):

  def test_success(self):
    run = self.start("success")
    snap = self.finish(run)
    self.assertEqual(snap["state"], "succeeded")
    self.assertEqual(snap["exitCode"], 0)
    self.assertNotIn("error", snap)
    device = snap["devices"]["FAKE0001"]
    self.assertEqual(device["status"], "success")
    self.assertEqual(device["model"], "Fake_Phone")
    self.assertTrue(device["resultsDir"].startswith(self.output))
    self.assertEqual(self.events(run)[0]["type"], "run_started")
    self.assertEqual(self.events(run)[-1]["type"], "run_finished")

  def test_helper_adds_events_flag_last(self):
    run = self.start("success")
    self.finish(run)
    argv = self.events(run, "run_started")[0]["argv"]
    self.assertEqual(argv[-2:], ["--events", "-"])
    self.assertEqual(run.argv, ["--output=" + self.output])

  def test_serials_pass_through(self):
    run = self.start("success", argv=["--output=" + self.output,
                                      "--serial=A1", "--serial=B2"])
    snap = self.finish(run)
    self.assertEqual(list(snap["devices"]), ["A1", "B2"])
    self.assertEqual(snap["state"], "succeeded")

  def test_step_progress_passes_through_in_order(self):
    run = self.start("success", argv=["--output=" + self.output,
                                      "--perform_inclusion_proof_check"])
    snap = self.finish(run)
    self.assertEqual(snap["state"], "succeeded")
    proof = [e for e in self.events(run)
             if e.get("step") == "inclusion_proof_check"]
    self.assertEqual(proof[0]["type"], "step")
    self.assertEqual(proof[0]["state"], "started")
    self.assertEqual(proof[-1]["type"], "step")
    self.assertEqual(proof[-1]["state"], "finished")
    progress = [(e["done"], e["total"]) for e in proof[1:-1]]
    self.assertTrue(all(e["type"] == "step_progress" for e in proof[1:-1]))
    self.assertEqual(progress[0], (0, 314))
    self.assertEqual(progress[-1], (314, 314))
    self.assertEqual(progress, sorted(progress))

  def test_unknown_event_types_are_kept_and_ignored(self):
    run = self.start("success")
    snap = self.finish(run)
    self.assertEqual(snap["state"], "succeeded")
    self.assertEqual(len(self.events(run, "future_event")), 1)

  def test_early_exit_is_a_failure_despite_exit_code_zero(self):
    run = self.start("early_exit")
    snap = self.finish(run)
    self.assertEqual(snap["exitCode"], 0)
    self.assertEqual(snap["state"], "failed")
    self.assertEqual(snap["error"]["reason"], "no_devices")

  def test_missing_run_finished_is_a_failure(self):
    run = self.start("crash")
    snap = self.finish(run)
    self.assertEqual(snap["state"], "failed")
    self.assertEqual(snap["error"]["reason"], runs.REASON_NO_RESULT)
    self.assertIn("exit code 1", snap["error"]["message"])
    # Per-device results seen so far are still reported.
    self.assertEqual(snap["devices"]["FAKE0001"]["status"], "success")

  def test_non_json_stdout_is_an_anomaly_not_a_failure(self):
    run = self.start("noise")
    snap = self.finish(run)
    self.assertEqual(snap["state"], "succeeded")
    self.assertEqual(snap["anomalies"], 1)
    anomalies = [e for e in self.logs(run) if e.get("anomaly")]
    self.assertEqual(len(anomalies), 1)
    self.assertEqual(anomalies[0]["message"], "this line is not JSON")
    self.assertEqual(anomalies[0]["level"], "WARNING")
    self.assertEqual(anomalies[0]["source"], "stdout")

  def test_version_mismatch_kills_the_run(self):
    run = self.start("bad_version")
    snap = self.finish(run)
    self.assertEqual(snap["state"], "failed")
    self.assertEqual(snap["error"]["reason"], runs.REASON_VERSION_MISMATCH)
    self.assertIn("v2", snap["error"]["message"])

  def test_a_daemon_holding_the_pipes_does_not_stall_the_run(self):
    run = self.start("daemon")
    started = time.monotonic()
    snap = self.finish(run)
    self.assertLess(time.monotonic() - started, runs.PIPE_DRAIN_TIMEOUT_S + 3)
    self.assertEqual(snap["state"], "succeeded")
    for entry in self.logs(run):
      m = re.search(r"daemon pid (\d+)", entry["message"])
      if m:
        os.kill(int(m.group(1)), signal.SIGKILL)

  def test_stderr_lines_are_parsed(self):
    run = self.start("success")
    self.finish(run)
    parsed = [e for e in self.logs(run) if e.get("source") == "stderr"
              and e.get("level") == "INFO"]
    self.assertTrue(parsed)
    self.assertEqual(parsed[0]["file"], "fake_automate.py")
    self.assertEqual(parsed[0]["func"], "main")
    self.assertIn("scenario success", parsed[0]["message"])


# --- Prompts and input ---

class PromptTest(RunsTestBase):

  def pending(self, run):
    with run.cond:
      return run.pending_prompt

  def test_xiaomi_prompt_takes_two_newlines(self):
    run = self.start("xiaomi")
    wait_until(lambda: self.pending(run), message="the prompt")
    self.assertEqual(self.pending(run)["kind"], "xiaomi_manual_install")
    self.assertTrue(self.pending(run)["expectsInput"])

    run.send_newline()  # too early: the script re-asks, without a new prompt
    wait_until(lambda: any("still not installed" in e["message"]
                           for e in self.logs(run)), message="the re-ask")
    self.assertIsNotNone(self.pending(run))
    self.assertEqual(len(self.events(run, "prompt")), 1)

    run.send_newline()
    snap = self.finish(run)
    self.assertEqual(snap["state"], "succeeded")
    self.assertEqual(snap["lastPromptOutcome"], "done")
    self.assertNotIn("pendingPrompt", snap)

  def test_input_is_refused_without_a_prompt(self):
    run = self.start("hang")
    self.wait_for_event(run, lambda e: e.get("step") == "wait_for_results",
                        "the run to be busy")
    with self.assertRaises(runs.InputNotAllowed):
      run.send_newline()

  def test_input_is_refused_for_a_prompt_without_input(self):
    manager = self.manager("backup")
    env = dict(manager.env, FAKE_AUTOMATE_DELAY="0.2")
    manager.env = env
    run = manager.start(["--output=" + self.output],
                        os.path.join(self.output, "results"))
    wait_until(lambda: self.pending(run), message="the backup prompt")
    self.assertFalse(self.pending(run)["expectsInput"])
    with self.assertRaises(runs.InputNotAllowed):
      run.send_newline()
    snap = self.finish(run)
    self.assertEqual(snap["state"], "succeeded")

  def test_input_is_refused_after_the_run(self):
    run = self.start("success")
    self.finish(run)
    with self.assertRaises(runs.InputNotAllowed):
      run.send_newline()

  def test_closed_stdin_fails_the_device(self):
    run = self.start("xiaomi")
    wait_until(lambda: self.pending(run), message="the prompt")
    run.proc.stdin.close()
    snap = self.finish(run)
    self.assertEqual(snap["state"], "failed")
    self.assertEqual(snap["lastPromptOutcome"], "stdin_closed")
    self.assertEqual(snap["devices"]["FAKE0001"]["error"]["reason"],
                     "stdin_closed")


# --- Cancel and concurrency ---

class CancelTest(RunsTestBase):

  def child_pid(self, run):
    wait_until(lambda: any("child pid" in e["message"] for e in self.logs(run)),
               message="the grandchild")
    for entry in self.logs(run):
      m = re.search(r"child pid (\d+)", entry["message"])
      if m:
        return int(m.group(1))
    raise AssertionError("no child pid")

  def test_cancel_reports_terminated_and_kills_the_group(self):
    run = self.start("hang")
    child = self.child_pid(run)
    self.assertTrue(run.cancel(grace_s=5))
    snap = self.finish(run)
    self.assertEqual(snap["state"], "cancelled")
    self.assertEqual(snap["error"]["reason"], "terminated")
    self.assertEqual(snap["exitCode"], -signal.SIGTERM)
    wait_until(lambda: not pid_alive(child), timeout=5,
               message="the grandchild to die")

  def test_cancel_escalates_to_sigkill(self):
    run = self.start("stubborn")
    child = self.child_pid(run)
    run.cancel(grace_s=0.3)
    snap = self.finish(run)
    self.assertEqual(snap["state"], "cancelled")
    self.assertEqual(snap["error"]["reason"], runs.REASON_KILLED)
    self.assertEqual(snap["exitCode"], -signal.SIGKILL)
    self.assertTrue(any("SIGKILL" in e["message"] for e in self.logs(run)))
    wait_until(lambda: not pid_alive(child), timeout=5,
               message="the grandchild to die")

  def test_cancel_after_the_run_returns_false(self):
    run = self.start("success")
    self.finish(run)
    self.assertFalse(run.cancel(grace_s=1))

  def test_one_run_at_a_time(self):
    manager = self.manager("hang")
    root = os.path.join(self.output, "results")
    first = manager.start(["--output=" + self.output], root)
    with self.assertRaises(runs.Busy):
      manager.start(["--output=" + self.output], root)
    self.assertIs(manager.active(), first)
    first.cancel(grace_s=5)
    self.finish(first)
    self.assertIsNone(manager.active())
    second = manager.start(["--output=" + self.output], root)
    self.assertIsNot(second, first)
    self.assertEqual([r["id"] for r in manager.list()], [first.id, second.id])

  def test_shutdown_stops_the_active_run(self):
    manager = self.manager("hang")
    run = manager.start(["--output=" + self.output],
                        os.path.join(self.output, "results"))
    child = self.child_pid(run)
    manager.shutdown(timeout_s=5)
    self.finish(run)
    wait_until(lambda: not pid_alive(child), timeout=5,
               message="the grandchild to die")


# --- Entries ---

class EntriesTest(unittest.TestCase):

  def test_entries_are_numbered_and_replayable(self):
    run = runs.Run("0" * 16, [], "/tmp", log_cap=100)
    with run.cond:
      run._append("log", {"message": "a"})
      run._append("event", {"type": "x"})
      run._append("log", {"message": "b"})
      self.assertEqual([seq for seq, _, _ in run.entries_after(0)], [1, 2, 3])
      self.assertEqual([seq for seq, _, _ in run.entries_after(1)], [2, 3])
      self.assertEqual(run.entries_after(3), [])

  def test_log_cap_never_drops_events(self):
    run = runs.Run("0" * 16, [], "/tmp", log_cap=2)
    with run.cond:
      run._append("event", {"type": "run_started"})
      for i in range(5):
        run._append("log", {"message": str(i)})
      run._append("event", {"type": "run_finished"})
      entries = run.entries_after(0)
    self.assertEqual([k for _, k, _ in entries],
                     ["event", "log", "log", "event"])
    self.assertEqual([d.get("message") for _, k, d in entries if k == "log"],
                     ["3", "4"])

  def test_parse_log_line(self):
    entry = runs.parse_log_line(
        "WARNING:automate_observation.py:_observe_device(1402): hi: there",
        "stderr")
    self.assertEqual(entry["level"], "WARNING")
    self.assertEqual(entry["func"], "_observe_device")
    self.assertEqual(entry["line"], 1402)
    self.assertEqual(entry["message"], "hi: there")
    plain = runs.parse_log_line("Please press Enter:", "stderr")
    self.assertNotIn("level", plain)
    self.assertEqual(plain["message"], "Please press Enter:")


# --- Entry lookup ---------------------------------------------------------------


class EntriesAfterTest(unittest.TestCase):

  def test_matches_a_full_scan(self):
    run = runs.Run("0" * 16, [], "/out", log_cap=7)
    with run.cond:
      # Interleave events, states and logs; the log store trims to 7.
      for i in range(60):
        kind = ("log", "log", "event", "log", "state")[i % 5]
        run._append(kind, {"i": i})  # pylint: disable=protected-access
      stored = sorted(list(run._events) + list(run._logs))  # pylint: disable=protected-access
      for last in range(-1, 63):
        self.assertEqual(run.entries_after(last),
                         [e for e in stored if e[0] > last], last)
      self.assertEqual(run.entries_after(60), [])


if __name__ == "__main__":
  unittest.main()
