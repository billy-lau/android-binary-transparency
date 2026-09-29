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
"""Local helper for Uraniborg Explorer: serves the UI and runs observations.

    python3 server/uraniborg_helper.py [--port 8765] [--open]

See server/README.md. This file only checks the Python version, using syntax
old interpreters can still parse, so they get a clear message instead of a
SyntaxError from the modules below.
"""

import sys

if sys.version_info < (3, 9):
  sys.stderr.write(
      "The Uraniborg helper needs Python 3.9 or newer (it runs "
      "automate_observation.py, which does too). This is Python %d.%d.\n"
      % sys.version_info[:2])
  sys.exit(1)

from helper_http import main  # noqa: E402  (after the version check)

if __name__ == "__main__":
  sys.exit(main())
