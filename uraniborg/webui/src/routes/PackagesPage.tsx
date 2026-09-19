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
 * Package browser: the primary entry point.
 *
 * Filter state lives in the URL query string so any view can be deep-linked
 * (the overview tiles rely on this) and shared with a colleague alongside the
 * observation folder.
 */

import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, X } from 'lucide-react';
import { useActiveObservation } from '@/lib/store';
import { INSTALL_STATE_LABEL, type InstallState, type PackageView } from '@/lib/model';
import { PageHeader } from '@/components/Layout';
import { DataTable, type Column } from '@/components/DataTable';
import {
  Badge,
  CertChip,
  EmptyState,
  PROOF_FILTER_OPTIONS,
  ProofBadge,
  SearchInput,
  SeverityBadge,
  Toggle,
  parseProofFilter,
} from '@/components/ui';
import { downloadBlob, formatBytes, formatTimestamp, toCsv } from '@/lib/format';
import { SENSITIVITY_SOURCE, SEVERITY_ORDER, severityRank } from '@/lib/sensitivity';
import { SIGNING_MODE_LABEL } from '@/lib/signing';

type StateFilter = 'all' | 'preinstalled' | 'user' | InstallState;

const STATE_OPTIONS: Array<{ id: StateFilter; label: string }> = [
  { id: 'all', label: 'All packages' },
  { id: 'preinstalled', label: 'Pre-installed (any)' },
  { id: 'user', label: 'User-installed' },
  { id: 'factory-apk', label: INSTALL_STATE_LABEL['factory-apk'] },
  { id: 'factory-apex', label: INSTALL_STATE_LABEL['factory-apex'] },
  { id: 'updated-system-app', label: INSTALL_STATE_LABEL['updated-system-app'] },
  { id: 'updated-mainline', label: INSTALL_STATE_LABEL['updated-mainline'] },
];

const STATE_TONE: Record<InstallState, 'neutral' | 'accent' | 'warn' | 'good'> = {
  'factory-apk': 'accent',
  'factory-apex': 'accent',
  'updated-system-app': 'warn',
  'updated-mainline': 'warn',
  'user-installed': 'good',
  unknown: 'neutral',
};

const SHORT_STATE: Record<InstallState, string> = {
  'factory-apk': 'factory',
  'factory-apex': 'factory apex',
  'updated-system-app': 'updated sys',
  'updated-mainline': 'updated apex',
  'user-installed': 'user',
  unknown: 'unknown',
};

