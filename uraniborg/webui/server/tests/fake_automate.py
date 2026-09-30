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
"""Stands in for automate_observation.py in helper tests and smoke tests.

It follows the real script's --events contract (docs/automate_observation.md):
with `--events -`, stdout carries only events and logs go to stderr; SIGTERM
reports run_finished with reason "terminated" and then dies by SIGTERM; the
Xiaomi prompt blocks on stdin and re-asks without a new prompt event.

Environment:
  FAKE_AUTOMATE_SCENARIO  success (default) | xiaomi | backup | early_exit |
                          crash | noise | bad_version | hang | stubborn |
                          daemon
  FAKE_AUTOMATE_DELAY     seconds between steps (default 0.02)
  FAKE_AUTOMATE_SPLITS    APK splits the inclusion proof check reports as its
                          step_progress total, with
                          --perform_inclusion_proof_check (default 314)
  FAKE_AUTOMATE_SAMPLE    directory of Hubble .txt files to copy into the
                          results (default: ../../sample-data/pixel-target if
                          it exists, else small placeholder files)
"""

import argparse
import datetime
import json
import os
import shutil
import signal
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SAMPLE = os.path.normpath(
    os.path.join(HERE, "..", "..", "sample-data", "pixel-target"))


class Terminated(Exception):
  pass


def _ts():
  now = datetime.datetime.now(datetime.timezone.utc)
  return now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)


