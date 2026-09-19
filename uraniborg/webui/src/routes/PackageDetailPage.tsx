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

/** Package detail: everything Hubble recorded about one package, tabbed. */

import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  ExternalLink,
  Info,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';
import { useActiveObservation, useApp } from '@/lib/store';
import { INSTALL_STATE_LABEL, type ExportedComponentRef, type PackageView } from '@/lib/model';
import {
  PROVIDER_GUARD_LEGEND,
  PROVIDER_OP_LABEL,
  PROVIDER_REACH_TONE,
  providerCaveats,
  providerGateSummary,
} from '@/lib/providers';
import { SEVERITY_ORDER, permissionSeverity } from '@/lib/sensitivity';
import { PageHeader } from '@/components/Layout';
import { ResizeHandle } from '@/components/ResizeHandle';
import { LoadInclusionProofButton } from '@/components/LoadInclusionProofButton';
import {
  Badge,
  BrokenRobot,
  Card,
  CertChip,
  CopyButton,
  EmptyState,
  KeyValue,
  ProofBadge,
  SearchInput,
  SensitivitySourceNote,
  SeverityBadge,
  SigningModeBadge,
  SigningNote,
  Tabs,
} from '@/components/ui';
import { currentSigner, SIGNING_MODE_LABEL } from '@/lib/signing';
import {
  downloadBlob,
  formatBytes,
  formatTimestamp,
  shortClassName,
  shortPermission,
} from '@/lib/format';

/**
 * The tab ids, as a value so the `?tab=` parameter can be validated against
 * them rather than cast. A URL is user input like any other: it gets shared,
 * bookmarked and hand-edited, and it outlives the tab names it references.
 */
const TAB_IDS = ['overview', 'permissions', 'components', 'integrity', 'transparency', 'raw'] as const;

type TabId = (typeof TAB_IDS)[number];

function isTabId(value: string | null): value is TabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

/**
 * Width-persistence key for the split list on the Integrity tab. It is not a
 * DataTable, but it shares the store's per-column width map so the one column
 * an analyst actually drags is remembered the same way a table's would be.
 */
const SPLIT_TABLE_ID = 'package-splits';
const SPLIT_NAME_COLUMN_ID = 'name';
/** Fits `config.arm64_v8a`, which is the common case; anything longer is a drag away. */
const SPLIT_NAME_DEFAULT_PX = 128;

