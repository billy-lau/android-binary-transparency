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
import { Badge, CopyButton, EmptyState, HashText, SearchInput, Tabs } from '@/components/ui';
import { downloadBlob, formatBytes, toCsv } from '@/lib/format';
import type { RawBinary, RawLibrary } from '@/lib/types';

export function BinariesPage() {
  const obs = useActiveObservation();
  const [params, setParams] = useSearchParams();

  // Validated rather than cast: an unknown `?tab=` would otherwise render the
  // libraries with the binaries' column set and leave no tab selected.
  const tab: 'bins' | 'libs' = params.get('tab') === 'libs' ? 'libs' : 'bins';
  const q = params.get('q') ?? '';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    if (!obs) return [];
    const needle = q.toLowerCase().trim();
    const source: Array<RawBinary | RawLibrary> = tab === 'bins' ? obs.bins : obs.libs;
    return source.filter(r => {
      if (!needle) return true;
      if (r.name.toLowerCase().includes(needle)) return true;
      if (r.installPath?.toLowerCase().includes(needle)) return true;
      if (r.hash?.toLowerCase().startsWith(needle)) return true;
      return false;
    });
  }, [obs, tab, q]);

  const columns = useMemo<Array<Column<RawBinary | RawLibrary>>>(() => {
    const base: Array<Column<RawBinary | RawLibrary>> = [
      {
        id: 'name',
        header: 'Name',
        width: 'minmax(180px, 1fr)',
        sortValue: (r) => r.name,
        render: (r) => (
          <div className="truncate font-semibold">{r.name}</div>
        ),
      },
      {
        id: 'path',
        header: 'Install Path',
        width: 'minmax(200px, 2fr)',
        sortValue: (r) => r.installPath ?? '',
        render: (r) => (
          <div className="truncate mono text-ink-muted text-[11px]" title={r.installPath ?? ''}>
            {r.installPath ?? '—'}
          </div>
        ),
      },
      {
        id: 'hash',
        header: 'SHA-256',
        width: 'minmax(180px, 1fr)',
        sortValue: (r) => r.hash ?? '',
        render: (r) => (
          <div className="flex items-center gap-1.5">
             <HashText value={r.hash} bytes={10} />
             {r.hash && <CopyButton value={r.hash} />}
          </div>
        )
      },
      {
        id: 'size',
        header: 'Size',
        width: '100px',
        align: 'right',
        sortValue: (r) => r.fileSizeInBytes ?? 0,
        render: (r) => <span className="text-xs text-ink-muted">{formatBytes(r.fileSizeInBytes)}</span>,
      },
    ];
    if (tab === 'libs') {
      base.splice(1, 0, {
        id: 'bits',
        header: 'Bits',
        width: '80px',
        sortValue: (r) => (r as RawLibrary).bits ?? 0,
        render: (r) => {
            const l = r as RawLibrary;
            return <Badge tone="neutral">{l.bits ? `${l.bits}-bit` : '—'}</Badge>;
        }
      });
    }
    return base;
  }, [tab]);

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }

  const exportCsv = () => {
    const isLibs = tab === 'libs';
    const headers = ['name', 'installPath', 'sha256', 'fileSizeInBytes'];
    if (isLibs) headers.splice(1, 0, 'bits');

    const csv = toCsv(headers, rows.map(r => {
       const cols: (string | number | boolean | null)[] = [r.name, r.installPath, r.hash, r.fileSizeInBytes ?? null];
       if (isLibs) cols.splice(1, 0, (r as RawLibrary).bits);
       return cols;
    }));
    downloadBlob(`${obs.title.replace(/\W+/g, '_')}_${tab}.csv`, csv, 'text/csv');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
       <PageHeader
        title="Binaries & Libraries"
        subtitle={`${rows.length.toLocaleString()} of ${(tab === 'bins' ? obs.bins.length : obs.libs.length).toLocaleString()} shown`}
        actions={
          <button className="btn" onClick={exportCsv}>
            <Download size={12} /> Export CSV
          </button>
        }
      />
      <div className="px-6 py-4 border-b border-line bg-bg-soft/50 text-sm xl:max-w-[80%] text-ink-muted">
        <p>
          These are the native binaries and libraries reachable by an untrusted app, i.e. the <strong>local attack surface</strong>. The SHA-256 values can be pivoted on in external corpora.
        </p>
      </div>
      <div className="px-6 pt-3">
         <Tabs
            tabs={[
               { id: 'bins', label: 'Binaries', count: obs.bins.length },
               { id: 'libs', label: 'Libraries', count: obs.libs.length },
            ]}
            value={tab}
            onChange={(v) => {
              // One update, not two setParam calls: each builds on the same
              // captured `params`, so the second would silently drop the tab.
              const next = new URLSearchParams(params);
              next.set('tab', v);
              next.delete('q');
              setParams(next, { replace: true });
            }}
         />
      </div>
      <div className="space-y-2 border-b border-line px-6 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-[280px] flex-1">
            <SearchInput
              value={q}
              onChange={(v) => setParam('q', v || null)}
              placeholder="Filter by name, install path, or hash prefix…"
            />
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 px-6 py-3">
        <div className="card flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            // Separate ids: the two tabs do not share a column set.
            tableId={`binaries-${tab}`}
            rows={rows}
            columns={columns}
            rowKey={(r) => `${r.installPath}_${r.name}_${r.hash}`}
            initialSort={{ columnId: 'name', direction: 'asc' }}
            maxHeight="calc(100vh - 350px)"
          />
        </div>
      </div>
    </div>
  );
}
