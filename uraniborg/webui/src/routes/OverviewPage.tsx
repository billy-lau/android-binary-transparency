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

/** Overview dashboard: device identity, composition, and triage entry points. */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { useActiveObservation } from '@/lib/store';
import { INSTALL_STATE_LABEL, type InstallState } from '@/lib/model';
import { SEVERITY_ORDER, severityRank, type PermissionSeverity } from '@/lib/sensitivity';
import { SIGNING_INFO_MIN_VERSION, SIGNING_MODE_LABEL, type SigningMode } from '@/lib/signing';
import { PageHeader } from '@/components/Layout';
import {
  Badge,
  Card,
  CertChip,
  EmptyState,
  Meter,
  SensitivitySourceNote,
  SeverityBadge,
  Stat,
} from '@/components/ui';
import { pluralize, shortPermission } from '@/lib/format';

const STATE_COLORS: Record<InstallState, string> = {
  'factory-apk': '#4da3ff',
  'factory-apex': '#2f7ac9',
  'updated-system-app': '#ffb020',
  'updated-mainline': '#c08a2a',
  'user-installed': '#3fb950',
  unknown: '#6b7f94',
};

const SIGNING_MODE_COLORS: Record<SigningMode, string> = {
  'single-signer': '#4da3ff',
  'key-rotation-lineage': '#3fb950',
  'multiple-signers': '#ffb020',
  unknown: '#6b7f94',
};

const SEVERITY_COLORS: Record<PermissionSeverity, string> = {
  ASTRONOMICAL: '#ff4d6d',
  CRITICAL: '#ff7849',
  HIGH: '#ffb020',
  MEDIUM: '#4da3ff',
  LOW: '#6b7f94',
};

