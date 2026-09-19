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

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, X } from 'lucide-react';
import clsx from 'clsx';
import { useActiveObservation } from '@/lib/store';
import { PageHeader } from '@/components/Layout';
import { DataTable, type Column } from '@/components/DataTable';
import { PanelResizer, useResizablePanel } from '@/components/Resizable';
import {
  Badge,
  EmptyState,
  SearchInput,
  SensitivitySourceNote,
  SeverityBadge,
  Toggle,
  Card,
  CopyButton,
} from '@/components/ui';
import { shortPermission, toCsv, downloadBlob } from '@/lib/format';
import { SEVERITY_ORDER, severityRank } from '@/lib/sensitivity';
import type { PermissionUsage } from '@/lib/model';

export function PermissionsPage() {
  const obs = useActiveObservation();
  const [params, setParams] = useSearchParams();
  const [selectedPermName, setSelectedPermName] = useState<string | null>(null);
  // The detail pane lists fully qualified package names; 380px is a starting
  // point, not a fit.
  const detail = useResizablePanel('permission-detail', {
    defaultWidth: 380,
    min: 260,
    max: 900,
    edge: 'start',
  });

  const q = params.get('q') ?? '';
  const sev = params.get('sev') ?? 'all';
  const onlyRisky = params.get('risky') === '1';
  const onlyDeclared = params.get('declared') === '1';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    if (!obs) return [];
    const needle = q.trim().toLowerCase();
    return obs.permissions.filter((p) => {
      if (needle && !p.name.toLowerCase().includes(needle)) return false;
      if (sev !== 'all' && p.severity !== sev) return false;
      if (onlyRisky && !p.severity) return false;
      if (onlyDeclared && p.declaredBy.length === 0) return false;
      return true;
    });
  }, [obs, q, sev, onlyRisky, onlyDeclared]);

  const columns = useMemo<Array<Column<PermissionUsage>>>(
    () => [
      {
        id: 'name',
        header: 'Permission',
        width: 'minmax(250px, 2fr)',
        sortValue: (p) => p.name,
        render: (p) => (
          <span className="mono truncate text-[13px] text-ink" title={p.name}>
            {shortPermission(p.name)}
          </span>
        ),
      },
      {
        id: 'severity',
        header: 'Sensitivity',
        width: '135px',
        // Unranked permissions sort last.
        sortValue: (p) => severityRank(p.severity),
        render: (p) => p.severity ? <SeverityBadge severity={p.severity} /> : null,
      },
      {
        id: 'granted',
        header: 'Granted',
        width: '110px',
        align: 'right',
        sortValue: (p) => p.grantedTo.length,
        render: (p) => <span className="text-xs">{p.grantedTo.length}</span>,
      },
      {
        id: 'requested',
        header: 'Refused',
        title: 'Packages that requested this permission but were not granted it',
        width: '110px',
        align: 'right',
        sortValue: (p) => p.requestedNotGranted.length,
        render: (p) => <span className="text-xs text-ink-muted">{p.requestedNotGranted.length}</span>,
      },
      {
        id: 'declaring',
        header: 'Declaring',
        width: '110px',
        align: 'right',
        sortValue: (p) => p.declaredBy.length,
        render: (p) => <span className="text-xs">{p.declaredBy.length}</span>,
      },
      {
        id: 'protection',
        header: 'Protection levels',
        width: 'minmax(150px, 1fr)',
        render: (p) => (
          <div className="flex flex-wrap gap-1">
            {p.protectionLevels.map((l) => (
              <Badge
                key={l}
                tone={l.includes('signature') || l.includes('privileged') ? 'warn' : 'neutral'}
              >
                {l}
              </Badge>
            ))}
          </div>
        ),
      },
    ],
    [],
  );

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }

  const exportCsv = () => {
    const csv = toCsv(
      ['name', 'sensitivity', 'grantedToCount', 'requestedNotGrantedCount', 'declaredByCount', 'protectionLevels'],
      rows.map((p) => [
        p.name,
        p.severity ?? '',
        p.grantedTo.length,
        p.requestedNotGranted.length,
        p.declaredBy.length,
        p.protectionLevels.join('|'),
      ]),
    );
    downloadBlob(`${obs.title.replace(/\W+/g, '_')}_permissions.csv`, csv, 'text/csv');
  };

  const selectedPerm = selectedPermName ? obs.permissionsByName.get(selectedPermName) ?? null : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Permissions"
        subtitle={`${rows.length.toLocaleString()} permissions shown`}
        actions={
          <button className="btn" onClick={exportCsv}>
            <Download size={12} /> Export CSV
          </button>
        }
      />

      <div className="space-y-2 border-b border-line px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[280px] flex-1">
            <SearchInput
              value={q}
              onChange={(v) => setParam('q', v || null)}
              placeholder="Search permissions…"
            />
          </div>
          <select
            className="input w-auto"
            value={sev}
            onChange={(e) => setParam('sev', e.target.value === 'all' ? null : e.target.value)}
          >
            <option value="all">All sensitivity tiers</option>
            {SEVERITY_ORDER.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <Toggle
            checked={onlyRisky}
            onChange={(v) => setParam('risky', v ? '1' : null)}
            label="Only listed sensitive permissions"
          />
          <Toggle
            checked={onlyDeclared}
            onChange={(v) => setParam('declared', v ? '1' : null)}
            label="Only custom/app-declared"
          />
        </div>

        <SensitivitySourceNote />
      </div>

      <div className={clsx('min-h-0 flex-1 px-6 py-3', detail.resizing && 'select-none')}>
        <div className="flex h-full min-h-0 gap-2">
          <div className="card flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <DataTable
              tableId="permissions"
              rows={rows}
              columns={columns}
              rowKey={(p) => p.name}
              initialSort={{ columnId: 'name', direction: 'asc' }}
              onRowClick={(p) => setSelectedPermName(p.name)}
              maxHeight="calc(100vh - 320px)"
            />
          </div>

          {selectedPerm && (
            <>
              <PanelResizer
                label="Resize permission details panel"
                active={detail.resizing}
                {...detail.resizerProps}
              />
              <Card
                title="Permission Details"
                className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden"
                style={{ width: detail.width }}
                actions={
                  <button className="text-ink-muted hover:text-ink" onClick={() => setSelectedPermName(null)}>
                    <X size={16} />
                  </button>
                }
              >
              <div className="flex-1 overflow-y-auto p-4 space-y-6">
                <div>
                  <div className="text-xs font-semibold text-ink-faint mb-1">Name</div>
                  <div className="flex items-start justify-between gap-2">
                    <span className="mono text-sm break-all">{selectedPerm.name}</span>
                    <CopyButton value={selectedPerm.name} />
                  </div>
                </div>

                {selectedPerm.severity && (
                  <div>
                    <div className="text-xs font-semibold text-ink-faint mb-1">Sensitivity</div>
                    <SeverityBadge severity={selectedPerm.severity} />
                  </div>
                )}

                <div>
                  <Link
                    to={`/packages?perm=${encodeURIComponent(selectedPerm.name)}`}
                    className="link text-sm"
                  >
                    Filter packages by this permission →
                  </Link>
                </div>

                <div>
                  <div className="text-xs font-semibold text-ink-faint mb-1">Granted to ({selectedPerm.grantedTo.length})</div>
                  {selectedPerm.grantedTo.length > 0 ? (
                    <ul className="space-y-1">
                      {selectedPerm.grantedTo.map(pkg => (
                        <li key={pkg}>
                          <Link className="link text-sm break-all" to={`/packages/${encodeURIComponent(pkg)}`}>{pkg}</Link>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="text-sm text-ink-muted">None</div>}
                </div>

                <div>
                  <div className="text-xs font-semibold text-ink-faint mb-1">Requested but not granted ({selectedPerm.requestedNotGranted.length})</div>
                  {selectedPerm.requestedNotGranted.length > 0 ? (
                    <ul className="space-y-1">
                      {selectedPerm.requestedNotGranted.map(pkg => (
                        <li key={pkg}>
                          <Link className="link text-sm break-all" to={`/packages/${encodeURIComponent(pkg)}`}>{pkg}</Link>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="text-sm text-ink-muted">None</div>}
                </div>

                <div>
                  <div className="text-xs font-semibold text-ink-faint mb-1">Declaring packages ({selectedPerm.declaredBy.length})</div>
                  {selectedPerm.declaredBy.length > 0 ? (
                    <ul className="space-y-1">
                      {selectedPerm.declaredBy.map(pkg => (
                        <li key={pkg}>
                          <Link className="link text-sm break-all" to={`/packages/${encodeURIComponent(pkg)}`}>{pkg}</Link>
                        </li>
                      ))}
                    </ul>
                  ) : <div className="text-sm text-ink-muted">None</div>}
                </div>
              </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