export function PackageDetailPage() {
  const obs = useActiveObservation();
  const { name = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab');
  // An unrecognised tab is reported, not silently corrected: quietly showing
  // the overview would make a bad link look like a working one.
  const unknownTab = requestedTab !== null && !isTabId(requestedTab);
  const tab: TabId = isTabId(requestedTab) ? requestedTab : 'overview';
  const setTab = (t: TabId) => {
    const next = new URLSearchParams(params);
    next.set('tab', t);
    setParams(next, { replace: true });
  };

  const pkg = obs?.packagesByName.get(decodeURIComponent(name)) ?? null;

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }
  if (!pkg) {
    return (
      <EmptyState
        title={`Package "${decodeURIComponent(name)}" is not in this observation.`}
        hint={<Link className="link" to="/packages">Back to packages →</Link>}
      />
    );
  }

  const raw = pkg.raw;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={pkg.label}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="mono">{pkg.name}</span>
            <Badge>{INSTALL_STATE_LABEL[pkg.installState]}</Badge>
            {pkg.isPlatformSigned && (
              <Badge
                tone="warn"
                title="One of this package's current signers is part of the android framework package's signing identity, so it can hold signature-protected platform permissions."
              >
                platform-signed
              </Badge>
            )}
            <SigningModeBadge facts={pkg.signing} />
            {pkg.hasSystemSharedUid && <Badge tone="bad">privileged shared UID</Badge>}
            {!raw.isEnabled && <Badge>disabled</Badge>}
            {raw.isApex && <Badge tone="accent">APEX</Badge>}
            {/* Transparency status belongs in the header: it is a property of
                the binary itself, not a detail buried in a tab. */}
            {obs.hasInclusionProofData && <ProofBadge proof={pkg.inclusionProof} compact />}
          </span>
        }
        actions={
          <>
            <Link className="btn" to="/packages">
              <ArrowLeft size={12} /> Packages
            </Link>
            <CopyButton value={pkg.name} label="Copy name" />
          </>
        }
      />

      <Tabs<TabId>
        // Nothing is selected while the requested tab is unrecognised: showing
        // Overview as active would contradict the body, which says otherwise.
        value={unknownTab ? ('' as TabId) : tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'permissions', label: 'Permissions', count: pkg.grantedCount + pkg.notGrantedCount },
          { id: 'components', label: 'Components', count: pkg.componentCount },
          { id: 'integrity', label: 'Integrity', count: pkg.splits.length },
          { id: 'transparency', label: 'Transparency log' },
          { id: 'raw', label: 'Raw JSON' },
        ]}
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {unknownTab ? (
          <BrokenRobot
            title={`No tab called “${requestedTab}”.`}
            hint={
              <>
                This package has {TAB_IDS.length} tabs:{' '}
                {TAB_IDS.map((id, i) => (
                  <span key={id}>
                    {i > 0 && ', '}
                    <button type="button" className="link" onClick={() => setTab(id)}>
                      {id}
                    </button>
                  </span>
                ))}
                . The link that brought you here may predate a rename.
              </>
            }
          />
        ) : (
          <>
            {tab === 'overview' && <OverviewTab pkg={pkg} platformHash={obs.platformCertHash} />}
            {tab === 'permissions' && <PermissionsTab pkg={pkg} />}
            {tab === 'components' && <ComponentsTab components={pkg.exportedComponents} />}
            {tab === 'integrity' && (
              <IntegrityTab
                pkg={pkg}
                hasProofData={obs.hasInclusionProofData}
                onInvestigate={() => setTab('transparency')}
              />
            )}
            {tab === 'transparency' && (
              <TransparencyTab
                pkg={pkg}
                hasProofData={obs.hasInclusionProofData}
                artifactName={obs.inclusionProofFileName}
              />
            )}
            {tab === 'raw' && <RawTab name={pkg.name} data={raw} />}
          </>
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  pkg,
  platformHash,
}: {
  pkg: PackageView;
  platformHash: string | null;
}) {
  const raw = pkg.raw;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Identity">
        <KeyValue
          rows={[
            ['Package name', <span className="mono">{raw.name}</span>],
            ['Label', raw.label ?? '—'],
            ['Description', raw.description ?? '—'],
            ['Version', `${raw.versionName ?? '—'} (code ${raw.versionCode})`],
            ['Provenance', INSTALL_STATE_LABEL[pkg.installState]],
            ['Install location', <span className="mono break-all">{raw.installLocation ?? '—'}</span>],
            ['APK size', formatBytes(raw.fileSizeInBytes)],
            ['First install time', formatTimestamp(raw.firstInstallTime)],
          ]}
        />
      </Card>

      <Card title="Signing">
        <div className="space-y-3 px-4 py-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="label">{SIGNING_MODE_LABEL[pkg.signing.mode]}</span>
              <SigningModeBadge facts={pkg.signing} />
            </div>

            {/* Current signers first and on their own. This is the answer to
                "who can ship an update to this package", and burying it in a
                flat list next to retired keys is what made the old view
                unreadable. */}
            <div className="label mb-1.5 mt-2 text-ink-faint">
              {pkg.signing.mode === 'multiple-signers'
                ? `Current co-signers (${pkg.signing.activeSigners.length}, all required)`
                : pkg.signing.structured
                  ? 'Current signer'
                  : `Recorded certificates (${pkg.signing.activeSigners.length})`}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pkg.signing.activeSigners.length === 0 && (
                <span className="text-xs text-ink-faint">None recorded.</span>
              )}
              {pkg.signing.activeSigners.map((h) => (
                <CertChip key={h} hash={h} isPlatform={h === platformHash} />
              ))}
            </div>

            {pkg.signing.pastSigners.length > 0 && (
              <>
                {/* The whole lineage, not just the retired part: the position
                    of the current key in its own history is the thing being
                    shown, and dropping it would leave the ordinals dangling. */}
                <div className="label mb-1.5 mt-3 text-ink-faint">
                  Rotation lineage ({pkg.signing.lineage.length}, oldest first ·{' '}
                  {pkg.signing.pastSigners.length} retired)
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {pkg.signing.lineage.map((h, i) => (
                    <CertChip
                      key={h}
                      hash={h}
                      ordinal={i + 1}
                      role={h === currentSigner(pkg.signing) ? 'active' : 'retired'}
                      isPlatform={h === platformHash}
                      compact
                    />
                  ))}
                </div>
              </>
            )}

            <SigningNote facts={pkg.signing} className="mt-2" />

            {pkg.signing.platformSignatureMatch && (
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                <code className="mono">checkSignatures()</code> vs{' '}
                <code className="mono">android</code>:{' '}
                <strong>{pkg.signing.platformSignatureMatch}</strong>. Recorded verbatim for
                reference — this legacy API is not how platform signing is decided here, because it
                reports a match for a package that rotated <em>away</em> from the platform key.
              </p>
            )}

            <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
              Click a signer to decode the X.509 certificate and list every other package that
              records it.
            </p>
          </div>

          <div className="border-t border-line pt-3">
            <div className="label mb-1.5">Sandbox</div>
            {raw.sharedUserId ? (
              <div className="flex items-center gap-2">
                <Link className="mono link" to={`/packages?uid=${encodeURIComponent(raw.sharedUserId)}`}>
                  {raw.sharedUserId}
                </Link>
                {pkg.hasSystemSharedUid && <Badge tone="bad">privileged</Badge>}
              </div>
            ) : (
              <span className="text-xs text-ink-faint">Own UID (no sharedUserId).</span>
            )}
            <div className="mt-2 text-xs text-ink-muted">
              Kernel GIDs:{' '}
              <span className="mono">{raw.kernelGids.length ? raw.kernelGids.join(', ') : '—'}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Runtime flags">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-4 py-3 text-xs">
          {(
            [
              ['isEnabled', raw.isEnabled, false],
              ['hasCode', raw.hasCode, false],
              ['isHidden', raw.isHidden, true],
              ['isSuspended', raw.isSuspended, true],
              ['isTestOnly', raw.isTestOnly, true],
              ['isFactoryTest', raw.isFactoryTest, true],
              ['isApex', raw.isApex, false],
              ['isPreinstalled', raw.isPreinstalled, false],
              ['isUpdatedSystemApp', raw.isUpdatedSystemApp, false],
              ['usesCleartextTraffic', raw.usesCleartextTraffic, true],
            ] as Array<[string, boolean, boolean]>
          ).map(([label, value, badIfTrue]) => (
            <div key={label} className="flex items-center justify-between gap-2 border-b border-line/40 py-1">
              <span className="mono text-ink-muted">{label}</span>
              <Badge tone={value ? (badIfTrue ? 'warn' : 'good') : 'neutral'}>{String(value)}</Badge>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Attack surface at a glance">
        <div className="grid grid-cols-2 gap-3 px-4 py-4 text-sm">
          <Fact label="Granted permissions" value={pkg.grantedCount} />
          <Fact label="Requested, not granted" value={pkg.notGrantedCount} />
          <Fact label="Custom permissions declared" value={pkg.declaredCount} />
          <Fact
            label="Sensitive pregranted"
            value={pkg.sensitiveGrantedCount}
            tone={pkg.sensitiveGrantedCount > 0 ? 'warn' : 'default'}
          />
          <Fact label="Components" value={pkg.componentCount} />
          <Fact label="Exported" value={pkg.exportedCount} />
          <Fact
            label="Exported & unguarded"
            value={pkg.unguardedExportedCount}
            tone={pkg.unguardedExportedCount > 0 ? 'bad' : 'good'}
          />
          <Fact label="Splits" value={pkg.splits.length} />
        </div>
      </Card>
    </div>
  );
}

function Fact({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string | number;
  tone?: 'default' | 'warn' | 'bad' | 'good';
}) {
  const cls = {
    default: 'text-ink',
    warn: 'text-sev-high',
    bad: 'text-sev-critical',
    good: 'text-sev-ok',
  }[tone];
  return (
    <div className="rounded-md border border-line bg-bg px-3 py-2">
      <div className="label">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${cls}`}>{value}</div>
    </div>
  );
}

function PermissionsTab({
  pkg,
}: {
  pkg: PackageView;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const match = (p: string) => !needle || p.toLowerCase().includes(needle);

  // Granted permissions are ordered by sensitivity so the dangerous ones lead.
  const granted = useMemo(() => {
    const ranked = pkg.raw.permissionsGranted.filter(match).map((p) => ({
      name: p,
      severity: permissionSeverity(p),
    }));
    return ranked.sort((a, b) => {
      const ai = a.severity ? SEVERITY_ORDER.indexOf(a.severity) : 99;
      const bi = b.severity ? SEVERITY_ORDER.indexOf(b.severity) : 99;
      return ai - bi || a.name.localeCompare(b.name);
    });
  }, [pkg, needle]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="max-w-md flex-1">
          <SearchInput value={q} onChange={setQ} placeholder="Filter permissions…" />
        </div>
        <SensitivitySourceNote className="max-w-lg" />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          title={`Granted (${granted.length})`}
          actions={
            <span className="text-[11px] text-ink-faint">
              {pkg.sensitiveGrantedCount} sensitive
            </span>
          }
        >
          <ul className="max-h-[60vh] divide-y divide-line/50 overflow-y-auto">
            {granted.map((p) => (
              <li key={p.name} className="flex items-center gap-2 px-3 py-1.5">
                {p.severity ? (
                  <SeverityBadge severity={p.severity} />
                ) : (
                  <span className="w-[86px] shrink-0" />
                )}
                <Link
                  to={`/permissions?q=${encodeURIComponent(p.name)}`}
                  className="min-w-0 flex-1 truncate mono hover:text-accent"
                  title={p.name}
                >
                  {shortPermission(p.name)}
                </Link>
              </li>
            ))}
            {granted.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-ink-faint">None.</li>
            )}
          </ul>
        </Card>

        <Card title={`Requested, not granted (${pkg.raw.permissionsNotGranted.filter(match).length})`}>
          <ul className="max-h-[60vh] divide-y divide-line/50 overflow-y-auto">
            {pkg.raw.permissionsNotGranted.filter(match).map((p) => (
              <li key={p} className="px-3 py-1.5">
                <Link
                  to={`/permissions?q=${encodeURIComponent(p)}`}
                  className="block truncate mono text-ink-muted hover:text-accent"
                  title={p}
                >
                  {shortPermission(p)}
                </Link>
              </li>
            ))}
            {pkg.raw.permissionsNotGranted.filter(match).length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-ink-faint">None.</li>
            )}
          </ul>
        </Card>

        <Card title={`Declared by this package (${pkg.raw.permissionsDeclared.filter((d) => match(d.name)).length})`}>
          <ul className="max-h-[60vh] divide-y divide-line/50 overflow-y-auto">
            {pkg.raw.permissionsDeclared
              .filter((d) => match(d.name))
              .map((d) => (
                <li key={d.name} className="px-3 py-1.5">
                  <div className="truncate mono" title={d.name}>
                    {shortPermission(d.name)}
                  </div>
                  <div className="mt-0.5">
                    <Badge
                      tone={
                        /signature|privileged/i.test(d.protLevel)
                          ? 'warn'
                          : /dangerous/i.test(d.protLevel)
                            ? 'bad'
                            : 'neutral'
                      }
                    >
                      {d.protLevel || 'normal'}
                    </Badge>
                  </div>
                </li>
              ))}
            {pkg.raw.permissionsDeclared.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-ink-faint">
                No custom permissions declared.
              </li>
            )}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function ComponentsTab({ components }: { components: ExportedComponentRef[] }) {
  const [q, setQ] = useState('');
  const [onlyExported, setOnlyExported] = useState(false);
  const needle = q.trim().toLowerCase();

  const groups = useMemo(() => {
    const filtered = components.filter(
      (c) =>
        (!needle || c.name.toLowerCase().includes(needle) || (c.authority ?? '').toLowerCase().includes(needle)) &&
        (!onlyExported || c.isExported),
    );
    return {
      activity: filtered.filter((c) => c.componentType === 'activity'),
      service: filtered.filter((c) => c.componentType === 'service'),
      receiver: filtered.filter((c) => c.componentType === 'receiver'),
      provider: filtered.filter((c) => c.componentType === 'provider'),
    };
  }, [components, needle, onlyExported]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[280px] max-w-md flex-1">
          <SearchInput value={q} onChange={setQ} placeholder="Filter components…" />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={onlyExported}
            onChange={(e) => setOnlyExported(e.target.checked)}
            className="h-3.5 w-3.5 accent-accent"
          />
          Only exported
        </label>
        <Link className="link text-xs" to="/components?unguarded=1">
          Device-wide unguarded components →
        </Link>
      </div>

      {(['activity', 'service', 'receiver', 'provider'] as const).map((type) => (
        <Card key={type} title={`${type}s (${groups[type].length})`}>
          {type === 'provider' && groups[type].length > 0 && (
            <p className="border-b border-line/60 px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
              {PROVIDER_GUARD_LEGEND}
            </p>
          )}
          <ul className="divide-y divide-line/50">
            {groups[type].map((c) => {
              const unguarded =
                c.isExported &&
                c.isEnabled &&
                (c.componentType === 'provider'
                  ? !c.permissionRead || !c.permissionWrite
                  : !c.permission);
              return (
                <li key={c.name} className="flex flex-wrap items-center gap-2 px-4 py-1.5">
                  {c.isExported ? (
                    unguarded ? (
                      <ShieldAlert size={13} className="shrink-0 text-sev-critical" />
                    ) : (
                      <ShieldCheck size={13} className="shrink-0 text-sev-ok" />
                    )
                  ) : (
                    <ShieldQuestion size={13} className="shrink-0 text-ink-faint" />
                  )}
                  <span className="min-w-0 flex-1 truncate mono" title={c.name}>
                    {shortClassName(c.name)}
                  </span>
                  {!c.isEnabled && <Badge>disabled</Badge>}
                  {c.isExported && <Badge tone={unguarded ? 'bad' : 'accent'}>exported</Badge>}
                  {c.authority && (
                    <span className="mono text-[11px] text-ink-faint" title="Provider authority">
                      {c.authority}
                    </span>
                  )}
                  {c.componentType === 'provider' ? (
                    <ProviderGuards c={c} />
                  ) : (
                    <span className="mono text-[11px] text-ink-muted">
                      {c.permission ? shortPermission(c.permission) : 'no guard'}
                    </span>
                  )}
                </li>
              );
            })}
            {groups[type].length === 0 && (
              <li className="px-4 py-4 text-center text-xs text-ink-faint">None.</li>
            )}
          </ul>
        </Card>
      ))}
    </div>
  );
}

/**
 * The read and write gates of one provider.
 *
 * Rendered as two labelled values rather than the raw `R:`/`W:` pair, because
 * the abbreviation gave no hint that these are separate permissions, and a
 * bare "none" read as missing data rather than as an open door. See
 * lib/providers.ts for why an absent permission really does mean unguarded.
 */
function ProviderGuards({ c }: { c: ExportedComponentRef }) {
  const caveats = providerCaveats(c);
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      {providerGateSummary(c).map((g) => (
        <span key={g.op} className="flex items-center gap-1" title={g.title}>
          <span className="text-ink-faint">{PROVIDER_OP_LABEL[g.op]}</span>
          {g.reach === 'guarded' ? (
            <span className="mono text-ink-muted">{g.label}</span>
          ) : (
            <Badge tone={PROVIDER_REACH_TONE[g.reach]}>{g.label}</Badge>
          )}
        </span>
      ))}
      {caveats.length > 0 && (
        <span
          className="flex shrink-0 items-center text-ink-faint"
          title={caveats.join('\n\n')}
          aria-label={caveats.join(' ')}
        >
          <Info size={12} />
        </span>
      )}
    </span>
  );
}

function IntegrityTab({
  pkg,
  hasProofData,
  onInvestigate,
}: {
  pkg: PackageView;
  hasProofData: boolean;
  /** Jumps to the Transparency log tab, where the raw evidence lives. */
  onInvestigate: () => void;
}) {
  const proof = pkg.inclusionProof;

  // Split names have no useful upper bound - `config.arm64_v8a`, `config.en`,
  // and vendor-specific ones that run far longer - so any fixed width truncates
  // somebody's. The boundary is a drag handle, the same one the tables use, and
  // the width is remembered across visits like theirs.
  const storedNameWidth = useApp(
    (st) => st.prefs.columnWidths[SPLIT_TABLE_ID]?.[SPLIT_NAME_COLUMN_ID],
  );
  const setColumnWidth = useApp((st) => st.setColumnWidth);
  const [nameDragPx, setNameDragPx] = useState<number | null>(null);
  const nameHeaderRef = useRef<HTMLDivElement>(null);
  const nameWidth = nameDragPx ?? storedNameWidth ?? SPLIT_NAME_DEFAULT_PX;
  // `auto` on the trailing track keeps the copy button and badges hard against
  // the right edge, so widening the name column eats into the digest instead -
  // the column that can afford to lose characters, being monospaced, copyable
  // and shown in full in its tooltip.
  const splitGrid = `${nameWidth}px minmax(0, 1fr) auto`;

  return (
    <div className={clsx('space-y-4', nameDragPx !== null && 'select-none')}>
      <Card
        title="APK / split digests"
        actions={hasProofData ? <ProofBadge proof={proof} /> : null}
      >
        {pkg.splits.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-ink-faint">No digests recorded.</p>
        ) : (
          <>
            <div
              className="grid items-center border-b border-line/60 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
              style={{ gridTemplateColumns: splitGrid }}
            >
              <div ref={nameHeaderRef} className="relative flex min-w-0 pr-3">
                <span className="truncate">Split</span>
                <ResizeHandle
                  label="Split"
                  active={nameDragPx !== null}
                  measure={() => nameHeaderRef.current?.getBoundingClientRect().width ?? nameWidth}
                  onDrag={setNameDragPx}
                  onCommit={(px) => {
                    setColumnWidth(SPLIT_TABLE_ID, SPLIT_NAME_COLUMN_ID, px);
                    setNameDragPx(null);
                  }}
                />
              </div>
              <span className="truncate pl-3 pr-3">SHA-256</span>
              <span />
            </div>
            <ul className="divide-y divide-line/50">
              {pkg.splits.map((s, i) => (
                <li
                  key={`${s.hash}-${i}`}
                  className="grid items-center px-4 py-2"
                  style={{ gridTemplateColumns: splitGrid }}
                >
                  <span className="truncate pr-3 text-xs text-ink-muted" title={s.name ?? 'base'}>
                    {s.name ?? 'base'}
                  </span>
                  <span className="min-w-0 truncate pl-3 pr-3 mono text-[11px]" title={s.hash ?? ''}>
                    {s.hash ?? '—'}
                  </span>
                  <span className="flex items-center gap-2">
                    {s.hash && <CopyButton value={s.hash} />}
                    {s.inclusion_proof_verified === true && <Badge tone="good">in log</Badge>}
                    {s.inclusion_proof_verified === false && <Badge tone="bad">not in log</Badge>}
                    {hasProofData && s.inclusion_proof_verified === undefined && (
                      <Badge title="The loaded proof run returned no result for this digest">
                        no result
                      </Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card
        title="Android Binary Transparency"
        actions={
          <button className="btn" onClick={onInvestigate}>
            <Search size={12} /> Investigate
          </button>
        }
      >
        <div className="space-y-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
          {!hasProofData ? (
            <>
              <p>
                No inclusion-proof data was loaded. Run{' '}
                <code className="mono">inclusion_proof_check.py</code> (or{' '}
                <code className="mono">automate_observation.py --perform_inclusion_proof_check</code>
                ) and load the resulting{' '}
                <code className="mono">packages_with_inclusion_proof_signal.txt</code> alongside the
                rest of the observation.
              </p>
              <LoadInclusionProofButton className="pt-1" />
            </>
          ) : proof.state === 'unchecked' ? (
            <p>This package was not covered by the loaded inclusion-proof run.</p>
          ) : proof.state === 'verified' ? (
            <p className="text-sev-ok">
              All {proof.total} split{proof.total === 1 ? '' : 's'} of this package were found in
              the Android Binary Transparency log.
            </p>
          ) : (
            <p className={proof.failed > 0 ? 'text-sev-critical' : 'text-sev-high'}>
              {proof.verified} of {proof.total} splits were found in the transparency log
              {proof.failed > 0 && (
                <>
                  {' '}
                  · {proof.failed} {proof.failed === 1 ? 'was' : 'were'} explicitly{' '}
                  <strong>not</strong> found
                </>
              )}
              {proof.unknown > 0 && (
                <>
                  {' '}
                  · {proof.unknown} had no result in this run
                </>
              )}
              . For a Google-signed first-party APK a missing split warrants investigation; for OEM
              or third-party packages it simply means the binary is not published to that log.
              Splits with no result usually mean the APK changed between the Hubble run and the
              proof run, so the digests no longer match.
            </p>
          )}
          <p className="text-ink-faint">
            Note: for an updated system app the recorded hash describes the APK in{' '}
            <code className="mono">/data/app</code>, not the factory binary. Perform a factory data
            reset before running Hubble if you need factory image measurements.
          </p>
          <p>
            <button className="link" onClick={onInvestigate}>
              Open the Transparency log tab
            </button>{' '}
            to see the exact payload that was looked up for each split, reconcile the proof run
            against <code className="mono">packages.txt</code>, and read the raw record.
          </p>
        </div>
      </Card>

      <Card title="Component counts">
        <KeyValue
          rows={[
            ['Activities', String(pkg.raw.activities.length)],
            ['Services', String(pkg.raw.services.length)],
            ['Receivers', String(pkg.raw.receivers.length)],
            ['Providers', String(pkg.raw.providers.length)],
          ]}
        />
      </Card>
    </div>
  );
}

/** Shape of one record in `packages_with_inclusion_proof_signal.txt`. */
interface ProofRecord {
  name?: string;
  versionCode?: number;
  hash?: string;
  splits?: Array<{
    name?: string;
    location?: string;
    hash?: string;
    inclusion_proof_verified?: boolean;
  }>;
}

/**
 * The leaf that `inclusion_proof_check.py` asks the log about. Reconstructed
 * verbatim from the script so an analyst can replay the lookup by hand — and so
 * it is obvious that the *version code* is part of the identity, not just the
 * digest. A version bump alone therefore changes the leaf.
 */
function logPayload(digest: string, packageName: string, versionCode: number): string {
  return `${digest}\nSHA256(APK)\n${packageName}\n${versionCode}\n`;
}

/**
 * Drill-down for one package's transparency result.
 *
 * The point of this tab is that the summary elsewhere is *our* reading of a
 * second, independent measurement. Here the analyst sees the evidence itself:
 * what was queried, what the run answered, where the proof run and
 * `packages.txt` disagree, and the untouched JSON.
 */
function TransparencyTab({
  pkg,
  hasProofData,
  artifactName,
}: {
  pkg: PackageView;
  hasProofData: boolean;
  artifactName: string | null;
}) {
  const proof = pkg.inclusionProof;
  const record = (pkg.inclusionProofRecord ?? null) as ProofRecord | null;
  const recordJson = record ? JSON.stringify(record, null, 2) : null;

  // The version code the proof run actually used. It comes from the proof
  // artifact when available because that is what went into the leaf.
  const queriedVersionCode = record?.versionCode ?? pkg.raw.versionCode;

  // Reconciliation. A digest that exists in one artifact but not the other is
  // the usual explanation for a "no result" split: the APK was replaced
  // between the Hubble run and the proof run.
  //
  // Proof splits are normalised once, applying the same record-level `hash`
  // fallback inclusion_proof_check.py uses for a split without its own digest,
  // so both directions of the comparison below see the same digests.
  const deviceHashes = new Set(pkg.splits.map((s) => s.hash).filter(Boolean) as string[]);
  const proofSplits = (record?.splits ?? []).map((s) => ({ ...s, hash: s.hash ?? record?.hash }));
  if (record && proofSplits.length === 0 && record.hash) {
    proofSplits.push({ name: 'base', hash: record.hash });
  }
  const proofHashes = new Set(proofSplits.map((s) => s.hash).filter(Boolean) as string[]);
  const proofOnly = proofSplits.filter((s) => s.hash && !deviceHashes.has(s.hash));
  const deviceOnly = pkg.splits.filter((s) => s.hash && !proofHashes.has(s.hash));

  // What the lookup card lists. When this package was covered by the run, it
  // is exactly what the run submitted - the proof artifact's own digests with
  // its own version code - not packages.txt's digests, which can differ (that
  // is the whole point of the reconciliation card) and would otherwise yield
  // payloads that were never queried. Uncovered packages fall back to what a
  // lookup *would* query, from packages.txt.
  const lookups: Array<{
    name?: string;
    location?: string;
    hash?: string;
    inclusion_proof_verified?: boolean;
  }> = record ? proofSplits : pkg.splits;
  const versionMismatch =
    record?.versionCode !== undefined && record.versionCode !== pkg.raw.versionCode;
  const baseHashMismatch =
    record?.hash !== undefined && pkg.raw.hash !== null && record.hash !== pkg.raw.hash;
  const hasDiscrepancy =
    proofOnly.length > 0 || deviceOnly.length > 0 || versionMismatch || baseHashMismatch;

  if (!hasProofData) {
    return (
      <Card title="Transparency log">
        <div className="space-y-3 px-4 py-4 text-xs leading-relaxed text-ink-muted">
          <p>
            No inclusion-proof artifact was loaded, so nothing was looked up. Every package in this
            observation reads <strong>not checked</strong> rather than passing silently.
          </p>
          <p>Produce one and load it alongside the rest of the observation:</p>
          <pre className="overflow-x-auto rounded-md border border-line bg-bg-raised px-3 py-2 mono text-[11px] text-ink">
{`python3 scripts/python/inclusion_proof_check.py \\
    --packages_file packages.txt \\
    --verifier_path <path to the log verifier>`}
          </pre>
          <p>
            It writes <code className="mono">packages_with_inclusion_proof_signal.txt</code> next to
            the input. <code className="mono">automate_observation.py
            --perform_inclusion_proof_check</code> does the same as part of a full run.
          </p>
          <LoadInclusionProofButton className="border-t border-line/60 pt-3" />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card title="Verdict" actions={<ProofBadge proof={proof} />}>
        <KeyValue
          rows={[
            ['Splits found in log', `${proof.verified} of ${proof.total}`],
            ['Splits not found', String(proof.failed)],
            ['Splits with no result', String(proof.unknown)],
            [record ? 'Version code queried' : 'Version code', String(queriedVersionCode)],
            ['Source artifact', artifactName ?? '—'],
            ['Covered by this run', record ? 'yes' : 'no'],
          ]}
        />
      </Card>

      <Card title={record ? 'What was looked up, per split' : 'What a lookup would query'}>
        <div className="px-4 py-3 text-xs leading-relaxed text-ink-muted">
          The log is keyed by a leaf built from the APK digest, the package name and the version
          code.{' '}
          {record
            ? `Listed as recorded in ${artifactName ?? 'the proof artifact'}, which is what the run submitted. Copy a payload to replay the lookup with the verifier directly.`
            : 'Nothing below was actually submitted — this package was not covered by the loaded run. Copy a payload to check it by hand.'}
        </div>
        <ul className="divide-y divide-line/50">
          {lookups.map((s, i) => {
            const payload = s.hash ? logPayload(s.hash, pkg.name, queriedVersionCode) : null;
            return (
              <li key={`${s.hash}-${i}`} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-ink">{s.name ?? 'base'}</span>
                  {s.inclusion_proof_verified === true && <Badge tone="good">in log</Badge>}
                  {s.inclusion_proof_verified === false && <Badge tone="bad">not in log</Badge>}
                  {s.inclusion_proof_verified === undefined && (
                    <Badge title="The loaded proof run returned no result for this digest">
                      no result
                    </Badge>
                  )}
                  {s.location && (
                    <span className="truncate mono text-[11px] text-ink-faint" title={s.location}>
                      {s.location}
                    </span>
                  )}
                </div>
                {payload ? (
                  <div className="flex items-start gap-2">
                    <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-bg-raised px-3 py-2 mono text-[11px] text-ink-muted">
                      {payload}
                    </pre>
                    <CopyButton value={payload} label="Copy payload" />
                  </div>
                ) : (
                  <p className="text-xs text-ink-faint">
                    No digest was recorded for this split, so it could not be looked up.
                  </p>
                )}
              </li>
            );
          })}
          {lookups.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-ink-faint">
              No digests recorded, so nothing could be looked up.
            </li>
          )}
        </ul>
      </Card>

      <Card title="Reconciliation with packages.txt">
        <div className="space-y-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
          {!record ? (
            <p>
              This package does not appear in{' '}
              <code className="mono">{artifactName ?? 'the proof artifact'}</code>. The checker
              skips records missing <code className="mono">name</code>,{' '}
              <code className="mono">versionCode</code> or any digest, so this is usually an
              incomplete Hubble record rather than a transparency finding.
            </p>
          ) : !hasDiscrepancy ? (
            <p className="text-sev-ok">
              The proof run and <code className="mono">packages.txt</code> describe the same
              package: same version code and the same set of split digests.
            </p>
          ) : (
            <>
              <p className="text-sev-high">
                The two artifacts disagree about what this package is. That normally means the APK
                changed between the Hubble run and the proof run, and it explains any split with no
                result.
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {versionMismatch && (
                  <li>
                    Version code: <span className="mono">{pkg.raw.versionCode}</span> on device vs{' '}
                    <span className="mono">{record.versionCode}</span> in the proof run.
                  </li>
                )}
                {baseHashMismatch && (
                  <li>
                    Base digest: <span className="mono break-all">{pkg.raw.hash}</span> on device vs{' '}
                    <span className="mono break-all">{record.hash}</span> in the proof run.
                  </li>
                )}
                {deviceOnly.map((s, i) => (
                  <li key={`d-${i}`}>
                    Split <span className="mono">{s.name ?? 'base'}</span> (
                    <span className="mono break-all">{s.hash}</span>) is in{' '}
                    <code className="mono">packages.txt</code> but was not looked up.
                  </li>
                ))}
                {proofOnly.map((s, i) => (
                  <li key={`p-${i}`}>
                    Split <span className="mono">{s.name ?? 'base'}</span> (
                    <span className="mono break-all">{s.hash}</span>) was looked up but is not in{' '}
                    <code className="mono">packages.txt</code>.
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Card>

      <Card
        title="Raw inclusion-proof record"
        actions={
          recordJson ? (
            <div className="flex gap-2">
              <CopyButton value={recordJson} label="Copy" />
              <button
                className="btn"
                onClick={() =>
                  downloadBlob(`${pkg.name}.inclusion_proof.json`, recordJson, 'application/json')
                }
              >
                <ExternalLink size={12} /> Download
              </button>
            </div>
          ) : null
        }
      >
        {recordJson ? (
          <pre className="max-h-[50vh] overflow-auto px-4 py-3 mono text-[11px] leading-relaxed text-ink-muted">
            {recordJson}
          </pre>
        ) : (
          <p className="px-4 py-6 text-center text-xs text-ink-faint">
            No record for this package in {artifactName ?? 'the proof artifact'}.
          </p>
        )}
      </Card>
    </div>
  );
}

function RawTab({ name, data }: { name: string; data: unknown }) {
  const json = JSON.stringify(data, null, 2);
  return (
    <Card
      title="Raw Hubble record"
      actions={
        <div className="flex gap-2">
          <CopyButton value={json} label="Copy" />
          <button
            className="btn"
            onClick={() => downloadBlob(`${name}.json`, json, 'application/json')}
          >
            <ExternalLink size={12} /> Download
          </button>
        </div>
      }
    >
      <pre className="max-h-[70vh] overflow-auto px-4 py-3 mono text-[11px] leading-relaxed text-ink-muted">
        {json}
      </pre>
    </Card>
  );
}
