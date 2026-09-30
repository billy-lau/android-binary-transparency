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
"""Observe form options -> automate_observation.py arguments.

This is the single source of truth for what the UI may ask the script to do.
The Observe UI mirrors the pure part (normalize() and build_argv()) in
src/observe/lib/options.ts for instant feedback. Both test_options.py and
options.test.ts run tests/option_cases.json, so the two cannot drift.

Validation has two layers:
  * normalize(): shape, types, ranges and the dependent-field rules. Pure,
    so the TypeScript mirror can reproduce it exactly.
  * check_paths(): what the paths point at on this host. Server only.

Every value is passed as one `--flag=value` argument, so a value that starts
with "-" can never be read as another flag, and nothing goes through a shell.
"""

from __future__ import annotations

import os
from typing import Any, Optional

# Mirrors inclusion_proof_check.DEFAULT_PREFETCH_{CONCURRENCY,TIMEOUT};
# test_options.py fails if they drift apart.
DEFAULT_PREFETCH_CONCURRENCY = 16
DEFAULT_PREFETCH_TIMEOUT = 600
PREFETCH_CONCURRENCY_RANGE = (1, 64)
PREFETCH_TIMEOUT_RANGE = (1, 3600)

PULL_APKS = ("none", "all", "preinstalled")
HUBBLE_MODES = ("rebuild", "apk")
MAX_SERIALS = 64
MAX_SERIAL_LENGTH = 128
MAX_PATH_LENGTH = 4096

_TOP_KEYS = ("serials", "hubble", "output", "debug", "pullApks", "inclusionProof")
_HUBBLE_KEYS = ("mode", "path")
_PROOF_KEYS = ("enabled", "verifierPath", "preinstalledOnly", "noPrefetch",
               "cacheDir", "prefetchConcurrency", "prefetchTimeout")

Errors = dict  # field path (e.g. "inclusionProof.verifierPath") -> message


def results_root(output: str) -> str:
  """The directory the script writes into for a given --output.

  Mirrors automate_observation.extract_results_and_apks(): a "results"
  directory is appended unless the path already ends in one.
  """
  if os.path.basename(os.path.normpath(output)) == "results":
    return os.path.normpath(output)
  return os.path.join(output, "results")


def _unknown_keys(obj: dict, allowed: tuple, prefix: str, errors: Errors) -> None:
  for key in obj:
    if key not in allowed:
      errors[prefix + str(key)] = "Unknown option."


def _bool(obj: dict, key: str, field: str, errors: Errors) -> bool:
  value = obj.get(key, False)
  if value is None:
    return False
  if not isinstance(value, bool):
    errors[field] = "Must be true or false."
    return False
  return value


def _path(obj: dict, key: str, field: str, errors: Errors,
          required: bool) -> Optional[str]:
  """An absolute path, or None when blank and not required.

  A leading "~" is expanded here, so the browser preview may still show it.
  """
  value = obj.get(key)
  if value is None or (isinstance(value, str) and not value.strip()):
    if required:
      errors[field] = "Required."
    return None
  if not isinstance(value, str):
    errors[field] = "Must be a path."
    return None
  if "\0" in value or len(value) > MAX_PATH_LENGTH:
    errors[field] = "Not a valid path."
    return None
  expanded = os.path.expanduser(value)
  if not os.path.isabs(expanded):
    errors[field] = "Use an absolute path."
    return None
  return expanded


def _int(obj: dict, key: str, field: str, errors: Errors, default: int,
         bounds: tuple) -> int:
  value = obj.get(key)
  if value is None:
    return default
  if isinstance(value, bool) or not isinstance(value, int):
    errors[field] = "Must be a whole number."
    return default
  low, high = bounds
  if not low <= value <= high:
    errors[field] = "Must be between {} and {}.".format(low, high)
    return default
  return value


def _serials(raw: Any, errors: Errors) -> list:
  if raw is None:
    return []
  if not isinstance(raw, list):
    errors["serials"] = "Must be a list of serials."
    return []
  if len(raw) > MAX_SERIALS:
    errors["serials"] = "At most {} devices.".format(MAX_SERIALS)
    return []
  serials = []
  for serial in raw:
    # adb serials are printable ASCII without whitespace (USB serials,
    # host:port, mDNS service names).
    if (not isinstance(serial, str) or not serial
        or len(serial) > MAX_SERIAL_LENGTH
        or any(not ("!" <= c <= "~") for c in serial)):
      errors["serials"] = "Not a valid device serial: {!r}.".format(serial)
      return []
    if serial in serials:
      errors["serials"] = "Device {} is listed twice.".format(serial)
      return []
    serials.append(serial)
  return serials