class Fake:

  def __init__(self, args, events, scenario, delay, version):
    self.args = args
    self.events = events
    self.scenario = scenario
    self.delay = delay
    self.version = version
    self.summary = {}
    self.splits = int(os.environ.get("FAKE_AUTOMATE_SPLITS", "314"))

  def emit(self, type_, **fields):
    if self.events is None:
      return
    event = {"v": self.version, "ts": _ts(), "type": type_}
    event.update(fields)
    self.events.write(json.dumps(event) + "\n")
    self.events.flush()

  def log(self, level, message):
    sys.stderr.write("%s:fake_automate.py:main(1): %s\n" % (level, message))
    sys.stderr.flush()

  def step(self, name, device=None):
    extra = {"device": device} if device else {}
    self.emit("step", step=name, state="started", **extra)
    time.sleep(self.delay)
    self.emit("step", step=name, state="finished",
              duration_ms=int(self.delay * 1000), **extra)

  def device_finished(self, serial, status, results_dir=None, error=None):
    fields = {"device": serial, "status": status}
    entry = {"status": status}
    if results_dir:
      fields["results_dir"] = entry["results_dir"] = results_dir
    if error:
      fields["error"] = error
    self.emit("device_finished", **fields)
    self.summary[serial] = entry

  def wait_for_manual_install(self, serial):
    """Returns True once confirmed; False if stdin closed."""
    self.emit("prompt", device=serial, kind="xiaomi_manual_install",
              message="Install Hubble on the device, then press Enter.",
              expects_input=True)
    presses = 0
    while True:
      sys.stderr.write("Please install Hubble manually, then press Enter: ")
      sys.stderr.flush()
      line = sys.stdin.readline()
      if not line:
        self.emit("prompt_resolved", device=serial,
                  kind="xiaomi_manual_install", outcome="stdin_closed")
        return False
      presses += 1
      if presses < 2:
        self.log("WARNING", "Hubble is still not installed on %s." % serial)
        continue
      self.emit("prompt_resolved", device=serial, kind="xiaomi_manual_install",
                outcome="done")
      return True

  def write_results(self, serial):
    root = os.path.abspath(self.args.output)
    if os.path.basename(os.path.normpath(root)) != "results":
      root = os.path.join(root, "results")
    results_dir = os.path.join(root, "fake", serial, "000")
    artifacts = os.path.join(results_dir, "results")
    os.makedirs(artifacts, exist_ok=True)
    sample = os.environ.get("FAKE_AUTOMATE_SAMPLE", DEFAULT_SAMPLE)
    if os.path.isdir(sample):
      for name in os.listdir(sample):
        if name.endswith(".txt"):
          shutil.copy(os.path.join(sample, name), artifacts)
    else:
      for name in ("packages.txt", "build.txt"):
        with open(os.path.join(artifacts, name), "w") as f:
          f.write("{}\n")
    return results_dir

  def observe(self, serial):
    self.emit("device_started", device=serial)
    self.emit("step", step="install_hubble", state="started", device=serial)
    if self.scenario == "xiaomi" and not self.wait_for_manual_install(serial):
      self.emit("step", step="install_hubble", state="failed", device=serial,
                duration_ms=0, message="stdin closed")
      self.device_finished(serial, "failed", error={
          "reason": "stdin_closed",
          "message": "Standard input was closed while waiting."})
      return
    self.emit("step", step="install_hubble", state="finished", device=serial,
              duration_ms=0)
    self.emit("step", step="wait_for_results", state="started", device=serial)
    if self.scenario in ("hang", "stubborn"):
      # A grandchild, like adb or gradlew, to show a cancel reaches the whole
      # process group.
      child = subprocess.Popen(["sleep", "3600"])
      self.log("INFO", "child pid %d" % child.pid)
      time.sleep(3600)
    time.sleep(self.delay)
    self.emit("step", step="wait_for_results", state="finished", device=serial,
              duration_ms=int(self.delay * 1000))
    self.emit("step", step="extract_results", state="started", device=serial)
    if self.scenario == "backup":
      self.emit("prompt", device=serial, kind="adb_backup_confirm",
                message="Tap 'Back up my data' on the device.",
                expects_input=False)
      time.sleep(self.delay * 5)
      self.emit("prompt_resolved", device=serial, kind="adb_backup_confirm",
                outcome="done")
    results_dir = self.write_results(serial)
    self.emit("step", step="extract_results", state="finished", device=serial,
              duration_ms=int(self.delay * 1000))
    if self.args.perform_inclusion_proof_check:
      self.check_inclusion_proofs(serial)
    self.device_finished(serial, "success", results_dir=results_dir)

  def check_inclusion_proofs(self, serial):
    """An inclusion_proof_check step that reports step_progress.

    Like the real script: the first event has done=0, a few follow as splits
    are verified, and the one with done=total is always sent.
    """
    total = self.splits
    self.emit("step", step="inclusion_proof_check", state="started",
              device=serial)
    self.emit("step_progress", step="inclusion_proof_check", device=serial,
              done=0, total=total)
    ticks = 5
    for tick in range(1, ticks + 1):
      time.sleep(self.delay)
      done = total * tick // ticks
      self.emit("step_progress", step="inclusion_proof_check", device=serial,
                done=done, total=total)
    self.emit("step", step="inclusion_proof_check", state="finished",
              device=serial, duration_ms=int(self.delay * ticks * 1000))

  def run(self):
    self.emit("run_started", argv=sys.argv[1:], pid=os.getpid())
    self.log("INFO", "Fake observation starting (scenario %s)." % self.scenario)
    # Consumers must ignore event types they do not know.
    self.emit("future_event", detail="from a newer script")
    if self.scenario == "noise" and self.events is not None:
      self.events.write("this line is not JSON\n")
      self.events.flush()
    self.step("verify_hubble")
    if self.scenario == "early_exit":
      self.log("ERROR", "No device is connected.")
      self.emit("run_finished", exit_code=0, ok=False, summary={},
                error={"reason": "no_devices",
                       "message": "No device is connected."})
      return 0
    serials = self.args.serial or ["FAKE0001"]
    self.emit("devices", devices=[{"serial": s, "unauthorized": False,
                                   "model": "Fake_Phone"} for s in serials],
              selected=serials, missing=[])
    for serial in serials:
      self.observe(serial)
    if self.scenario == "daemon":
      # Like `adb start-server`: a background process that outlives the run
      # and inherits its stderr.
      daemon = subprocess.Popen(["sleep", "30"])
      self.log("INFO", "daemon pid %d" % daemon.pid)
    if self.scenario == "crash":
      self.log("CRITICAL", "Simulated crash before run_finished.")
      return 1
    ok = all(e["status"] == "success" for e in self.summary.values())
    self.emit("run_finished", exit_code=0 if ok else 1, ok=ok,
              summary=self.summary)
    return 0 if ok else 1


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--events")
  parser.add_argument("--output", default=os.path.join(os.getcwd(), "results"))
  parser.add_argument("--serial", action="append")
  parser.add_argument("--perform_inclusion_proof_check", action="store_true")
  args, _ = parser.parse_known_args()

  events = None
  if args.events == "-":
    # Like the real script: events keep the original stdout, and anything
    # else printed goes to stderr.
    events = os.fdopen(os.dup(1), "w")
    os.dup2(2, 1)
  elif args.events:
    events = open(args.events, "w")

  scenario = os.environ.get("FAKE_AUTOMATE_SCENARIO", "success")
  version = 2 if scenario == "bad_version" else 1
  fake = Fake(args, events, scenario,
              float(os.environ.get("FAKE_AUTOMATE_DELAY", "0.02")), version)

  if scenario == "stubborn":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
  elif events is not None:
    def on_sigterm(signum, frame):
      raise Terminated()
    signal.signal(signal.SIGTERM, on_sigterm)

  try:
    return fake.run()
  except Terminated:
    fake.emit("run_finished", exit_code=143, ok=False, summary=fake.summary,
              error={"reason": "terminated", "message": "Stopped by SIGTERM."})
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.kill(os.getpid(), signal.SIGTERM)
    return 143


if __name__ == "__main__":
  sys.exit(main())
