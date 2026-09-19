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

import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useActiveObservation } from '@/lib/store';
import { PageHeader } from '@/components/Layout';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, EmptyState, SearchInput, Toggle } from '@/components/ui';
import { shortClassName, shortPermission, toCsv, downloadBlob } from '@/lib/format';
import { isUnguarded, type ExportedComponentRef } from '@/lib/model';
import { PROVIDER_OP_LABEL, PROVIDER_REACH_TONE, providerGateSummary } from '@/lib/providers';

export function ComponentsPage() {
  const obs = useActiveObservation();
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  const typeFilter = params.get('type') ?? 'all';
  const onlyExported = params.get('exported') === '1';
  // Same param name as the Packages page's "Has unguarded exports" filter.
  const onlyUnguarded = params.get('unguarded') === '1';
  const onlyGrantUri = params.get('granturi') === '1';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const allComponents = useMemo(() => {
    if (!obs) return [];
    const arr: ExportedComponentRef[] = [];
    for (const p of obs.packages) {
      for (const c of p.exportedComponents) {
        arr.push(c);
      }
    }
    return arr;
  }, [obs]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return allComponents.filter((c) => {
      if (typeFilter !== 'all' && c.componentType !== typeFilter) return false;
      if (onlyExported && !c.isExported) return false;
      if (onlyUnguarded && !isUnguarded(c)) return false;
      if (onlyGrantUri && !c.grantUriPermissions) return false;
      if (needle) {
        if (
          !c.name.toLowerCase().includes(needle) &&
          !c.packageName.toLowerCase().includes(needle) &&
          !(c.authority && c.authority.toLowerCase().includes(needle)) &&
          !(c.permission && c.permission.toLowerCase().includes(needle))
        ) {
          return false;
        }
      }
      return true;
    });
  }, [allComponents, q, typeFilter, onlyExported, onlyUnguarded, onlyGrantUri]);

  const unguardedExportedCount = useMemo(() => {
    return rows.reduce((acc, c) => acc + (isUnguarded(c) ? 1 : 0), 0);
  }, [rows]);

  const columns = useMemo<Array<Column<ExportedComponentRef>>>(
    () => [
      {
        id: 'name',
        header: 'Component',
        width: 'minmax(250px, 2fr)',
        sortValue: (c) => c.name,
        render: (c) => (
          <span className="mono truncate text-[13px] text-ink" title={c.name}>
            {shortClassName(c.name)}
          </span>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        width: '90px',
        sortValue: (c) => c.componentType,
        render: (c) => <Badge tone="neutral">{c.componentType}</Badge>,
      },
      {
        id: 'package',
        header: 'Package',
        width: 'minmax(200px, 1.5fr)',
        sortValue: (c) => c.packageName,
        render: (c) => (
          <Link
            to={`/packages/${encodeURIComponent(c.packageName)}?tab=components`}
            className="link truncate text-sm"
          >
            {c.packageName}
          </Link>
        ),
      },
      {
        id: 'exported',
        header: 'Exported',
        width: '110px',
        sortValue: (c) => (c.isExported ? 1 : 0),
        render: (c) =>
          c.isExported ? (
            <Badge tone="warn">yes</Badge>
          ) : (
            <Badge tone="neutral">no</Badge>
          ),
      },
      {
        id: 'enabled',
        header: 'Enabled',
        width: '105px',
        sortValue: (c) => (c.isEnabled ? 1 : 0),
        render: (c) =>
          c.isEnabled ? (
            <Badge tone="good">yes</Badge>
          ) : (
            <Badge tone="neutral">no</Badge>
          ),
      },
      {
        id: 'permission',
        header: 'Permission guard',
        width: 'minmax(220px, 2fr)',
        sortValue: (c) => c.permission ?? '',
        render: (c) => {
          // Providers carry independent read and write guards; both are shown
          // inline so the row keeps the virtualiser's fixed height. See
          // lib/providers.ts for what an absent permission does and does not
          // mean — in particular that it is not missing data.
          if (c.componentType === 'provider') {
            return (
              <span className="flex min-w-0 items-center gap-3 text-xs">
                {providerGateSummary(c).map((g) => (
                  <span
                    key={g.op}
                    className="flex min-w-0 items-center gap-1"
                    title={g.title}
                  >
                    <span className="shrink-0 text-ink-faint">{PROVIDER_OP_LABEL[g.op]}</span>
                    {g.reach === 'guarded' ? (
                      // Truncates rather than pushing the other gate out of the
                      // cell; vendor permission names are routinely longer than
                      // the column.
                      <span className="mono min-w-0 truncate text-[11px]" title={g.permission ?? ''}>
                        {g.label}
                      </span>
                    ) : (
                      <span className="shrink-0">
                        <Badge tone={PROVIDER_REACH_TONE[g.reach]}>{g.label}</Badge>
                      </span>
                    )}
                  </span>
                ))}
              </span>
            );
          }
          return c.permission ? (
            <span className="mono truncate text-[11px]" title={c.permission}>
              {shortPermission(c.permission)}
            </span>
          ) : c.isExported && c.isEnabled ? (
            <Badge tone="bad">any app</Badge>
          ) : (
            <Badge tone="neutral">not enforced</Badge>
          );
        },
      },
      {
        id: 'authority',
        header: 'Authority',
        width: 'minmax(180px, 1.5fr)',
        sortValue: (c) => c.authority ?? '',
        render: (c) =>
          c.authority ? (
            <span className="mono truncate text-[11px] text-ink-muted">{c.authority}</span>
          ) : (
            <span className="text-ink-faint">—</span>
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
      ['name', 'componentType', 'packageName', 'isExported', 'isEnabled', 'permission', 'permissionRead', 'permissionWrite', 'authority', 'grantUriPermissions'],
      rows.map((c) => [
        c.name,
        c.componentType,
        c.packageName,
        c.isExported,
        c.isEnabled,
        c.permission ?? null,
        c.permissionRead ?? null,
        c.permissionWrite ?? null,
        c.authority ?? null,
        c.grantUriPermissions ?? null,
      ]),
    );
    downloadBlob(`${obs.title.replace(/\W+/g, '_')}_components.csv`, csv, 'text/csv');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Components"
        subtitle={`${rows.length.toLocaleString()} of ${allComponents.length.toLocaleString()} components shown · ${unguardedExportedCount.toLocaleString()} unguarded exported`}
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
              placeholder="Search components, packages, permissions or authorities…"
            />
          </div>
          <select
            className="input w-auto"
            value={typeFilter}
            onChange={(e) => setParam('type', e.target.value === 'all' ? null : e.target.value)}
          >
            <option value="all">All types</option>
            <option value="activity">Activity</option>
            <option value="service">Service</option>
            <option value="receiver">Receiver</option>
            <option value="provider">Provider</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <Toggle
            checked={onlyExported}
            onChange={(v) => setParam('exported', v ? '1' : null)}
            label="Only exported"
          />
          <Toggle
            checked={onlyUnguarded}
            onChange={(v) => setParam('unguarded', v ? '1' : null)}
            label="Only unguarded (exported+enabled, no permission)"
          />
          <Toggle
            checked={onlyGrantUri}
            onChange={(v) => setParam('granturi', v ? '1' : null)}
            label="grantUriPermissions"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 px-6 py-3">
        <div className="card flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            tableId="components"
            rows={rows}
            columns={columns}
            rowKey={(c) => `${c.packageName}:${c.name}`}
            initialSort={{ columnId: 'name', direction: 'asc' }}
            maxHeight="calc(100vh - 320px)"
          />
        </div>
      </div>
    </div>
  );
}
