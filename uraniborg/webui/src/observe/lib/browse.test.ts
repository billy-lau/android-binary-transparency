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

import { describe, expect, it } from 'vitest';
import type { FsListing } from './api';
import { listingTarget, listingText, pickedPath } from './browse';

const listing = (fields: Partial<FsListing> = {}): FsListing => ({
  path: '/home/me/results',
  home: '/home/me',
  parent: '/home/me',
  entries: [],
  ...fields,
});

describe('Browse dialog picks', () => {
  it('keeps a new output folder instead of picking its parent', () => {
    // The field held /home/me/results/run1, which does not exist yet.
    const l = listing({ missing: 'run1' });
    expect(listingText(l, 'dir', null)).toBe('/home/me/results/run1');
    expect(pickedPath('/home/me/results/run1', l, 'dir', null)).toBe('/home/me/results/run1');
  });

  it('keeps a deeper missing part too', () => {
    const l = listing({ path: '/', parent: undefined, missing: 'tmp/a/b' });
    expect(listingTarget(l, 'dir', null)).toBe('/tmp/a/b');
  });

  it('picks the listed folder when it exists', () => {
    const l = listing();
    expect(pickedPath(listingText(l, 'dir', null), l, 'dir', null)).toBe('/home/me/results');
  });

  it('ignores the missing part in file mode, where only a selected file counts', () => {
    const l = listing({ missing: 'hubble.apk' });
    expect(listingText(l, 'file', null)).toBe('/home/me/results');
    expect(pickedPath('/home/me/results', l, 'file', null)).toBeNull();
    const withFile = listing({ selected: 'hubble.apk' });
    expect(pickedPath('/home/me/results/hubble.apk', withFile, 'file', 'hubble.apk')).toBe(
      '/home/me/results/hubble.apk',
    );
  });

  it('picks a path typed into the box even without Enter', () => {
    const l = listing();
    expect(pickedPath('/elsewhere/out', l, 'dir', null)).toBe('/elsewhere/out');
    expect(pickedPath('  /opt/verifier  ', l, 'file', null)).toBe('/opt/verifier');
    // Typing over a new folder's name picks what was typed, not the listing.
    expect(pickedPath('/home/me/results/run2', listing({ missing: 'run1' }), 'dir', null)).toBe(
      '/home/me/results/run2',
    );
  });

  it('falls back to the listing when the box is cleared', () => {
    const l = listing({ selected: 'a.apk' });
    expect(pickedPath('   ', l, 'dir', null)).toBe('/home/me/results');
    expect(pickedPath('', l, 'file', 'a.apk')).toBe('/home/me/results/a.apk');
    expect(pickedPath('', listing(), 'file', null)).toBeNull();
  });

  it('uses the typed path before any listing has loaded', () => {
    expect(pickedPath('/start', null, 'dir', null)).toBe('/start');
    expect(pickedPath('', null, 'dir', null)).toBeNull();
  });
});
