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

/**
 * Where the Analyze pages live in the router.
 *
 * Every in-app link to an Analyze page goes through analyzePath(), so moving
 * the section again is a one-line change here rather than a hunt for string
 * literals.
 */

export const ANALYZE_ROOT = '/analyze';

/** The first path segment of every Analyze page, as linked before the move. */
export const ANALYZE_PAGES = [
  'load',
  'overview',
  'packages',
  'certificates',
  'shared-uids',
  'permissions',
  'components',
  'integrity',
  'binaries',
  'device',
  'compare',
] as const;

/**
 * Prefixes an Analyze-relative path (which must start with `/`, and may carry
 * a `?query` and `#fragment`) with the Analyze root.
 */
export function analyzePath(path: `/${string}`): string {
  return ANALYZE_ROOT + path;
}
