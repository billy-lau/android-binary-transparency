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
 * Integrity view — Android Binary Transparency coverage across the device.
 *
 * Pairs each package's APK/split digests with the inclusion-proof results
 * produced by scripts/python/inclusion_proof_check.py, so an analyst can see at
 * a glance which binaries are attestable against the public log and which are
 * not.
 */

import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Info } from 'lucide-react';
import { useActiveObservation } from '@/lib/store';
import {
  INSTALL_STATE_LABEL,
  PROOF_STATE_RANK,
  type PackageView,
} from '@/lib/model';
import { PageHeader } from '@/components/Layout';
import { LoadInclusionProofButton } from '@/components/LoadInclusionProofButton';
import { DataTable, type Column } from '@/components/DataTable';
import {
  Card,
  EmptyState,
  PROOF_FILTER_OPTIONS,
  ProofBadge,
  SearchInput,
  Stat,
  Toggle,
  parseProofFilter,
} from '@/components/ui';
import { downloadBlob, toCsv } from '@/lib/format';

const STATE_OPTIONS = PROOF_FILTER_OPTIONS;

export function IntegrityPage() {
  const obs = useActiveObservation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  // Validated rather than cast: an unknown `?proof=` would filter out every
  // row while the select still read "All transparency states".
  const proofFilter = parseProofFilter(params.get('proof'));
  const onlyPreinstalled = params.get('pre') === '1';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    if (!obs) return [] as PackageView[];
    const needle = q.trim().toLowerCase();
    return obs.packages.filter((p) => {
      if (needle) {
        const hit =
          p.searchBlob.includes(needle) ||
          p.splits.some((s) => s.hash?.toLowerCase().includes(needle));
        if (!hit) return false;
      }
      if (proofFilter !== 'all' && p.inclusionProof.state !== proofFilter) return false;
      if (onlyPreinstalled && !p.raw.isPreinstalled) return false;
      return true;
    });
  }, [obs, q, proofFilter, onlyPreinstalled]);

  const columns = useMemo<Array<Column<PackageView>>>(
    () => [
      {
        id: 'name',
        header: 'Package',
        width: 'minmax(240px, 1.6fr)',
        sortValue: (p) => p.name,
        render: (p) => (
          <div className="min-w-0">
            <div className="truncate text-[13px]">{p.label}</div>
            <div className="truncate mono text-[11px] text-ink-faint">{p.name}</div>
          </div>
        ),
      },
      {
        id: 'state',
        header: 'Provenance',
        width: 'minmax(150px, 0.9fr)',
        sortValue: (p) => p.installState,
        render: (p) => (
          <span className="text-xs text-ink-muted">{INSTALL_STATE_LABEL[p.installState]}</span>
        ),
      },
      {
        id: 'hash',
        header: 'Base APK SHA-256',
        width: 'minmax(180px, 1.2fr)',
        sortValue: (p) => p.raw.hash ?? '',
        // Full digest, clipped by the cell, so widening the column shows more
        // of it rather than more empty space. Same reasoning as the signer
        // hash on the certificates page.
        render: (p) => (
          <span className="min-w-0 truncate mono text-[11px] text-ink-muted" title={p.raw.hash ?? ''}>
            {p.raw.hash ?? '—'}
          </span>
        ),
      },
      {
        id: 'splits',
        header: 'Splits in log',
        width: '110px',
        align: 'right',
        sortValue: (p) => p.splits.length,
        title: 'Splits found in the transparency log, out of the splits recorded on device',
        render: (p) => (
          <span className="text-xs tabular-nums">
            {p.inclusionProof.state === 'unchecked' ? (
              <span className="text-ink-faint">— / {p.splits.length}</span>
            ) : (
              <>
                <span className={p.inclusionProof.failed > 0 ? 'text-sev-critical' : undefined}>
                  {p.inclusionProof.verified}
                </span>
                <span className="text-ink-faint"> / {p.splits.length}</span>
              </>
            )}
          </span>
        ),
      },
      {
        id: 'proof',
        header: 'Transparency log',
        width: 'minmax(150px, 0.9fr)',
        sortValue: (p) => PROOF_STATE_RANK[p.inclusionProof.state],
        render: (p) => <ProofBadge proof={p.inclusionProof} compact />,
      },
      {
        id: 'note',
        header: 'Caveat',
        width: 'minmax(200px, 1.2fr)',
        render: (p) =>
          p.raw.isUpdatedSystemApp ? (
            <span
              className="truncate text-[11px] text-sev-high"
              title="Hash describes the /data/app update, not the factory binary"
            >
              hash is of the update, not factory
            </span>
          ) : p.installState === 'updated-mainline' ? (
            <span className="truncate text-[11px] text-sev-high">Mainline-updated APEX</span>
          ) : (
            <span className="text-[11px] text-ink-faint">—</span>
          ),
      },
    ],
    [],
  );

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }

  const counts = obs.inclusionProofCounts;

  const exportCsv = () => {
    const csv = toCsv(
      ['package', 'provenance', 'versionCode', 'splitName', 'splitHash', 'inclusionProofVerified'],
      rows.flatMap((p) =>
        p.splits.map((s) => [
          p.name,
          INSTALL_STATE_LABEL[p.installState],
          p.raw.versionCode,
          s.name ?? 'base',
          s.hash ?? '',
          s.inclusion_proof_verified === undefined ? '' : String(s.inclusion_proof_verified),
        ]),
      ),
    );
    downloadBlob(`${obs.title.replace(/\W+/g, '_')}_integrity.csv`, csv, 'text/csv');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Binary integrity"
        subtitle={`APK measurements and Android Binary Transparency coverage · ${rows.length} of ${obs.packages.length} packages shown`}
        actions={
          <button className="btn" onClick={exportCsv}>
            <Download size={12} /> Export CSV
          </button>
        }
      />

      <div className="space-y-3 border-b border-line px-6 py-3">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat
            label="Not in log"
            value={counts.failed}
            tone={counts.failed ? 'bad' : 'default'}
            hint="no split was found in the log"
            to="/integrity?proof=failed"
          />
          <Stat
            label="Partially in log"
            value={counts.partial}
            tone={obs.partialWithSplitNotInLog ? 'bad' : counts.partial ? 'warn' : 'default'}
            hint={
              counts.partial
                ? `${obs.partialWithSplitNotInLog} with a split not in log · ${
                    counts.partial - obs.partialWithSplitNotInLog
                  } incomplete`
                : 'some splits in log, not all'
            }
            to="/integrity?proof=partial"
          />
          <Stat
            label="Included in log"
            value={counts.verified}
            tone={counts.verified ? 'good' : 'default'}
            hint="every split was found"
            to="/integrity?proof=verified"
          />
          <Stat
            label="Not checked"
            value={counts.unchecked}
            hint="no proof result loaded"
            to="/integrity?proof=unchecked"
          />
        </div>

        {!obs.hasInclusionProofData && (
          <div className="flex items-start gap-2 rounded-md border border-line bg-bg-raised px-3 py-2 text-xs text-ink-muted">
            <Info size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p className="leading-relaxed">
                No inclusion-proof results were loaded. Produce them with{' '}
                <code className="mono">
                  automate_observation.py --perform_inclusion_proof_check --verifier_path=…
                </code>{' '}
                and add{' '}
                <code className="mono">packages_with_inclusion_proof_signal.txt</code> to the folder
                you load. Absence from the log is only meaningful for binaries that are expected to
                be published to it.
              </p>
              <LoadInclusionProofButton />
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[280px] max-w-xl flex-1">
            <SearchInput
              value={q}
              onChange={(v) => setParam('q', v || null)}
              placeholder="Filter by package or paste an APK SHA-256…"
            />
          </div>
          <select
            className="input w-auto"
            value={proofFilter}
            onChange={(e) => setParam('proof', e.target.value === 'all' ? null : e.target.value)}
          >
            {STATE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <Toggle
            checked={onlyPreinstalled}
            onChange={(v) => setParam('pre', v ? '1' : null)}
            label="Only pre-installed"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 px-6 py-3">
        <Card className="flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            tableId="integrity"
            rows={rows}
            columns={columns}
            rowKey={(p) => p.name}
            initialSort={{ columnId: 'proof', direction: 'asc' }}
            onRowClick={(p) => navigate(`/packages/${encodeURIComponent(p.name)}?tab=transparency`)}
            maxHeight="calc(100vh - 430px)"
          />
        </Card>
      </div>
    </div>
  );
}
