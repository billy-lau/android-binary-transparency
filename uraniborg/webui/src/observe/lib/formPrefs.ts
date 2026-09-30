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
 * Remembers the Observe form between visits.
 *
 * Everything that describes this host is kept: Hubble source and APK path,
 * output directory, logging and APK extraction choices, and the
 * inclusion-proof settings. The device selection is **not**: serials
 * identify devices, and nothing about an observed device is written to
 * browser storage. Stored values are checked on load like any other input,
 * and anything unknown or of the wrong type falls back to the default.
 */

import { DEFAULT_FORM, HUBBLE_MODES, PULL_APKS, type ObserveForm } from './options';

export const FORM_KEY = 'uraniborg-explorer/observe-form/v1';

/** The part of `Storage` this needs, so tests can pass a plain object. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

type Remembered = Omit<ObserveForm, 'serials'>;

const STRING_FIELDS = [
  'hubblePath',
  'output',
  'verifierPath',
  'cacheDir',
  'prefetchConcurrency',
  'prefetchTimeout',
] as const;
const BOOLEAN_FIELDS = ['debug', 'proofEnabled', 'preinstalledOnly', 'noPrefetch'] as const;
const MAX_STORED_LENGTH = 4096;

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // Storage can be disabled outright.
  }
}

/** The remembered form, with an empty device selection. */
export function loadForm(store: KeyValueStore | null = defaultStore()): ObserveForm {
  const form: ObserveForm = { ...DEFAULT_FORM, serials: [] };
  let stored: unknown;
  try {
    const raw = store?.getItem(FORM_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    return form;
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return form;
  const s = stored as Record<string, unknown>;

  for (const key of STRING_FIELDS) {
    const value = s[key];
    if (typeof value === 'string' && value.length <= MAX_STORED_LENGTH) form[key] = value;
  }
  for (const key of BOOLEAN_FIELDS) {
    if (typeof s[key] === 'boolean') form[key] = s[key] as boolean;
  }
  if (HUBBLE_MODES.includes(s.hubbleMode as ObserveForm['hubbleMode'])) {
    form.hubbleMode = s.hubbleMode as ObserveForm['hubbleMode'];
  }
  if (PULL_APKS.includes(s.pullApks as ObserveForm['pullApks'])) {
    form.pullApks = s.pullApks as ObserveForm['pullApks'];
  }
  return form;
}

/** Saves everything except the device selection. */
export function saveForm(form: ObserveForm, store: KeyValueStore | null = defaultStore()): void {
  const remembered: Remembered = {
    hubbleMode: form.hubbleMode,
    hubblePath: form.hubblePath,
    output: form.output,
    debug: form.debug,
    pullApks: form.pullApks,
    proofEnabled: form.proofEnabled,
    verifierPath: form.verifierPath,
    preinstalledOnly: form.preinstalledOnly,
    noPrefetch: form.noPrefetch,
    cacheDir: form.cacheDir,
    prefetchConcurrency: form.prefetchConcurrency,
    prefetchTimeout: form.prefetchTimeout,
  };
  try {
    store?.setItem(FORM_KEY, JSON.stringify(remembered));
  } catch {
    /* quota or disabled storage: the form still works, it just forgets */
  }
}

export function clearForm(store: KeyValueStore | null = defaultStore()): void {
  try {
    store?.removeItem(FORM_KEY);
  } catch {
    /* ignore */
  }
}
