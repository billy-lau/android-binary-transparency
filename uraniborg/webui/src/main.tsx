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

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// HashRouter (not BrowserRouter) so the built app can be served from any
// sub-path by any static file server, with no server-side rewrite rules.
// It still has to be served over HTTP: browsers refuse to load the module
// bundle from file://.
import { HashRouter } from 'react-router-dom';
import { App } from './App';
import { useApp } from './lib/store';
import type { InputFile } from './lib/parse';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// Automation hooks for scripts/smoke.mjs. Compiled out of normal builds; only a
// build invoked with VITE_SMOKE_HOOKS=1 exposes them.
if (import.meta.env.VITE_SMOKE_HOOKS === '1') {
  const w = window as unknown as Record<string, unknown>;
  w.__loadObservation = (files: InputFile[]) => useApp.getState().loadFiles(files);
  w.__platformCertHash = () => {
    const s = useApp.getState();
    return s.observations.find((o) => o.id === s.activeId)?.platformCertHash ?? null;
  };
}

createRoot(container).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
