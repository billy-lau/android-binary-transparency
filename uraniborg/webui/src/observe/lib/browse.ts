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

/** What the Browse dialog (components/PathField.tsx) picks. */

import type { FsListing } from './api';

export type PickMode = 'file' | 'dir';

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

/**
 * The path a listing points to. In folder mode that is the listed folder,
 * plus the part that does not exist yet if one was asked for: a new output
 * folder must not quietly become its parent. In file mode it is the selected
 * file, if any.
 */
export function listingTarget(listing: FsListing, mode: PickMode, selected: string | null): string | null {
  if (mode === 'dir') return listing.missing ? joinPath(listing.path, listing.missing) : listing.path;
  return selected ? joinPath(listing.path, selected) : null;
}

/**
 * What the path box shows for a listing: its target, or in file mode with
 * nothing selected, the folder being looked at.
 */
export function listingText(listing: FsListing, mode: PickMode, selected: string | null): string {
  return listingTarget(listing, mode, selected) ?? listing.path;
}

/**
 * What **Choose** picks. A path typed into the box but not opened with Enter
 * wins over the listing: it is what the user last looked at, and the form
 * validates it like any typed path. Otherwise it is the listing's target.
 */
export function pickedPath(
  typed: string,
  listing: FsListing | null,
  mode: PickMode,
  selected: string | null,
): string | null {
  const text = typed.trim();
  if (!listing) return text || null;
  if (text && text !== listingText(listing, mode, selected)) return text;
  return listingTarget(listing, mode, selected);
}
