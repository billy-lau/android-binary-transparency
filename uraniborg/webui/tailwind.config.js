/*
 * Copyright 2026 Uraniborg authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0b0f14',
          soft: '#111820',
          raised: '#161f2a',
          hover: '#1c2733',
        },
        line: '#233041',
        ink: {
          DEFAULT: '#e6edf3',
          muted: '#8b9cb0',
          faint: '#5d6e80',
        },
        accent: {
          DEFAULT: '#4da3ff',
          soft: '#1d3a5c',
        },
        sev: {
          astronomical: '#ff4d6d',
          critical: '#ff7849',
          high: '#ffb020',
          medium: '#4da3ff',
          low: '#6b7f94',
          ok: '#3fb950',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