export function PackagesPage() {
  const obs = useActiveObservation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  // Validated rather than cast: an unknown `?state=` would filter out every
  // package while the select still read "All packages", with no chip to clear.
  const requestedState = params.get('state');
  const state: StateFilter = STATE_OPTIONS.find((o) => o.id === requestedState)?.id ?? 'all';
  const certFilter = params.get('cert') ?? '';
  const sharedUid = params.get('uid') ?? '';
  const permFilter = params.get('perm') ?? '';
  const onlyPlatform = params.get('platform') === '1';
  const onlyCleartext = params.get('cleartext') === '1';
  const onlyDisabled = params.get('disabled') === '1';
  const onlyUnguarded = params.get('unguarded') === '1';
  const onlyNoCode = params.get('nocode') === '1';
  // Transparency state, with the same meanings and `?proof=` values as the
  // Integrity view. It used to be one "not in log" toggle that also swept in
  // partially published packages - including ones where nothing was actually
  // found missing - so the two are now separate choices. Only meaningful when
  // an inclusion-proof run was loaded, so the control is hidden otherwise.
  const proofFilter = parseProofFilter(params.get('proof'));

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo(() => {
    if (!obs) return [];
    const needle = q.trim().toLowerCase();
    return obs.packages.filter((p) => {
      if (needle && !p.searchBlob.includes(needle)) return false;
      if (state === 'preinstalled' && !p.raw.isPreinstalled) return false;
      if (state === 'user' && p.raw.isPreinstalled) return false;
      if (state !== 'all' && state !== 'preinstalled' && state !== 'user' && p.installState !== state)
        return false;
      // Matches the full history, not just current signers: arriving here from
      // a certificate page should show every package that records the key,
      // including the ones that have since rotated away from it.
      if (certFilter && !p.signing.allSigners.includes(certFilter)) return false;
      if (sharedUid && p.raw.sharedUserId !== sharedUid) return false;
      if (permFilter && !p.raw.permissionsGranted.includes(permFilter)) return false;
      if (onlyPlatform && !p.isPlatformSigned) return false;
      if (onlyCleartext && !p.raw.usesCleartextTraffic) return false;
      if (onlyDisabled && p.raw.isEnabled) return false;
      if (onlyUnguarded && p.unguardedExportedCount === 0) return false;
      if (onlyNoCode && p.raw.hasCode) return false;
      if (proofFilter !== 'all' && p.inclusionProof.state !== proofFilter) return false;
      return true;
    });
  }, [
    obs,
    q,
    state,
    certFilter,
    sharedUid,
    permFilter,
    onlyPlatform,
    onlyCleartext,
    onlyDisabled,
    onlyUnguarded,
    onlyNoCode,
    proofFilter,
  ]);

  const columns = useMemo<Array<Column<PackageView>>>(
    () => [
      {
        id: 'label',
        header: 'Package',
        width: 'minmax(260px, 2fr)',
        sortValue: (p) => p.name,
        render: (p) => (
          <div className="min-w-0">
            <div className="truncate text-[13px] text-ink">{p.label}</div>
            <div className="truncate mono text-[11px] text-ink-faint">{p.name}</div>
          </div>
        ),
      },
      {
        id: 'version',
        header: 'Version',
        width: 'minmax(110px, 0.7fr)',
        sortValue: (p) => p.raw.versionCode,
        render: (p) => (
          <div className="min-w-0">
            <div className="truncate text-xs">{p.raw.versionName ?? '—'}</div>
            <div className="mono text-[11px] text-ink-faint">{p.raw.versionCode}</div>
          </div>
        ),
      },
      {
        id: 'state',
        header: 'Provenance',
        width: 'minmax(130px, 0.8fr)',
        sortValue: (p) => p.installState,
        render: (p) => (
          <Badge tone={STATE_TONE[p.installState]} title={INSTALL_STATE_LABEL[p.installState]}>
            {SHORT_STATE[p.installState]}
          </Badge>
        ),
      },
      {
        id: 'signers',
        header: 'Signer',
        width: 'minmax(190px, 1.1fr)',
        // Sorting on the current signer groups packages by who actually
        // controls them today. Sorting on certIds[0] used to group them by
        // lineage root, which lumps together keys that have since diverged.
        sortValue: (p) => p.signing.activeSigners[0] ?? '',
        title:
          'The certificate that can ship an update to this package today. Click it to see every package the same key controls.',
        render: (p) => {
          const [first, ...rest] = p.signing.activeSigners;
          const retired = p.signing.pastSigners.length;
          return (
            <div className="flex items-center gap-1">
              {first ? (
                <CertChip hash={first} isPlatform={first === obs?.platformCertHash} compact />
              ) : (
                <span className="text-ink-faint">—</span>
              )}
              {rest.length > 0 && (
                <span
                  className="text-[11px] text-accent"
                  title={`Co-signed: ${rest.length + 1} concurrent signers, all required to ship an update.`}
                >
                  +{rest.length} co
                </span>
              )}
              {retired > 0 && (
                <span
                  className="text-[11px] text-ink-faint"
                  title={`${retired} retired ancestor${retired === 1 ? '' : 's'} in this package's rotation lineage. They cannot sign an update.`}
                >
                  +{retired} old
                </span>
              )}
              {p.signing.mode === 'unknown' && p.signing.allSigners.length > 1 && (
                <span
                  className="text-[11px] text-sev-high"
                  title="Signing configuration undetermined — open the package for why."
                >
                  ?
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: 'perms',
        header: 'Granted',
        width: '110px',
        align: 'right',
        sortValue: (p) => p.grantedCount,
        title: 'Permissions granted at observation time',
        render: (p) => <span className="text-xs">{p.grantedCount}</span>,
      },
      {
        id: 'sensitive',
        header: 'Sensitive',
        width: '150px',
        align: 'right',
        // Ordering only: most sensitive tier first, then by how many such
        // permissions the package holds. Not a score, never displayed.
        sortValue: (p) =>
          (p.topSeverity ? (SEVERITY_ORDER.length - severityRank(p.topSeverity)) * 1000 : 0) +
          p.sensitiveGrantedCount,
        title: `Granted permissions listed in ${SENSITIVITY_SOURCE}`,
        render: (p) =>
          p.topSeverity ? (
            <div className="flex items-center justify-end gap-1.5">
              <SeverityBadge severity={p.topSeverity} abbr />
              <span className="w-8 text-xs tabular-nums">{p.sensitiveGrantedCount}</span>
            </div>
          ) : (
            <span className="text-xs text-ink-faint">0</span>
          ),
      },
      {
        id: 'exported',
        header: 'Unguarded',
        width: '125px',
        align: 'right',
        sortValue: (p) => p.unguardedExportedCount,
        title: 'Exported + enabled components with no permission guard',
        render: (p) => (
          <span className={p.unguardedExportedCount > 0 ? 'text-xs text-sev-high' : 'text-xs text-ink-faint'}>
            {p.unguardedExportedCount}
          </span>
        ),
      },
      {
        id: 'size',
        header: 'Size',
        width: '90px',
        align: 'right',
        sortValue: (p) => p.raw.fileSizeInBytes,
        render: (p) => <span className="text-xs text-ink-muted">{formatBytes(p.raw.fileSizeInBytes)}</span>,
      },
      {
        id: 'flags',
        header: 'Flags',
        width: 'minmax(200px, 1.2fr)',
        // The virtualiser uses a fixed row height, so wrapping badges would
        // spill into the neighbouring row. Clip instead and keep the full set
        // reachable from the package page.
        render: (p) => (
          <div className="flex items-center gap-1 overflow-hidden whitespace-nowrap [&>*]:shrink-0">
            {/* Ordered by signal: what gets clipped first should be the least
                interesting. Only the anomalous transparency states earn a slot
                here — the happy path would otherwise dominate the column on a
                stock device. Per-split detail lives in the Integrity view. */}
            {(p.inclusionProof.state === 'failed' || p.inclusionProof.state === 'partial') && (
              <ProofBadge proof={p.inclusionProof} compact />
            )}
            {p.hasSystemSharedUid && (
              <Badge tone="bad" title={p.raw.sharedUserId ?? ''}>
                sys uid
              </Badge>
            )}
            {p.raw.usesCleartextTraffic && <Badge tone="warn">cleartext</Badge>}
            {p.raw.isTestOnly && <Badge tone="warn">test-only</Badge>}
            {p.raw.isSuspended && <Badge tone="warn">suspended</Badge>}
            {!p.raw.isEnabled && <Badge tone="neutral" title="Disabled at observation time">off</Badge>}
            {p.raw.isHidden && <Badge tone="neutral">hidden</Badge>}
            {!p.raw.hasCode && <Badge tone="neutral" title="Resource-only APK">no code</Badge>}
          </div>
        ),
      },
    ],
    [obs?.platformCertHash],
  );

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }

  const activeChips: Array<[string, string, string]> = [];
  if (certFilter) activeChips.push(['cert', 'signer', certFilter.slice(0, 12) + '…']);
  if (sharedUid) activeChips.push(['uid', 'shared UID', sharedUid]);
  if (permFilter) activeChips.push(['perm', 'granted', permFilter]);
  if (onlyPlatform) activeChips.push(['platform', 'platform-signed', 'yes']);
  if (onlyCleartext) activeChips.push(['cleartext', 'cleartext traffic', 'yes']);
  if (onlyUnguarded) activeChips.push(['unguarded', 'unguarded exports', 'yes']);
  if (onlyDisabled) activeChips.push(['disabled', 'disabled', 'yes']);
  if (onlyNoCode) activeChips.push(['nocode', 'no code', 'yes']);
  // Chipped as well as selectable: the select is hidden when no proof run is
  // loaded, and a `?proof=` link can still land here, so the chip is what keeps
  // the filter visible and clearable.
  if (proofFilter !== 'all') {
    activeChips.push([
      'proof',
      'ABT log',
      PROOF_FILTER_OPTIONS.find((o) => o.id === proofFilter)?.label.toLowerCase() ?? proofFilter,
    ]);
  }

  const exportCsv = () => {
    const csv = toCsv(
      [
        'name',
        'label',
        'versionName',
        'versionCode',
        'provenance',
        'installLocation',
        'sha256',
        // `certIds` verbatim, then the resolved reading of it. Both, because a
        // consumer diffing against the raw artifact needs the former and one
        // asking "who can sign this" needs the latter.
        'certIds',
        'signingMode',
        'activeSigners',
        'retiredSigners',
        'platformSignatureMatch',
        'sharedUserId',
        'grantedPermissions',
        'sensitiveGrantedPermissions',
        'topSensitivityTier',
        'unguardedExports',
        'usesCleartextTraffic',
        'isEnabled',
        'inclusionProof',
        'splitsInLog',
        'fileSizeInBytes',
        'firstInstallTime',
      ],
      rows.map((p) => [
        p.name,
        p.label,
        p.raw.versionName,
        p.raw.versionCode,
        INSTALL_STATE_LABEL[p.installState],
        p.raw.installLocation,
        p.raw.hash,
        p.raw.certIds.join(' '),
        SIGNING_MODE_LABEL[p.signing.mode],
        p.signing.activeSigners.join(' '),
        p.signing.pastSigners.join(' '),
        p.signing.platformSignatureMatch ?? '',
        p.raw.sharedUserId,
        p.grantedCount,
        p.sensitiveGrantedCount,
        p.topSeverity ?? '',
        p.unguardedExportedCount,
        p.raw.usesCleartextTraffic,
        p.raw.isEnabled,
        p.inclusionProof.state,
        `${p.inclusionProof.verified}/${p.inclusionProof.total}`,
        p.raw.fileSizeInBytes,
        formatTimestamp(p.raw.firstInstallTime),
      ]),
    );
    downloadBlob(`${obs.title.replace(/\W+/g, '_')}_packages.csv`, csv, 'text/csv');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Packages"
        subtitle={`${rows.length.toLocaleString()} of ${obs.packages.length.toLocaleString()} shown`}
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
              placeholder="Filter by package name, label, install path, shared UID…"
            />
          </div>
          <select
            className="input w-auto"
            value={state}
            onChange={(e) => setParam('state', e.target.value === 'all' ? null : e.target.value)}
          >
            {STATE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {obs.hasInclusionProofData && (
            <select
              className="input w-auto"
              aria-label="Android Binary Transparency log state"
              title="Not in log: no split was found. Partially in log: some splits were found, not all."
              value={proofFilter}
              onChange={(e) => setParam('proof', e.target.value === 'all' ? null : e.target.value)}
            >
              {PROOF_FILTER_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.id === 'all' ? 'Any ABT log state' : `ABT: ${o.label.toLowerCase()}`}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <Toggle
            checked={onlyPlatform}
            onChange={(v) => setParam('platform', v ? '1' : null)}
            label="Platform-signed"
          />
          <Toggle
            checked={onlyUnguarded}
            onChange={(v) => setParam('unguarded', v ? '1' : null)}
            label="Has unguarded exports"
          />
          <Toggle
            checked={onlyCleartext}
            onChange={(v) => setParam('cleartext', v ? '1' : null)}
            label="Cleartext traffic"
          />
          <Toggle
            checked={onlyDisabled}
            onChange={(v) => setParam('disabled', v ? '1' : null)}
            label="Disabled"
          />
          <Toggle
            checked={onlyNoCode}
            onChange={(v) => setParam('nocode', v ? '1' : null)}
            label="No code"
          />
        </div>

        {activeChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {activeChips.map(([key, label, value]) => (
              <button
                key={key}
                className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] text-accent"
                onClick={() => setParam(key, null)}
                title="Remove filter"
              >
                {label}: <span className="mono">{value}</span>
                <X size={11} />
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 px-6 py-3">
        <div className="card flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            tableId="packages"
            rows={rows}
            columns={columns}
            rowKey={(p) => p.name}
            initialSort={{ columnId: 'label', direction: 'asc' }}
            onRowClick={(p) => navigate(`/packages/${encodeURIComponent(p.name)}`)}
            maxHeight="calc(100vh - 320px)"
          />
        </div>
      </div>
    </div>
  );
}
