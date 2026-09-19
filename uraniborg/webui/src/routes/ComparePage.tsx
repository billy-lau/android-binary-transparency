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
 * Compare two observations.
 *
 * Also answers "what does this build add on top of stock Android?" once the
 * user designates an API-level-matched GSI/AOSP observation as the baseline.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Download, GitCompare, Info } from 'lucide-react';
import { useApp } from '@/lib/store';
import { computeBaselineDelta, diffObservations, type PackageDiff } from '@/lib/diff';
import { PageHeader } from '@/components/Layout';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Card, CertChip, EmptyState, SearchInput, Stat, Tabs } from '@/components/ui';
import { downloadBlob, shortPermission, toCsv } from '@/lib/format';
import { SENSITIVITY_SOURCE } from '@/lib/sensitivity';
import {
  SIGNER_CHANGE_LABEL,
  SIGNER_CHANGE_RANK,
  SIGNER_CHANGE_TITLE,
} from '@/lib/signing';

type TabId = 'changes' | 'delta';

export function ComparePage() {
  const observations = useApp((s) => s.observations);
  const activeId = useApp((s) => s.activeId);
  const baselineId = useApp((s) => s.baselineId);
  const setBaseline = useApp((s) => s.setBaseline);
  const setActive = useApp((s) => s.setActive);
  const navigate = useNavigate();

  const [tab, setTab] = useState<TabId>('changes');
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'added' | 'removed' | 'changed' | 'signer'>('all');

  const baseline = observations.find((o) => o.id === baselineId) ?? null;
  const target = observations.find((o) => o.id === activeId) ?? null;

  const diff = useMemo(
    () => (baseline && target && baseline.id !== target.id ? diffObservations(baseline, target) : null),
    [baseline, target],
  );
  const delta = useMemo(
    () =>
      baseline && target && baseline.id !== target.id
        ? computeBaselineDelta(baseline, target)
        : null,
    [baseline, target],
  );

  const rows = useMemo(() => {
    if (!diff) return [];
    const needle = q.trim().toLowerCase();
    let list: PackageDiff[] =
      kind === 'added'
        ? diff.added
        : kind === 'removed'
          ? diff.removed
          : kind === 'changed'
            ? diff.changed
            : kind === 'signer'
              ? diff.signerChanges
              : [...diff.added, ...diff.removed, ...diff.changed];
    if (needle) list = list.filter((d) => d.name.toLowerCase().includes(needle));
    return list;
  }, [diff, q, kind]);

  const columns = useMemo<Array<Column<PackageDiff>>>(
    () => [
      {
        id: 'kind',
        header: 'Change',
        width: '110px',
        sortValue: (d) => d.kind,
        render: (d) => (
          <Badge tone={d.kind === 'added' ? 'good' : d.kind === 'removed' ? 'bad' : 'warn'}>
            {d.kind}
          </Badge>
        ),
      },
      {
        id: 'name',
        header: 'Package',
        width: 'minmax(240px, 1.6fr)',
        sortValue: (d) => d.name,
        render: (d) => (
          <div className="min-w-0">
            <div className="truncate text-[13px]">{(d.after ?? d.before)?.label}</div>
            <div className="truncate mono text-[11px] text-ink-faint">{d.name}</div>
          </div>
        ),
      },
      {
        id: 'signer',
        header: 'Signer',
        width: 'minmax(160px, 1fr)',
        // Ranked so the case that warrants investigation sorts to the top: a
        // re-signing above an undetermined change above a benign rotation.
        sortValue: (d) => SIGNER_CHANGE_RANK[d.signerChangeKind],
        render: (d) =>
          d.signerChangeKind === 'none' ? (
            <span className="text-[11px] text-ink-faint">—</span>
          ) : (
            <Badge
              tone={d.signerChangeKind === 'rotation' ? 'neutral' : 'warn'}
              title={SIGNER_CHANGE_TITLE[d.signerChangeKind]}
            >
              {SIGNER_CHANGE_LABEL[d.signerChangeKind]}
            </Badge>
          ),
      },
      {
        id: 'fields',
        header: 'Changed fields',
        width: 'minmax(220px, 1.4fr)',
        sortValue: (d) => d.changes.length,
        render: (d) => (
          <span className="truncate mono text-[11px] text-ink-muted" title={d.changes.map((c) => `${c.field}: ${c.before} → ${c.after}`).join('\n')}>
            {d.changes.map((c) => c.field).join(', ') || '—'}
          </span>
        ),
      },
      {
        id: 'perms',
        header: 'Perm Δ',
        width: '120px',
        align: 'right',
        sortValue: (d) => d.permissionsGained.length - d.permissionsLost.length,
        render: (d) => (
          <span
            className="text-xs"
            title={[
              d.permissionsGained.length ? `+ ${d.permissionsGained.map(shortPermission).join(', ')}` : '',
              d.permissionsLost.length ? `- ${d.permissionsLost.map(shortPermission).join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('\n')}
          >
            {d.permissionsGained.length > 0 && (
              <span className="text-sev-high">+{d.permissionsGained.length}</span>
            )}
            {d.permissionsGained.length > 0 && d.permissionsLost.length > 0 && ' / '}
            {d.permissionsLost.length > 0 && (
              <span className="text-ink-faint">−{d.permissionsLost.length}</span>
            )}
            {d.permissionsGained.length === 0 && d.permissionsLost.length === 0 && (
              <span className="text-ink-faint">—</span>
            )}
          </span>
        ),
      },
    ],
    [],
  );

  if (observations.length < 2) {
    return (
      <EmptyState
        title="Comparison needs two observations."
        hint={
          <>
            Load a second Hubble result set — for example the same device before and after an OTA,
            or an API-level-matched GSI/AOSP build to use as a baseline.{' '}
            <Link className="link" to="/load">
              Load another →
            </Link>
          </>
        }
      />
    );
  }

  const exportCsv = () => {
    if (!diff) return;
    const csv = toCsv(
      ['package', 'change', 'signerChange', 'changedFields', 'permissionsGained', 'permissionsLost'],
      rows.map((d) => [
        d.name,
        d.kind,
        d.signerChangeKind,
        d.changes.map((c) => `${c.field}:${c.before}->${c.after}`).join('; '),
        d.permissionsGained.join(' '),
        d.permissionsLost.join(' '),
      ]),
    );
    downloadBlob('observation_diff.csv', csv, 'text/csv');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Compare observations"
        subtitle="Baseline → target. Everything is evaluated as a change relative to the baseline."
        actions={
          diff && (
            <button className="btn" onClick={exportCsv}>
              <Download size={12} /> Export CSV
            </button>
          )
        }
      />

      <div className="flex flex-wrap items-end gap-3 border-b border-line px-6 py-3">
        <label className="flex flex-col gap-1">
          <span className="label">Baseline (A₀)</span>
          <select
            className="input w-auto min-w-[220px]"
            value={baselineId ?? ''}
            onChange={(e) => setBaseline(e.target.value || null)}
          >
            <option value="">— select —</option>
            {observations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title} · API {o.summary.apiLevel ?? '?'}
              </option>
            ))}
          </select>
        </label>
        <ArrowRight size={16} className="mb-2 text-ink-faint" />
        <label className="flex flex-col gap-1">
          <span className="label">Target (Aₜ)</span>
          <select
            className="input w-auto min-w-[220px]"
            value={activeId ?? ''}
            onChange={(e) => setActive(e.target.value)}
          >
            {observations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title} · API {o.summary.apiLevel ?? '?'}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!diff ? (
        <EmptyState
          title="Pick two different observations."
          hint="The baseline and target must not be the same observation."
        />
      ) : (
        <>
          {baseline && target && baseline.summary.apiLevel !== target.summary.apiLevel && (
            <div className="flex items-start gap-2 border-b border-sev-high/30 bg-sev-high/10 px-6 py-2 text-xs text-sev-high">
              <Info size={13} className="mt-0.5 shrink-0" />
              <span>
                API levels differ ({baseline.summary.apiLevel ?? 'unknown'} vs{' '}
                {target.summary.apiLevel ?? 'unknown'}).
                Ordinary platform evolution between releases will show up below as target-specific
                change; prefer an API-level-matched baseline.
              </span>
            </div>
          )}

          <Tabs<TabId>
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'changes', label: 'Package changes', count: diff.added.length + diff.removed.length + diff.changed.length },
              { id: 'delta', label: 'Preload delta' },
            ]}
          />

          {tab === 'changes' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="grid grid-cols-2 gap-3 px-6 py-3 md:grid-cols-6">
                <Stat label="Added" value={diff.added.length} tone="good" />
                <Stat label="Removed" value={diff.removed.length} tone="bad" />
                <Stat label="Changed" value={diff.changed.length} tone="warn" />
                {/* Re-signings and rotations are counted apart. Rolling them
                    together made a build with routine key rotation look like a
                    build full of re-signed packages. */}
                <Stat
                  label="Re-signed"
                  value={diff.reSignings.length + diff.undeterminedSignerChanges.length}
                  tone={
                    diff.reSignings.length + diff.undeterminedSignerChanges.length
                      ? 'warn'
                      : 'default'
                  }
                  hint={
                    diff.undeterminedSignerChanges.length
                      ? `incl. ${diff.undeterminedSignerChanges.length} undetermined`
                      : 'active signers changed'
                  }
                />
                <Stat
                  label="Key rotated"
                  value={diff.keyRotations.length}
                  hint="lineage extended"
                />
                <Stat
                  label="New signers"
                  value={diff.newSigners.length}
                  hint="keys newly able to sign"
                />
              </div>

              {diff.newSigners.length > 0 && (
                <div className="px-6 pb-2">
                  <Card title="Signing keys that can ship code on the target but not the baseline">
                    <div className="flex flex-wrap gap-1.5 px-4 py-3">
                      {diff.newSigners.map((h) => (
                        <CertChip key={h} hash={h} isPlatform={h === target?.platformCertHash} />
                      ))}
                    </div>
                  </Card>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 px-6 pb-3">
                <div className="min-w-[260px] max-w-md flex-1">
                  <SearchInput value={q} onChange={setQ} placeholder="Filter by package name…" />
                </div>
                <select
                  className="input w-auto"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                  <option value="all">All changes</option>
                  <option value="added">Added only</option>
                  <option value="removed">Removed only</option>
                  <option value="changed">Modified only</option>
                  <option value="signer">Signer changes only</option>
                </select>
              </div>

              <div className="min-h-0 flex-1 px-6 pb-4">
                <Card className="flex h-full min-h-0 flex-col overflow-hidden">
                  <DataTable
                    tableId="compare-changes"
                    rows={rows}
                    columns={columns}
                    rowKey={(d) => d.name}
                    initialSort={{ columnId: 'kind', direction: 'asc' }}
                    onRowClick={(d) => navigate(`/packages/${encodeURIComponent(d.name)}`)}
                    // The detail page reads the active observation, i.e. the
                    // target. A removed package exists only in the baseline, so
                    // following it would always land on "not in this observation".
                    isRowClickable={(d) => d.kind !== 'removed'}
                    maxHeight="calc(100vh - 470px)"
                    emptyMessage="No differences match the current filter."
                  />
                </Card>
              </div>
            </div>
          ) : (
            delta && (
              <div className="space-y-4 overflow-y-auto p-6">
                <Card
                  title="Pre-installed surface added by the target"
                  actions={<GitCompare size={13} className="text-ink-faint" />}
                >
                  <div className="space-y-3 px-4 py-4">
                    <p className="max-w-2xl text-[11px] leading-relaxed text-ink-faint">
                      Each row counts pre-installed packages in the target that the baseline does
                      not ship under the same name. These are raw counts, not a risk score: they
                      tell you how much of each category is the target image&apos;s own doing and
                      give you the exact list to review.
                    </p>

                    {(
                      [
                        [
                          'Platform-signed preloads',
                          delta.platformSigned,
                          'One of their current signers belongs to the android package\u2019s signing identity, so they can hold signature-protected platform permissions.',
                        ],
                        [
                          'Preloads with sensitive pregranted permissions',
                          delta.sensitivePermissions,
                          `Hold at least one permission listed in ${SENSITIVITY_SOURCE}, without any user consent step.`,
                        ],
                        [
                          'Preloads allowing cleartext traffic',
                          delta.cleartextTraffic,
                          'usesCleartextTraffic is set, so their network traffic may be unprotected.',
                        ],
                      ] as Array<[string, typeof delta.platformSigned, string]>
                    ).map(([label, cat, detail]) => (
                      <div key={label} className="rounded-md border border-line bg-bg px-3 py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium">{label}</span>
                          <span className="mono text-xs text-ink-muted">
                            <span className="text-accent">{cat.novelCount}</span> new of{' '}
                            {cat.targetCount} in target
                          </span>
                        </div>
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-bg-raised">
                          <div
                            className="h-full bg-accent"
                            style={{
                              width: `${cat.targetCount ? (cat.novelCount / cat.targetCount) * 100 : 0}%`,
                            }}
                          />
                        </div>
                        <p className="mt-1.5 text-[11px] text-ink-faint">{detail}</p>
                        {cat.novelPackages.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {cat.novelPackages.slice(0, 24).map((name) => (
                              <Link
                                key={name}
                                to={`/packages/${encodeURIComponent(name)}`}
                                className="mono rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-muted hover:border-accent hover:text-accent"
                              >
                                {name}
                              </Link>
                            ))}
                            {cat.novelPackages.length > 24 && (
                              <span className="text-[11px] text-ink-faint">
                                +{cat.novelPackages.length - 24} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>

                <Card title="Reading this comparison">
                  <ul className="space-y-1.5 px-4 py-3 text-xs leading-relaxed text-ink-muted">
                    <li>
                      Only pre-installed packages are counted. User-installed apps are not part of
                      the shipped image.
                    </li>
                    <li>
                      For the comparison to mean anything the baseline should be a GSI (or AOSP)
                      build at the <strong>same API level</strong> as the target; otherwise ordinary
                      platform evolution shows up as target-specific additions.
                    </li>
                    <li>
                      Platform-signed additions deserve attention first: they sit inside the
                      platform&apos;s trust boundary, so a bug there is a platform bug.
                    </li>
                    <li>
                      {delta.novelPreloads.length} pre-installed package
                      {delta.novelPreloads.length === 1 ? ' in the target is' : 's in the target are'}{' '}
                      new: the baseline has no pre-installed package of the same name. The &ldquo;new&rdquo;
                      counts above use the same test. Matching is by package name only, so a package the
                      baseline has only as a user install still counts as new, while a same-named
                      package with a different signer or version does not.
                    </li>
                  </ul>
                </Card>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
