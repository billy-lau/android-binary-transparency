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
 * Observe state: whether the helper is there, and the form.
 *
 * The run itself is not kept here: the run page rebuilds it from the helper's
 * event stream, which also makes a reload mid-run lose nothing.
 */

import { create } from 'zustand';
import { ApiError, api, getToken, type Health } from './lib/api';
import { clearForm, loadForm, saveForm } from './lib/formPrefs';
import { DEFAULT_FORM, type ObserveForm } from './lib/options';

export type HelperStatus =
  | { kind: 'checking' }
  /** No token: the page was not opened from the helper's URL. */
  | { kind: 'absent' }
  | { kind: 'connected'; health: Health }
  | { kind: 'error'; message: string; badToken: boolean };

interface ObserveState {
  helper: HelperStatus;
  form: ObserveForm;
  /** Asks the helper how it is. Safe to call often; never throws. */
  checkHelper: () => Promise<void>;
  setForm: (patch: Partial<ObserveForm>) => void;
  resetForm: () => void;
}

export const useObserve = create<ObserveState>((set, get) => ({
  // Not decided here: this module loads before main.tsx has moved the token
  // out of the URL. The first checkHelper() settles it.
  helper: { kind: 'checking' },
  form: loadForm(),

  checkHelper: async () => {
    if (!getToken()) {
      set({ helper: { kind: 'absent' } });
      return;
    }
    try {
      set({ helper: { kind: 'connected', health: await api.health() } });
    } catch (err) {
      const e = err as ApiError;
      set({
        helper: {
          kind: 'error',
          message: e.message,
          badToken: e.status === 401,
        },
      });
    }
  },

  setForm: (patch) => {
    const form = { ...get().form, ...patch };
    saveForm(form);
    set({ form });
  },

  resetForm: () => {
    clearForm();
    set({ form: { ...DEFAULT_FORM, serials: [] } });
  },
}));
