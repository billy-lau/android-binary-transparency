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
 * Signing certificate index.
 *
 * Grouping by signer answers "who actually controls the code on this device?".
 * A single OEM key signing dozens of platform-privileged packages is a very
 * different posture from many independent third-party signers.
 *
 * "Controls" means *can ship an update today*, so the aggregate columns count
 * only the packages a key is a current signer for. A key that appears solely
 * as a retired ancestor of some rotation lineage controls nothing, and is
 * reported separately rather than inflating its apparent reach.
 */

import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import { useActiveObservation } from '@/lib/store';
import type { CertificateView } from '@/lib/model';
import { PageHeader } from '@/components/Layout';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, EmptyState, SearchInput, Toggle } from '@/components/ui';
import { downloadBlob, hashColor, pluralize, toCsv } from '@/lib/format';
import { decodeIdentity, type CertificateIdentity } from '@/lib/x509';

interface CertRow extends CertificateView {
  preinstalledCount: number;
  /** Packages this key currently signs that hold >=1 sensitive pregranted permission. */
  sensitivePkgCount: number;
  /**
   * Self-asserted subject of the certificate, when the bytes were present and
   * parsed. Null for an orphan or an unparsable DER.
   */
  identity: CertificateIdentity | null;
}

export function CertificatesPage() {
  const obs = useActiveObservation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const onlyMulti = params.get('multi') === '1';
  const onlyOrphan = params.get('orphan') === '1';
  const onlyRetired = params.get('retired') === '1';

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (!value) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo<CertRow[]>(() => {
    if (!obs) return [];
    const needle = q.trim().toLowerCase();
    return obs.certificates
      .map((c) => {
        let preinstalledCount = 0;
        let sensitivePkgCount = 0;
        // Deliberately `activeFor`, not `packageNames`: a retired key confers
        // no current privilege, so counting its historical packages here would
        // overstate what it can reach.
        for (const name of c.activeFor) {
          const pkg = obs.packagesByName.get(name);
          if (!pkg) continue;
          if (pkg.raw.isPreinstalled) preinstalledCount++;
          if (pkg.sensitiveGrantedCount > 0) sensitivePkgCount++;
        }
        return { ...c, preinstalledCount, sensitivePkgCount, identity: decodeIdentity(c.encodedCert) };
      })
      .filter((c) => {
        // The decoded CN and O are matched alongside the raw DN because the DN
        // is RFC 4514: a value containing a comma is stored escaped, so the
        // subject string holds `O=Google\, Inc.` while the table shows
        // `Google, Inc.`. Searching only the DN would fail on the exact text
        // the user is reading.
        const identityText = [
          c.identity?.subject,
          c.identity?.commonName,
          c.identity?.organization,
        ];
        if (
          needle &&
          !c.hash.toLowerCase().includes(needle) &&
          !c.packageNames.some((n) => n.toLowerCase().includes(needle)) &&
          !identityText.some((t) => (t ?? '').toLowerCase().includes(needle))
        )
          return false;
        if (onlyMulti && c.activeFor.length < 2) return false;
        if (onlyOrphan && !c.isOrphan) return false;
        if (onlyRetired && !(c.retiredFor.length > 0 && c.activeFor.length === 0)) return false;
        return true;
      });
  }, [obs, q, onlyMulti, onlyOrphan, onlyRetired]);

  const columns = useMemo<Array<Column<CertRow>>>(
    () => [
      {
        id: 'hash',
        header: 'Certificate SHA-256',
        width: 'minmax(320px, 2fr)',
        sortValue: (c) => c.hash,
        // The full 64 hex characters are rendered and the cell clips them, so
        // widening the column reveals more of the hash instead of revealing
        // whitespace after a fixed 40-character stub. Truncation stays on the
        // right because a hash is compared from its prefix.
        render: (c) => (
          <div className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: hashColor(c.hash) }}
            />
            <span className="min-w-0 truncate mono text-[12px]" title={c.hash}>
              {c.hash}
            </span>
          </div>
        ),
      },
      {
        id: 'identity',
        header: 'Subject',
        width: 'minmax(180px, 1.4fr)',
        sortValue: (c) => c.identity?.commonName ?? '',
        title:
          'Self-asserted subject of the certificate. Android signing certificates are ' +
          'self-signed, so nobody has verified this name — it is a hint for recognising ' +
          'a key, not proof of who holds it. The hash is the identity.',
        render: (c) => {
          if (!c.identity) {
            return (
              <span
                className="text-[11px] text-ink-faint"
                title={
                  c.isOrphan
                    ? 'certificates.txt had no entry for this hash, so there are no bytes to decode.'
                    : 'The recorded bytes are not a parsable X.509 certificate.'
                }
              >
                {c.isOrphan ? 'no bytes' : 'unparsable'}
              </span>
            );
          }
          return (
            <span
              className="flex min-w-0 flex-col justify-center leading-tight"
              title={c.identity.subject}
            >
              <span className="truncate text-xs text-ink-muted">{c.identity.commonName}</span>
              {c.identity.organization && c.identity.organization !== c.identity.commonName && (
                <span className="truncate text-[10px] text-ink-faint">
                  {c.identity.organization}
                </span>
              )}
            </span>
          );
        },
      },
      {
        id: 'tags',
        header: 'Role',
        width: 'minmax(180px, 0.9fr)',
        render: (c) => {
          const retiredOnly = c.activeFor.length === 0 && c.retiredFor.length > 0;
          return (
            <div className="flex flex-wrap gap-1">
              {c.isPlatform && <Badge tone="warn">PLATFORM</Badge>}
              {!c.isPlatform && c.isPlatformLineage && (
                <Badge
                  tone="warn"
                  title="A retired ancestor of the platform's own signing lineage. Packages carrying it are still platform-trusted, because Android matches against the whole lineage."
                >
                  platform (retired)
                </Badge>
              )}
              {retiredOnly && (
                <Badge
                  title="Only ever appears as a superseded ancestor of a rotation lineage. It cannot sign an update for anything on this device."
                >
                  retired key
                </Badge>
              )}
              {c.isOrphan && (
                <Badge tone="bad" title="Referenced by a package but absent from certificates.txt">
                  missing DER
                </Badge>
              )}
              {!c.isPlatform && !c.isPlatformLineage && !c.isOrphan && !retiredOnly && (
                // Accent, not the default grey: this key can ship an update
                // today, which is the opposite of the retired key above.
                <Badge
                  tone="accent"
                  title="A non-platform key that currently signs at least one package."
                >
                  app signer
                </Badge>
              )}
            </div>
          );
        },
      },
      {
        id: 'count',
        header: 'Signs',
        width: '90px',
        align: 'right',
        sortValue: (c) => c.activeFor.length,
        title: 'Packages this certificate can ship an update to today',
        render: (c) => (
          <span className={c.activeFor.length === 0 ? 'text-sm text-ink-faint' : 'text-sm'}>
            {c.activeFor.length}
          </span>
        ),
      },
      {
        id: 'retired',
        header: 'Retired',
        width: '100px',
        align: 'right',
        sortValue: (c) => c.retiredFor.length,
        title:
          'Packages that list this certificate only as a superseded ancestor of their rotation lineage',
        render: (c) => (
          <span className="text-xs text-ink-faint">{c.retiredFor.length || '—'}</span>
        ),
      },
      {
        id: 'preinstalled',
        header: 'Pre-installed',
        width: '120px',
        align: 'right',
        sortValue: (c) => c.preinstalledCount,
        title: 'Of the packages it currently signs, how many are pre-installed',
        render: (c) => <span className="text-xs text-ink-muted">{c.preinstalledCount}</span>,
      },
      {
        id: 'sensitive',
        header: 'Sensitive pkgs',
        width: '130px',
        align: 'right',
        sortValue: (c) => c.sensitivePkgCount,
        title:
          'Packages this key currently signs that hold at least one sensitive pregranted permission',
        render: (c) => (
          <span className={c.sensitivePkgCount > 0 ? 'text-xs text-sev-high' : 'text-xs text-ink-faint'}>
            {c.sensitivePkgCount}
          </span>
        ),
      },
      {
        id: 'sample',
        header: 'Recorded by',
        width: 'minmax(220px, 1.2fr)',
        render: (c) => (
          <span className="truncate mono text-[11px] text-ink-faint" title={c.packageNames.join('\n')}>
            {c.packageNames.slice(0, 3).join(', ')}
            {c.packageNames.length > 3 ? ` +${c.packageNames.length - 3}` : ''}
          </span>
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
      [
        'sha256',
        'subject',
        'isPlatform',
        'isPlatformLineage',
        'hasDer',
        'signsCount',
        'retiredForCount',
        'preinstalledCount',
        'sensitivePackages',
        'signsPackages',
        'retiredForPackages',
      ],
      rows.map((c) => [
        c.hash,
        c.identity?.subject ?? '',
        c.isPlatform,
        c.isPlatformLineage,
        !c.isOrphan,
        c.activeFor.length,
        c.retiredFor.length,
        c.preinstalledCount,
        c.sensitivePkgCount,
        c.activeFor.join(' '),
        c.retiredFor.join(' '),
      ]),
    );
    downloadBlob(`${obs.title.replace(/\W+/g, '_')}_signers.csv`, csv, 'text/csv');
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Signing certificates"
        subtitle={`${pluralize(rows.length, 'signer')} · ${pluralize(obs.packages.length, 'package')} on device`}
        actions={
          <button className="btn" onClick={exportCsv}>
            <Download size={12} /> Export CSV
          </button>
        }
      />

      <div className="space-y-2 border-b border-line px-6 py-3">
        <div className="max-w-xl">
          <SearchInput
            value={q}
            onChange={(v) => setParam('q', v || null)}
            placeholder="Filter by certificate hash, subject, or a package that records it…"
          />
        </div>
        <div className="flex flex-wrap gap-4">
          <Toggle
            checked={onlyMulti}
            onChange={(v) => setParam('multi', v ? '1' : null)}
            label="Currently signs more than one package"
          />
          <Toggle
            checked={onlyRetired}
            onChange={(v) => setParam('retired', v ? '1' : null)}
            label="Superseded keys only"
          />
          <Toggle
            checked={onlyOrphan}
            onChange={(v) => setParam('orphan', v ? '1' : null)}
            label="Missing certificate bytes"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 px-6 py-3">
        <div className="card flex h-full min-h-0 flex-col overflow-hidden">
          <DataTable
            tableId="certificates"
            rows={rows}
            columns={columns}
            rowKey={(c) => c.hash}
            initialSort={{ columnId: 'count', direction: 'desc' }}
            onRowClick={(c) => navigate(`/certificates/${c.hash}`)}
            maxHeight="calc(100vh - 300px)"
          />
        </div>
      </div>
    </div>
  );
}
