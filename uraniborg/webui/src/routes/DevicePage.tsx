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

import { useEffect, useMemo } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useActiveObservation } from '@/lib/store';
import { PageHeader } from '@/components/Layout';
import { DataTable, type Column } from '@/components/DataTable';
import { Card, CopyButton, EmptyState, KeyValue, SearchInput } from '@/components/ui';

export function DevicePage() {
  const obs = useActiveObservation();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const location = useLocation();

  // The app runs under a hash router, so `/device#diagnostics` is a route
  // fragment the browser never treats as an in-page anchor. Scroll to the
  // target ourselves. Keyed on `location.key` so clicking the diagnostics
  // banner again while already here still scrolls back to the section.
  useEffect(() => {
    if (!obs || !location.hash) return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView({ block: 'start' });
  }, [obs, location.hash, location.key]);

  const propRows = useMemo(() => {
     if (!obs) return [];
     const needle = q.toLowerCase().trim();
     return obs.deviceProps.filter(([k, v]) => {
        if (!needle) return true;
        return k.toLowerCase().includes(needle) || v.toLowerCase().includes(needle);
     });
  }, [obs, q]);

  const columns = useMemo<Array<Column<[string, string]>>>(() => [
     {
        id: 'key',
        header: 'Key',
        width: 'minmax(250px, 1fr)',
        sortValue: (r) => r[0],
        render: (r) => <div className="truncate mono text-[13px] text-ink" title={r[0]}>{r[0]}</div>
     },
     {
        id: 'value',
        header: 'Value',
        width: 'minmax(250px, 2fr)',
        sortValue: (r) => r[1],
        render: (r) => (
           <div className="flex items-center gap-2 group">
              <div className="truncate mono text-[13px] text-ink-muted" title={r[1]}>{r[1]}</div>
              <CopyButton value={r[1]} className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity" />
           </div>
        )
     }
  ], []);

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }

  const buildInfo = [
     ['OEM', obs.summary.oem || '—'],
     ['Brand', obs.summary.brand || '—'],
     ['Model Name', obs.summary.model || '—'],
     ['Device Name', obs.summary.device || '—'],
     ['Board Name', obs.hardware?.boardName || '—'],
     ['Product Name', obs.hardware?.productName || '—'],
     ['Hardware Name', obs.hardware?.hardwareName || '—'],
     ['Hardware Hash', obs.hardware?.hash || '—'],
     ['API Level', obs.summary.apiLevel?.toString() || '—'],
     ['Fingerprint', obs.summary.fingerprint ? (
         <div className="flex items-center gap-2">
            <span className="mono">{obs.summary.fingerprint}</span>
            <CopyButton value={obs.summary.fingerprint} />
         </div>
     ) : '—'],
     ['Security Patch', obs.summary.securityPatchLevel || '—'],
     ['Bootloader Version', obs.build?.bootloaderVersion || '—'],
     ['Radio Version', obs.build?.radioVersion || '—'],
     ['Kernel Version', obs.build?.kernelVersion || '—'],
     ['Locale', obs.build?.locale || '—'],
  ] as Array<[string, React.ReactNode]>;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto w-full">
      <PageHeader title="Device & Build" />

      <div className="p-6 space-y-6">
         <section>
            <h2 className="text-sm font-semibold text-ink mb-3">Build & hardware</h2>
            <Card>
               <KeyValue rows={buildInfo} />
            </Card>
         </section>

         <section id="diagnostics">
            <h2 className="text-sm font-semibold text-ink mb-3">Load diagnostics</h2>
            <Card className="p-4 space-y-4">
               <div className="text-sm">
                  <span className="text-ink-faint mr-1">Hubble Version:</span> <span className="text-ink font-semibold">{obs.hubbleVersion || 'Unknown'}</span>
               </div>
               <div>
                  <div className="text-xs text-ink-faint mb-2">Ingested Files:</div>
                  <div className="flex flex-wrap gap-2 text-xs">
                     {obs.fileNames.map(f => (
                         <span key={f} className="px-2 py-1 rounded bg-bg-raised text-ink-muted mono border border-line">{f}</span>
                     ))}
                  </div>
               </div>
               <div>
                  <div className="text-xs text-ink-faint mb-2">Diagnostics:</div>
                  {obs.diagnostics.length === 0 ? (
                     <div className="text-sm text-sev-ok flex items-center gap-2">No issues detected.</div>
                  ) : (
                     <ul className="space-y-2">
                        {obs.diagnostics.map((d, i) => {
                           const color = d.level === 'error' ? 'text-sev-critical' : d.level === 'warning' ? 'text-sev-high' : 'text-ink-muted';
                           return (
                              <li key={i} className="text-sm flex gap-2">
                                 <b className={color}>[{d.level}]</b>
                                 <span className="font-semibold mono text-ink">{d.fileName}</span>
                                 <span className="text-ink-muted">{d.message}</span>
                              </li>
                           );
                        })}
                     </ul>
                  )}
               </div>
            </Card>
         </section>

         <section>
            <h2 className="text-sm font-semibold text-ink mb-3">Device properties</h2>
            {obs.deviceProps.length === 0 ? (
               <Card>
                  <EmptyState title="No device properties loaded." hint="device_properties.txt was not included in this observation." />
               </Card>
            ) : (
               <div className="flex flex-col gap-3">
                  <div className="max-w-[400px]">
                     <SearchInput
                        value={q}
                        onChange={v => {
                           const next = new URLSearchParams(params);
                           if (v) next.set('q', v);
                           else next.delete('q');
                           setParams(next, { replace: true });
                        }}
                        placeholder="Search properties by key or value…"
                     />
                  </div>
                  <Card className="flex flex-col overflow-hidden h-[600px]">
                     <DataTable
                        tableId="device-properties"
                        rows={propRows}
                        columns={columns}
                        rowKey={([k]) => k}
                        initialSort={{ columnId: 'key', direction: 'asc' }}
                        maxHeight="100%"
                     />
                  </Card>
               </div>
            )}
         </section>
      </div>
    </div>
  );
}
