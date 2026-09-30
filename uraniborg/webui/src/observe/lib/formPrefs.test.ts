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
import { FORM_KEY, clearForm, loadForm, saveForm, type KeyValueStore } from './formPrefs';
import { DEFAULT_FORM, type ObserveForm } from './options';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

const FILLED: ObserveForm = {
  serials: ['emulator-5554', 'R58M123'],
  hubbleMode: 'apk',
  hubblePath: '/opt/hubble.apk',
  output: '/tmp/out',
  debug: true,
  pullApks: 'preinstalled',
  proofEnabled: true,
  verifierPath: '/opt/verifier',
  preinstalledOnly: true,
  noPrefetch: false,
  cacheDir: '/tmp/cache',
  prefetchConcurrency: '8',
  prefetchTimeout: '12x',
};

describe('form persistence', () => {
  it('round-trips everything but the device selection', () => {
    const store = memoryStore();
    saveForm(FILLED, store);
    expect(loadForm(store)).toEqual({ ...FILLED, serials: [] });
  });

  it('never writes serials', () => {
    const store = memoryStore();
    saveForm(FILLED, store);
    const raw = store.data[FORM_KEY];
    expect(raw).not.toContain('emulator-5554');
    expect(JSON.parse(raw)).not.toHaveProperty('serials');
  });

  it('ignores serials even if stored', () => {
    const store = memoryStore({ [FORM_KEY]: JSON.stringify({ serials: ['x'], debug: true }) });
    expect(loadForm(store)).toEqual({ ...DEFAULT_FORM, serials: [], debug: true });
  });

  it('falls back to defaults for bad values, field by field', () => {
    const store = memoryStore({
      [FORM_KEY]: JSON.stringify({
        hubbleMode: 'sideload',
        pullApks: 'some',
        debug: 'yes',
        output: 42,
        verifierPath: 'x'.repeat(5000),
        cacheDir: '/ok',
        unknown: true,
      }),
    });
    expect(loadForm(store)).toEqual({ ...DEFAULT_FORM, serials: [], cacheDir: '/ok' });
  });

  it.each(['not json', '[]', 'null', '"text"'])('uses defaults when the stored value is %s', (raw) => {
    expect(loadForm(memoryStore({ [FORM_KEY]: raw }))).toEqual({ ...DEFAULT_FORM, serials: [] });
  });

  it('works without storage', () => {
    expect(loadForm(null)).toEqual({ ...DEFAULT_FORM, serials: [] });
    expect(() => saveForm(FILLED, null)).not.toThrow();
  });

  it('clears', () => {
    const store = memoryStore();
    saveForm(FILLED, store);
    clearForm(store);
    expect(store.data).toEqual({});
  });
});