def normalize(raw: Any, default_output: str) -> tuple:
  """Checks raw options and fills in defaults.

  Fields that the current choices make irrelevant (the APK path when
  rebuilding, everything under a disabled inclusion proof check, and the
  pre-fetch tuning when pre-fetching is off) are dropped without being
  validated: the form hides them, so the user cannot fix them.

  Args:
    raw: Options as decoded from the request body.
    default_output: --output to use when none is given.

  Returns:
    (normalized options, errors). The normalized options are only
    meaningful when errors is empty.
  """
  errors: Errors = {}
  if not isinstance(raw, dict):
    return {}, {"": "Options must be a JSON object."}
  _unknown_keys(raw, _TOP_KEYS, "", errors)

  # Only null means "absent"; false, "" or [] are wrong types, not defaults.
  hubble_raw = raw.get("hubble")
  if hubble_raw is None:
    hubble_raw = {"mode": "rebuild"}
  hubble = {"mode": "rebuild"}
  if not isinstance(hubble_raw, dict):
    errors["hubble"] = "Must be an object."
  else:
    _unknown_keys(hubble_raw, _HUBBLE_KEYS, "hubble.", errors)
    mode = hubble_raw.get("mode", "rebuild")
    if mode not in HUBBLE_MODES:
      errors["hubble.mode"] = "Must be one of: {}.".format(", ".join(HUBBLE_MODES))
    elif mode == "apk":
      hubble = {"mode": "apk",
                "path": _path(hubble_raw, "path", "hubble.path", errors,
                              required=True)}

  pull = raw.get("pullApks", "none")
  if pull is None:
    pull = "none"
  if pull not in PULL_APKS:
    errors["pullApks"] = "Must be one of: {}.".format(", ".join(PULL_APKS))
    pull = "none"

  proof_raw = raw.get("inclusionProof")
  if proof_raw is None:
    proof_raw = {}
  proof = {"enabled": False}
  if not isinstance(proof_raw, dict):
    errors["inclusionProof"] = "Must be an object."
  else:
    _unknown_keys(proof_raw, _PROOF_KEYS, "inclusionProof.", errors)
    if _bool(proof_raw, "enabled", "inclusionProof.enabled", errors):
      p = "inclusionProof."
      proof = {
          "enabled": True,
          "verifierPath": _path(proof_raw, "verifierPath", p + "verifierPath",
                                errors, required=True),
          "preinstalledOnly": _bool(proof_raw, "preinstalledOnly",
                                    p + "preinstalledOnly", errors),
          "noPrefetch": _bool(proof_raw, "noPrefetch", p + "noPrefetch", errors),
          "cacheDir": _path(proof_raw, "cacheDir", p + "cacheDir", errors,
                            required=False),
      }
      if not proof["noPrefetch"]:
        proof["prefetchConcurrency"] = _int(
            proof_raw, "prefetchConcurrency", p + "prefetchConcurrency", errors,
            DEFAULT_PREFETCH_CONCURRENCY, PREFETCH_CONCURRENCY_RANGE)
        proof["prefetchTimeout"] = _int(
            proof_raw, "prefetchTimeout", p + "prefetchTimeout", errors,
            DEFAULT_PREFETCH_TIMEOUT, PREFETCH_TIMEOUT_RANGE)

  normalized = {
      "serials": _serials(raw.get("serials"), errors),
      "hubble": hubble,
      "output": _path(raw, "output", "output", errors, required=False)
                or default_output,
      "debug": _bool(raw, "debug", "debug", errors),
      "pullApks": pull,
      "inclusionProof": proof,
  }
  return normalized, errors