export function OverviewPage() {
  const obs = useActiveObservation();

  const stats = useMemo(() => {
    if (!obs) return null;
    const byState = new Map<InstallState, number>();
    let platformSigned = 0;
    let cleartext = 0;
    let unguarded = 0;
    let disabled = 0;
    let testOnly = 0;
    const bySeverity = new Map<PermissionSeverity, number>();

    for (const p of obs.packages) {
      byState.set(p.installState, (byState.get(p.installState) ?? 0) + 1);
      if (p.isPlatformSigned) platformSigned++;
      if (p.raw.usesCleartextTraffic) cleartext++;
      if (p.unguardedExportedCount > 0) unguarded++;
      if (!p.raw.isEnabled) disabled++;
      if (p.raw.isTestOnly) testOnly++;
      if (p.topSeverity) bySeverity.set(p.topSeverity, (bySeverity.get(p.topSeverity) ?? 0) + 1);
    }

    // Ranked by most sensitive tier held, then by how many such permissions.
    const mostPrivileged = [...obs.packages]
      .filter((p) => p.sensitiveGrantedCount > 0)
      .sort(
        (a, b) =>
          severityRank(a.topSeverity) - severityRank(b.topSeverity) ||
          b.sensitiveGrantedCount - a.sensitiveGrantedCount,
      )
      .slice(0, 12);

    const topSigners = obs.certificates.slice(0, 8);

    const topSensitivePerms = obs.permissions
      .filter((p) => p.severity && p.grantedTo.length > 0)
      .sort(
        (a, b) =>
          severityRank(a.severity) - severityRank(b.severity) ||
          b.grantedTo.length - a.grantedTo.length,
      )
      .slice(0, 12);

    return {
      byState,
      platformSigned,
      cleartext,
      unguarded,
      disabled,
      testOnly,
      bySeverity,
      mostPrivileged,
      topSigners,
      topSensitivePerms,
    };
  }, [obs]);

  if (!obs || !stats) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }

  const preinstalled = obs.packages.filter((p) => p.raw.isPreinstalled).length;
  const proofCounts = obs.inclusionProofCounts;

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title={obs.title}
        subtitle={
          <span className="mono break-all">
            {obs.summary.fingerprint || 'no fingerprint recorded'}
          </span>
        }
        actions={
          <>
            <Badge tone="accent">API {obs.summary.apiLevel ?? '?'}</Badge>
            <Badge>patch {obs.summary.securityPatchLevel}</Badge>
            <Badge>Hubble {obs.hubbleVersion ?? '?'}</Badge>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Packages" value={obs.packages.length.toLocaleString()} to="/packages" />
        <Stat
          label="Pre-installed"
          value={preinstalled.toLocaleString()}
          hint={`${obs.packages.length - preinstalled} user-installed`}
          to="/packages?state=preinstalled"
        />
        <Stat
          label="Platform-signed"
          value={stats.platformSigned.toLocaleString()}
          hint="current signers vs platform lineage"
          tone={stats.platformSigned > 0 ? 'warn' : 'default'}
          to="/packages?platform=1"
        />
        <Stat label="Signing certs" value={obs.certificates.length.toLocaleString()} to="/certificates" />
        <Stat
          label="Unguarded exports"
          value={stats.unguarded.toLocaleString()}
          hint="packages w/ exported+unprotected components"
          tone={stats.unguarded > 0 ? 'warn' : 'good'}
          to="/packages?unguarded=1"
        />
        <Stat
          label="Cleartext traffic"
          value={stats.cleartext.toLocaleString()}
          tone={stats.cleartext > 0 ? 'warn' : 'good'}
          to="/packages?cleartext=1"
        />
        {/* Transparency coverage is shown even when no proof run was loaded, so
            the absence of the check is itself visible rather than silent.
            "Not in" and "partially in" are separate tiles: folding them together
            made a package whose only gap was a split without a result read as
            absent from the log. */}
        <Stat
          label="Not in ABT log"
          value={proofCounts.failed.toLocaleString()}
          hint={
            obs.hasInclusionProofData
              ? `no split found · ${proofCounts.verified} fully in log · ${proofCounts.unchecked} unchecked`
              : 'no inclusion-proof run loaded'
          }
          tone={!obs.hasInclusionProofData ? 'default' : proofCounts.failed > 0 ? 'bad' : 'good'}
          to={obs.hasInclusionProofData ? '/packages?proof=failed' : '/integrity'}
        />
        <Stat
          label="Partially in ABT log"
          value={proofCounts.partial.toLocaleString()}
          hint={
            !obs.hasInclusionProofData
              ? 'no inclusion-proof run loaded'
              : proofCounts.partial
                ? `${obs.partialWithSplitNotInLog} with a split not in log · ${
                    proofCounts.partial - obs.partialWithSplitNotInLog
                  } incomplete`
                : 'some splits in log, not all'
          }
          tone={
            !obs.hasInclusionProofData
              ? 'default'
              : obs.partialWithSplitNotInLog > 0
                ? 'bad'
                : proofCounts.partial > 0
                  ? 'warn'
                  : 'good'
          }
          to={obs.hasInclusionProofData ? '/packages?proof=partial' : '/integrity'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Package provenance">
          <div className="px-4 py-4">
            <Meter
              total={obs.packages.length}
              segments={(Object.keys(INSTALL_STATE_LABEL) as InstallState[])
                .map((s) => ({
                  label: INSTALL_STATE_LABEL[s],
                  value: stats.byState.get(s) ?? 0,
                  color: STATE_COLORS[s],
                }))
                .filter((s) => s.value > 0)}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Classified per <code className="mono">docs/hubble_results.md</code>. APEX entries are
              disambiguated on the <code className="mono">.decompressed.apex</code> suffix so that
              pristine factory Mainline modules are not mistaken for updates.
            </p>
          </div>
        </Card>

        <Card title="Most sensitive pregranted permission held, per package">
          <div className="px-4 py-4">
            <Meter
              total={obs.packages.length}
              segments={SEVERITY_ORDER.map((s) => ({
                label: s,
                value: stats.bySeverity.get(s) ?? 0,
                color: SEVERITY_COLORS[s],
              })).filter((s) => s.value > 0)}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Used here purely for triage. To see what this build adds on top of stock Android,
              use{' '}
              <Link className="link" to="/compare">
                Compare
              </Link>{' '}
              with a GSI/AOSP observation.
            </p>
            <SensitivitySourceNote className="mt-2" />
          </div>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Top signers"
          actions={
            <Link className="btn" to="/certificates">
              All signers <ArrowRight size={12} />
            </Link>
          }
        >
          {/* How the device's signing is configured, before which keys they are.
              A two-certificate package means opposite things under rotation and
              under co-signing, so the split is worth stating up front. */}
          <div className="border-b border-line/60 px-4 py-4">
            <Meter
              total={obs.packages.length}
              segments={(Object.keys(SIGNING_MODE_LABEL) as SigningMode[])
                .map((m) => ({
                  label: SIGNING_MODE_LABEL[m],
                  value: obs.signingModeCounts[m],
                  color: SIGNING_MODE_COLORS[m],
                }))
                .filter((s) => s.value > 0)}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              {obs.hasStructuredSigning ? (
                <>
                  Resolved from <code className="mono">signingInfo</code>. Under a rotation lineage
                  only the newest key can ship an update; under co-signing every key must.
                </>
              ) : (
                <>
                  Collected with Hubble &lt; {SIGNING_INFO_MIN_VERSION}, which records only a flat
                  certificate list, so any package with more than one certificate is undetermined.
                  Re-run Hubble to resolve them.
                </>
              )}
            </p>
          </div>
          <ul className="divide-y divide-line/60">
            {stats.topSigners.map((c) => (
              <li key={c.hash} className="flex items-center justify-between gap-3 px-4 py-2">
                <CertChip hash={c.hash} isPlatform={c.isPlatform} />
                <span className="text-xs text-ink-muted">
                  {c.activeFor.length > 0
                    ? pluralize(c.activeFor.length, 'package')
                    : 'retired key'}
                  {c.retiredFor.length > 0 && (
                    <span className="text-ink-faint"> · {c.retiredFor.length} retired</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card
          title="Most privileged packages"
          actions={<span className="text-[11px] text-ink-faint">by sensitive pregranted permissions</span>}
        >
          <ul className="divide-y divide-line/60">
            {stats.mostPrivileged.map((p) => (
              <li key={p.name} className="flex items-center justify-between gap-3 px-4 py-2">
                <Link
                  to={`/packages/${encodeURIComponent(p.name)}`}
                  className="min-w-0 flex-1 truncate text-sm hover:text-accent"
                  title={p.name}
                >
                  {p.label}
                  <span className="ml-2 mono text-ink-faint">{p.name}</span>
                </Link>
                <div className="flex shrink-0 items-center gap-2">
                  {p.topSeverity && <SeverityBadge severity={p.topSeverity} />}
                  <span className="w-12 text-right text-xs tabular-nums text-ink-muted">
                    {p.sensitiveGrantedCount}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title="Sensitive permissions pregranted on this device">
        <ul className="divide-y divide-line/60">
          {stats.topSensitivePerms.map((perm) => (
            <li key={perm.name} className="flex items-center gap-3 px-4 py-2">
              {perm.severity && <SeverityBadge severity={perm.severity} />}
              <Link
                to={`/permissions?q=${encodeURIComponent(perm.name)}`}
                className="min-w-0 flex-1 truncate mono hover:text-accent"
                title={perm.name}
              >
                {shortPermission(perm.name)}
              </Link>
              <span className="text-xs text-ink-muted">
                {pluralize(perm.grantedTo.length, 'package')}
              </span>
            </li>
          ))}
          {stats.topSensitivePerms.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-ink-faint">
              No permissions from the Uraniborg sensitivity table are pregranted.
            </li>
          )}
        </ul>
      </Card>
    </div>
  );
}
