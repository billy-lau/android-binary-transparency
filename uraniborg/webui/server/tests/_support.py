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
"""Shared paths for the helper tests. Import it before the server modules."""

import os
import sys

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(TESTS_DIR)
FAKE_SCRIPT = os.path.join(TESTS_DIR, "fake_automate.py")
OPTION_CASES = os.path.join(TESTS_DIR, "option_cases.json")
SCRIPTS_PYTHON_DIR = os.path.normpath(
    os.path.join(SERVER_DIR, "..", "..", "scripts", "python"))

if SERVER_DIR not in sys.path:
  sys.path.insert(0, SERVER_DIR)