def build_argv(options: dict) -> list:
  """automate_observation.py arguments for normalized options.

  --events is not included: the helper adds it, and a command copied from the
  preview is meant for a terminal, where it is not wanted.
  """
  argv = ["--serial=" + s for s in options["serials"]]
  if options["hubble"]["mode"] == "apk":
    argv.append("--hubble=" + options["hubble"]["path"])
  # Always explicit, so a copied command writes where a helper run would.
  argv.append("--output=" + options["output"])
  if options["debug"]:
    argv.append("--debug")
  if options["pullApks"] == "all":
    argv.append("--pull-all-apks")
  elif options["pullApks"] == "preinstalled":
    argv.append("--pull-preinstalled-apks-only")
  proof = options["inclusionProof"]
  if proof["enabled"]:
    argv.append("--perform_inclusion_proof_check")
    argv.append("--verifier_path=" + proof["verifierPath"])
    if proof["preinstalledOnly"]:
      argv.append("--check_preinstalled_only")
    if proof["noPrefetch"]:
      argv.append("--no_prefetch")
    if proof["cacheDir"]:
      argv.append("--cache_dir=" + proof["cacheDir"])
    if proof.get("prefetchConcurrency", DEFAULT_PREFETCH_CONCURRENCY) != \
        DEFAULT_PREFETCH_CONCURRENCY:
      argv.append("--cache_prefetch_concurrency={}".format(
          proof["prefetchConcurrency"]))
    if proof.get("prefetchTimeout", DEFAULT_PREFETCH_TIMEOUT) != \
        DEFAULT_PREFETCH_TIMEOUT:
      argv.append("--cache_prefetch_timeout={}".format(proof["prefetchTimeout"]))
  return argv


def _check_creatable_dir(path: str, field: str, label: str, errors: Errors,
                         warnings: list) -> None:
  real = os.path.realpath(path)
  if os.path.exists(real):
    if not os.path.isdir(real):
      errors[field] = "Exists but is not a directory."
    elif not os.access(real, os.W_OK):
      errors[field] = "Directory is not writable."
    return
  parent = os.path.dirname(real)
  while parent and not os.path.exists(parent):
    parent = os.path.dirname(parent)
  if not os.path.isdir(parent) or not os.access(parent, os.W_OK):
    errors[field] = "Does not exist and cannot be created."
  else:
    warnings.append("{} does not exist yet and will be created: {}".format(
        label, path))


def check_paths(options: dict) -> tuple:
  """Checks what the paths in normalized options point at on this host.

  Returns:
    (errors, warnings). Warnings do not block a run.
  """
  errors: Errors = {}
  warnings: list = []

  if options["hubble"]["mode"] == "apk":
    real = os.path.realpath(options["hubble"]["path"])
    if not os.path.exists(real):
      errors["hubble.path"] = "No such file."
    elif not os.path.isfile(real):
      errors["hubble.path"] = "Not a file."
    elif not real.endswith(".apk"):
      # The script resolves symlinks before this same check.
      errors["hubble.path"] = "Must be (or link to) an .apk file."

  _check_creatable_dir(options["output"], "output", "Output directory", errors,
                       warnings)
  if "output" not in errors:
    root = os.path.realpath(results_root(options["output"]))
    if os.path.exists(root) and not os.path.isdir(root):
      errors["output"] = "Its results directory exists but is not a directory."

  proof = options["inclusionProof"]
  if proof["enabled"]:
    real = os.path.realpath(proof["verifierPath"])
    if not os.path.exists(real):
      errors["inclusionProof.verifierPath"] = "No such file."
    elif not os.path.isfile(real):
      errors["inclusionProof.verifierPath"] = "Not a file."
    elif not os.access(real, os.X_OK):
      errors["inclusionProof.verifierPath"] = "Not executable."
    if proof["cacheDir"]:
      _check_creatable_dir(proof["cacheDir"], "inclusionProof.cacheDir",
                           "Cache directory", errors, warnings)
  return errors, warnings


def validate(raw: Any, default_output: str, check_filesystem: bool = True) -> dict:
  """Full validation, as returned by POST /api/validate.

  Returns:
    {ok, argv, errors, warnings, options}. argv is filled in once the
    options are well-formed, even if a path check fails, so the preview
    still shows the command; it must not be run unless ok. options is the
    normalized form, or None when not ok.
  """
  options, errors = normalize(raw, default_output)
  warnings: list = []
  argv: list = []
  if not errors:
    argv = build_argv(options)
    if check_filesystem:
      path_errors, warnings = check_paths(options)
      errors.update(path_errors)
  return {"ok": not errors, "argv": argv, "errors": errors,
          "warnings": warnings, "options": options if not errors else None}
