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
 * Application state.
 *
 * Observations live in memory only. We deliberately do NOT persist parsed
 * device inventories to localStorage/IndexedDB: a Hubble observation is a full
 * inventory of a physical device and leaving it in browser storage after the
 * tab closes is a needless residual-data risk. Only lightweight, non-sensitive
 * UI preferences are persisted.
 */

import { create } from 'zustand';
import {
  buildRawObservation,
  mergeInclusionProofArtifact,
  type InclusionProofMergeResult,
  type InputFile,
} from './parse';
import { buildObservation, type Observation } from './model';

const PREFS_KEY = 'uraniborg-explorer/prefs/v1';

interface Prefs {
  density: 'comfortable' | 'compact';
  /**
   * User-resized table columns, in CSS pixels, keyed by table id then column
   * id. Purely presentational, so it is safe to keep across sessions — nothing
   * here describes the observed device.
   */
  columnWidths: Record<string, Record<string, number>>;
  /** Resizable side panels (nav rail, detail panes), in CSS pixels, by panel id. */
  panelWidths: Record<string, number>;
}

const DEFAULT_PREFS: Prefs = { density: 'comfortable', columnWidths: {}, panelWidths: {} };

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>;
      return {
        ...DEFAULT_PREFS,
        ...parsed,
        // Tolerate prefs written before the size overrides existed, or hand-edited.
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

/**
 * The result of attempting to load a set of files.
 *
 * A failed load commits nothing: an observation with no packages cannot
 * populate a single view, and half-loading one would strand the user on an
 * empty overview with no indication of what went wrong.
 */
export type LoadOutcome =
  | { ok: true; observation: Observation }
  | { ok: false; error: string };

interface AppState {
  observations: Observation[];
  activeId: string | null;
  baselineId: string | null;
  prefs: Prefs;
  paletteOpen: boolean;

  loadFiles: (files: InputFile[], title?: string) => LoadOutcome;
  /**
   * Folds inclusion-proof results into an already-loaded observation.
   *
   * The observation keeps its id, title and load time, so the dataset
   * switcher, the active selection and any baseline pairing all survive: from
   * the user's point of view the transparency data appeared, nothing was
   * reloaded.
   */
  mergeInclusionProof: (
    observationId: string,
    files: InputFile[],
  ) => Omit<InclusionProofMergeResult, 'observation'>;
  setActive: (id: string) => void;
  setBaseline: (id: string | null) => void;
  removeObservation: (id: string) => void;
  clearAll: () => void;
  setDensity: (d: Prefs['density']) => void;
  /** Sets one column's width in px, or clears it when `px` is null. */
  setColumnWidth: (tableId: string, columnId: string, px: number | null) => void;
  resetColumnWidths: (tableId: string) => void;
  /** Sets a panel's width in px, or clears it back to the default when null. */
  setPanelWidth: (panelId: string, px: number | null) => void;
  setPaletteOpen: (open: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  observations: [],
  activeId: null,
  baselineId: null,
  prefs: loadPrefs(),
  paletteOpen: false,

  loadFiles: (files, title) => {
    const raw = buildRawObservation(files);
    // Gate on the parsed result rather than on filenames: the set is usable if
    // it yielded packages, whatever it was called. Rejecting here keeps the
    // store free of observations that no view can render.
    if (raw.packages.length === 0) {
      const fatal = raw.diagnostics.find((d) => d.level === 'error');
      return {
        ok: false,
        error: fatal?.message ?? 'No packages found. packages.txt is required.',
      };
    }
    const observation = buildObservation(raw, title);
    set((s) => ({
      observations: [...s.observations, observation],
      activeId: observation.id,
      // Second and later loads default to comparing against the first.
      baselineId: s.baselineId ?? (s.observations.length > 0 ? s.observations[0].id : null),
    }));
    return { ok: true, observation };
  },

  mergeInclusionProof: (observationId, files) => {
    const existing = get().observations.find((o) => o.id === observationId);
    if (!existing) {
      return { packagesCovered: 0, fileName: null, error: 'That observation is no longer loaded.' };
    }
    const { observation: raw, ...outcome } = mergeInclusionProofArtifact(existing.raw, files);
    if (outcome.packagesCovered === 0) return outcome;

    const rebuilt: Observation = {
      ...buildObservation(raw, existing.title),
      id: existing.id,
      loadedAt: existing.loadedAt,
    };
    set((s) => ({
      observations: s.observations.map((o) => (o.id === observationId ? rebuilt : o)),
    }));
    return outcome;
  },

  setActive: (id) => set({ activeId: id }),
  setBaseline: (id) => set({ baselineId: id }),

  removeObservation: (id) =>
    set((s) => {
      const observations = s.observations.filter((o) => o.id !== id);
      return {
        observations,
        activeId: s.activeId === id ? (observations[0]?.id ?? null) : s.activeId,
        baselineId: s.baselineId === id ? null : s.baselineId,
      };
    }),

  clearAll: () => set({ observations: [], activeId: null, baselineId: null }),

  setDensity: (density) => {
    const prefs = { ...get().prefs, density };
    persistPrefs(prefs);
    set({ prefs });
  },

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

    const prefs = { ...get().prefs, columnWidths };
    persistPrefs(prefs);
    set({ prefs });
  },

  resetColumnWidths: (tableId) => {
    const columnWidths = { ...get().prefs.columnWidths };
    if (!(tableId in columnWidths)) return;
    delete columnWidths[tableId];
    const prefs = { ...get().prefs, columnWidths };
    persistPrefs(prefs);
    set({ prefs });
  },

  setPanelWidth: (panelId, px) => {
    const panelWidths = { ...get().prefs.panelWidths };
    if (px === null) delete panelWidths[panelId];
    else panelWidths[panelId] = px;
    const prefs = { ...get().prefs, panelWidths };
    persistPrefs(prefs);
    set({ prefs });
  },

  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));

/** The currently selected observation, or null before anything is loaded. */
export function useActiveObservation(): Observation | null {
  return useApp((s) => s.observations.find((o) => o.id === s.activeId) ?? null);
}

export function useBaselineObservation(): Observation | null {
  return useApp((s) => s.observations.find((o) => o.id === s.baselineId) ?? null);
}
