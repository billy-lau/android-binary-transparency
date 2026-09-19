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

/** App chrome: sidebar navigation, observation switcher, global shortcuts. */

import { useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Boxes,
  FileStack,
  GitCompare,
  KeyRound,
  Library,
  Package,
  Search,
  Settings2,
  ShieldCheck,
  Telescope,
  Upload,
  Users,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useActiveObservation, useApp } from '@/lib/store';
import { CommandPalette } from './CommandPalette';
import { PanelResizer, useResizablePanel } from './Resizable';

const NAV = [
  { to: '/overview', label: 'Overview', icon: Telescope },
  { to: '/packages', label: 'Packages', icon: Package },
  { to: '/certificates', label: 'Signing certs', icon: KeyRound },
  { to: '/shared-uids', label: 'Shared UIDs', icon: Users },
  { to: '/permissions', label: 'Permissions', icon: ShieldCheck },
  { to: '/components', label: 'Components', icon: Boxes },
  { to: '/integrity', label: 'Integrity', icon: FileStack },
  { to: '/binaries', label: 'Binaries & libs', icon: Library },
  { to: '/device', label: 'Device & build', icon: Settings2 },
  { to: '/compare', label: 'Compare', icon: GitCompare },
] as const;

export function Layout() {
  const navigate = useNavigate();
  const observations = useApp((s) => s.observations);
  const activeId = useApp((s) => s.activeId);
  const setActive = useApp((s) => s.setActive);
  const removeObservation = useApp((s) => s.removeObservation);
  const setPaletteOpen = useApp((s) => s.setPaletteOpen);
  const active = useActiveObservation();
  // Observation titles and nav labels are long; let the rail grow.
  const sidebar = useResizablePanel('nav-sidebar', {
    defaultWidth: 224,
    min: 168,
    max: 420,
    edge: 'end',
  });

  // Global shortcut: Cmd/Ctrl-K opens the search palette.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setPaletteOpen]);

  const errorCount = active?.diagnostics.filter((d) => d.level === 'error').length ?? 0;
  const warnCount = active?.diagnostics.filter((d) => d.level === 'warning').length ?? 0;

  return (
    <div className={clsx('flex h-full min-h-0', sidebar.resizing && 'select-none')}>
      <aside
        className="flex shrink-0 flex-col border-r border-line bg-bg-soft"
        style={{ width: sidebar.width }}
      >
        <div className="flex items-center gap-2 px-4 py-3">
          <Telescope size={18} className="text-accent" />
          <div className="leading-tight">
            <div className="text-sm font-semibold">Uraniborg</div>
            <div className="text-[10px] uppercase tracking-widest text-ink-faint">Explorer</div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mx-3 mb-3 flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-1.5 text-xs text-ink-faint hover:border-accent/50 hover:text-ink"
        >
          <Search size={13} />
          <span className="flex-1 text-left">Search everything</span>
          <kbd className="rounded border border-line px-1 text-[10px]">⌘K</kbd>
        </button>

        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                clsx(
                  'mb-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors',
                  isActive
                    ? 'bg-accent/15 font-medium text-accent'
                    : 'text-ink-muted hover:bg-bg-hover hover:text-ink',
                )
              }
            >
              <Icon size={15} />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="border-t border-line p-2">
          <div className="label px-1.5 pb-1">Observations</div>
          {observations.map((o) => (
            <div
              key={o.id}
              className={clsx(
                'group mb-0.5 flex items-center gap-1 rounded-md px-2 py-1.5 text-xs',
                o.id === activeId
                  ? 'bg-bg-raised text-ink'
                  : 'text-ink-muted hover:bg-bg-hover',
              )}
            >
              <button
                type="button"
                onClick={() => setActive(o.id)}
                className="min-w-0 flex-1 text-left"
                title={o.summary.fingerprint || o.title}
              >
                <div className="truncate font-medium">{o.title}</div>
                <div className="truncate text-[10px] text-ink-faint">
                  {o.packages.length} pkgs
                  {o.summary.apiLevel ? ` · API ${o.summary.apiLevel}` : ''}
                </div>
              </button>
              <button
                type="button"
                title="Unload"
                onClick={() => removeObservation(o.id)}
                className="opacity-0 transition-opacity hover:text-sev-critical group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => navigate('/load')}
            className="mt-1 flex w-full items-center gap-2 rounded-md border border-dashed border-line px-2 py-1.5 text-xs text-ink-faint hover:border-accent/50 hover:text-accent"
          >
            <Upload size={12} />
            Load observation
          </button>
        </div>
      </aside>

      <PanelResizer label="Resize navigation sidebar" active={sidebar.resizing} {...sidebar.resizerProps} />

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {active && (errorCount > 0 || warnCount > 0) && (
          <button
            type="button"
            onClick={() => navigate('/device#diagnostics')}
            className="flex items-center gap-2 border-b border-sev-high/30 bg-sev-high/10 px-4 py-1.5 text-left text-xs text-sev-high"
          >
            <AlertTriangle size={13} />
            {errorCount > 0 && <span>{errorCount} load error(s).</span>}
            {warnCount > 0 && <span>{warnCount} load warning(s).</span>}
            <span className="text-ink-faint">View diagnostics →</span>
          </button>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </main>

      <CommandPalette />
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-bg-soft/60 px-6 py-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold">{title}</h1>
        {subtitle && <div className="mt-0.5 text-xs text-ink-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
