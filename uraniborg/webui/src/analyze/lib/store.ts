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
 * tab closes is a needless residual-data risk. The lightweight, non-sensitive
 * UI preferences that are persisted live in `@/shared/lib/prefs`.
 */

import { create } from 'zustand';
import {
  buildRawObservation,
  mergeInclusionProofArtifact,
  type InclusionProofMergeResult,
  type InputFile,
} from './parse';
import { buildObservation, type Observation } from './model';

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
  setPaletteOpen: (open: boolean) => void;
}

export const useApp = create<AppState>((set, get) => ({
  observations: [],
  activeId: null,
  baselineId: null,
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

  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
}));

/** The currently selected observation, or null before anything is loaded. */
export function useActiveObservation(): Observation | null {
  return useApp((s) => s.observations.find((o) => o.id === s.activeId) ?? null);
}

export function useBaselineObservation(): Observation | null {
  return useApp((s) => s.observations.find((o) => o.id === s.baselineId) ?? null);
}
