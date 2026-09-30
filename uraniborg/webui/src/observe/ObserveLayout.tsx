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
 * Observe shell: a slim top bar and the page. No sidebar, as Observe has
 * only the form and the run.
 */

import { Link, NavLink, Outlet } from 'react-router-dom';
import { FolderOpen, Telescope } from 'lucide-react';
import { analyzePath } from '@/analyze/paths';

export function ObserveLayout() {
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-line bg-bg-soft px-4 py-2.5">
        <div className="flex items-center gap-3">
          <Link to="/" className="flex items-center gap-2" title="Back to the start page">
            <Telescope size={20} className="text-accent" />
            <span className="text-sm font-semibold">Uraniborg Explorer</span>
          </Link>
          <span className="text-ink-faint">/</span>
          <NavLink to="/observe" end className="text-sm text-ink-muted hover:text-ink">
            Observe
          </NavLink>
        </div>
        <Link to={analyzePath('/load')} className="btn">
          <FolderOpen size={14} />
          Analyze results
        </Link>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
