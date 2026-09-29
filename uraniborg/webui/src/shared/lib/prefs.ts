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
 * UI preferences shared by every mode: the widths the user dragged table
 * columns and side panels to.
 *
 * Purely presentational, so they are safe to keep across sessions: nothing
 * here describes an observed device. The storage key predates the split into
 * Analyze and Observe and is kept so saved widths survive.
 */

import { create } from 'zustand';

const PREFS_KEY = 'uraniborg-explorer/prefs/v1';

export interface Prefs {
  /** User-resized table columns, in CSS pixels, keyed by table id then column id. */
  columnWidths: Record<string, Record<string, number>>;
  /** Resizable side panels (nav rail, detail panes), in CSS pixels, by panel id. */
  panelWidths: Record<string, number>;
}

const DEFAULT_PREFS: Prefs = { columnWidths: {}, panelWidths: {} };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      // Known fields only, each checked: tolerates prefs written before the
      // size overrides existed, hand edits, and the unused `density` that
      // older versions stored.
      return {
        columnWidths:
          parsed.columnWidths && typeof parsed.columnWidths === 'object' ? parsed.columnWidths : {},
        panelWidths:
          parsed.panelWidths && typeof parsed.panelWidths === 'object' ? parsed.panelWidths : {},
      };
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PREFS;
}

function persistPrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

interface PrefsState {
  prefs: Prefs;
  /** Sets one column's width in px, or clears it when `px` is null. */
  setColumnWidth: (tableId: string, columnId: string, px: number | null) => void;
  resetColumnWidths: (tableId: string) => void;
  /** Sets a panel's width in px, or clears it back to the default when null. */
  setPanelWidth: (panelId: string, px: number | null) => void;
}

export const usePrefs = create<PrefsState>((set, get) => {
  const update = (patch: Partial<Prefs>) => {
    const prefs = { ...get().prefs, ...patch };
    persistPrefs(prefs);
    set({ prefs });
  };

  return {
    prefs: loadPrefs(),

    setColumnWidth: (tableId, columnId, px) => {
      const current = get().prefs.columnWidths;
      const table = { ...(current[tableId] ?? {}) };
      if (px === null) delete table[columnId];
      else table[columnId] = px;

      const columnWidths = { ...current };
      // Drop the table entry entirely once it is back to defaults, so the stored
      // prefs do not accumulate empty objects for every table ever visited.
      if (Object.keys(table).length === 0) delete columnWidths[tableId];
      else columnWidths[tableId] = table;
      update({ columnWidths });
    },

    resetColumnWidths: (tableId) => {
      const columnWidths = { ...get().prefs.columnWidths };
      if (!(tableId in columnWidths)) return;
      delete columnWidths[tableId];
      update({ columnWidths });
    },

    setPanelWidth: (panelId, px) => {
      const panelWidths = { ...get().prefs.panelWidths };
      if (px === null) delete panelWidths[panelId];
      else panelWidths[panelId] = px;
      update({ panelWidths });
    },
  };
});
