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
 * Certificate detail — the destination for every signer chip in the app.
 *
 * Answers three questions:
 *  1. Who is this key? (decoded X.509 identity and validity)
 *  2. Can I trust the bytes? (we recompute the SHA-256 locally and compare it
 *     against the digest Hubble recorded on-device)
 *  3. What does it control? (every package this key can ship an update to,
 *     with their aggregate privilege — kept strictly separate from the
 *     packages that have since rotated away from it, which it controls not at
 *     all. See `lib/signing.ts`.)
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, Download, ShieldAlert, XCircle } from 'lucide-react';
import { useActiveObservation } from '@/lib/store';
import { INSTALL_STATE_LABEL, type PackageView } from '@/lib/model';
import { decodeCertificate, opensslHint, type CertificateDecodeResult } from '@/lib/x509';
import { severityRank } from '@/lib/sensitivity';
import { PageHeader } from '@/components/Layout';
import { DataTable, type Column } from '@/components/DataTable';
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  KeyValue,
  SeverityBadge,
  Stat,
} from '@/components/ui';
import { downloadBlob, formatBytes, hashColor, pluralize, shortHash } from '@/lib/format';

export function CertificateDetailPage() {
  const obs = useActiveObservation();
  const navigate = useNavigate();
  const { hash = '' } = useParams();
  const cert = obs?.certsByHash.get(hash) ?? null;

  const [decoded, setDecoded] = useState<CertificateDecodeResult | null>(null);
  const [decoding, setDecoding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDecoded(null);
    if (!cert?.encodedCert) return;
    setDecoding(true);
    void decodeCertificate(cert.encodedCert, cert.hash).then((result) => {
      if (!cancelled) {
        setDecoded(result);
        setDecoding(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [cert?.encodedCert, cert?.hash]);

  const resolve = (names: string[]): PackageView[] =>
    names.map((n) => obs?.packagesByName.get(n)).filter((p): p is PackageView => !!p);

  /** Packages this key can ship an update to. */
  const signed = useMemo<PackageView[]>(
    () => (obs && cert ? resolve(cert.activeFor) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [obs, cert],
  );
  /** Packages that have rotated away from this key. It controls none of them. */
  const retired = useMemo<PackageView[]>(
    () => (obs && cert ? resolve(cert.retiredFor) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [obs, cert],
  );

  // Aggregate privilege is computed over `signed` only. Attributing a retired
  // key's former packages to it would be the exact over-claim this page exists
  // to avoid.
  const aggregate = useMemo(() => {
    let preinstalled = 0;
    let sensitivePkgs = 0;
    let unguarded = 0;
    let cleartext = 0;
    for (const p of signed) {
      if (p.raw.isPreinstalled) preinstalled++;
      if (p.sensitiveGrantedCount > 0) sensitivePkgs++;
      unguarded += p.unguardedExportedCount;
      if (p.raw.usesCleartextTraffic) cleartext++;
    }
    return { preinstalled, sensitivePkgs, unguarded, cleartext };
  }, [signed]);

  const columns = useMemo<Array<Column<PackageView>>>(
    () => [
      {
        id: 'name',
        header: 'Package',
        width: 'minmax(260px, 2fr)',
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
        width: 'minmax(150px, 1fr)',
        sortValue: (p) => p.installState,
        render: (p) => (
          <span className="text-xs text-ink-muted">{INSTALL_STATE_LABEL[p.installState]}</span>
        ),
      },
      {
        id: 'version',
        header: 'Version',
        width: '120px',
        sortValue: (p) => p.raw.versionCode,
        render: (p) => <span className="mono text-[11px]">{p.raw.versionName ?? p.raw.versionCode}</span>,
      },
      {
        id: 'granted',
        header: 'Granted',
        width: '110px',
        align: 'right',
        sortValue: (p) => p.grantedCount,
        render: (p) => <span className="text-xs">{p.grantedCount}</span>,
      },
      {
        id: 'sensitive',
        header: 'Sensitivity',
        width: '120px',
        align: 'right',
        sortValue: (p) => severityRank(p.topSeverity),
        render: (p) =>
          p.topSeverity ? (
            <div className="flex items-center justify-end gap-1.5">
              <SeverityBadge severity={p.topSeverity} abbr />
            </div>
          ) : (
            <span className="text-xs text-ink-faint">—</span>
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
    ],
    [],
  );

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }
  if (!cert) {
    return (
      <EmptyState
        title="Unknown certificate."
        hint={
          <>
            <span className="mono">{shortHash(hash, 24)}</span> is not referenced in this
            observation. <Link className="link" to="/certificates">All signers →</Link>
          </>
        }
      />
    );
  }

  const c = decoded?.cert;
  const filePrefix = cert.hash.slice(0, 16);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Signing certificate"
        subtitle={
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-3 w-3 rounded-sm"
              style={{ background: hashColor(cert.hash) }}
            />
            <span className="mono break-all">{cert.hash}</span>
          </span>
        }
        actions={
          <>
            <Link className="btn" to="/certificates">
              <ArrowLeft size={12} /> Signers
            </Link>
            <CopyButton value={cert.hash} label="Copy SHA-256" />
            <Link className="btn btn-primary" to={`/packages?cert=${cert.hash}`}>
              Filter packages
            </Link>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat
              label="Signs"
              value={signed.length}
              hint="packages it can update today"
            />
            <Stat
              label="Retired for"
              value={retired.length}
              hint="rotated away from this key"
            />
            <Stat label="Pre-installed" value={aggregate.preinstalled} />
            <Stat
              label="Sensitive pregranted"
              value={aggregate.sensitivePkgs}
              tone={aggregate.sensitivePkgs > 0 ? 'warn' : 'default'}
              hint="of those it signs"
            />
            <Stat
              label="Unguarded exports"
              value={aggregate.unguarded}
              tone={aggregate.unguarded > 0 ? 'warn' : 'good'}
            />
          </div>

          {cert.isPlatform && (
            <div className="flex items-start gap-2 rounded-md border border-sev-high/40 bg-sev-high/10 px-4 py-3 text-xs text-sev-high">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <p className="leading-relaxed">
                This is the <strong>platform signing certificate</strong> — the current signer of
                the <code className="mono">android</code> framework package. A package whose active
                key is part of the platform&apos;s signing identity can hold{' '}
                <code className="mono">signature</code>-protected platform permissions and join{' '}
                <code className="mono">android.uid.system</code>. It is the most consequential key
                on the device: a compromise here is a platform compromise.
              </p>
            </div>
          )}

          {!cert.isPlatform && cert.isPlatformLineage && (
            <div className="flex items-start gap-2 rounded-md border border-sev-high/40 bg-sev-high/10 px-4 py-3 text-xs text-sev-high">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <p className="leading-relaxed">
                This is a <strong>retired ancestor of the platform signing lineage</strong> — the{' '}
                <code className="mono">android</code> package was signed with it before a key
                rotation. It still matters: Android evaluates platform trust against the whole
                lineage, so a system package still carrying this key is treated as platform-signed.
                Note that a rotation may have <em>revoked</em> this ancestor&apos;s capabilities,
                and those flags are not observable from any public API, so that trust may be
                over-stated here.
              </p>
            </div>
          )}

          {signed.length === 0 && retired.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-line bg-bg-soft px-4 py-3 text-xs text-ink-muted">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <p className="leading-relaxed">
                <strong>Superseded key.</strong> Every package that records this certificate has
                rotated past it, so it cannot ship an update to anything on this device. It is kept
                here because Android verified its proof-of-rotation at install time and because a
                key that used to control{' '}
                {pluralize(retired.length, 'package')} is still worth being able to look up.
              </p>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="Certificate identity"
              actions={
                c && (
                  <div className="flex gap-2">
                    <button
                      className="btn"
                      onClick={() => downloadBlob(`${filePrefix}.der`, c.der, 'application/x-x509-ca-cert')}
                    >
                      <Download size={12} /> DER
                    </button>
                    <button
                      className="btn"
                      onClick={() => downloadBlob(`${filePrefix}.pem`, c.pem, 'application/x-pem-file')}
                    >
                      <Download size={12} /> PEM
                    </button>
                  </div>
                )
              }
            >
              {!cert.encodedCert ? (
                <div className="flex items-start gap-2 px-4 py-4 text-xs text-sev-high">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <p>
                    Packages reference this signer but <code className="mono">certificates.txt</code>{' '}
                    contains no matching entry, so the certificate cannot be decoded. Load the full
                    observation directory to resolve it.
                  </p>
                </div>
              ) : decoding ? (
                <p className="px-4 py-6 text-center text-xs text-ink-faint">Decoding…</p>
              ) : !c ? (
                <p className="px-4 py-6 text-xs text-sev-critical">
                  {decoded?.error ?? 'Failed to decode certificate.'}
                </p>
              ) : (
                <KeyValue
                  rows={[
                    ['Subject CN', <span className="font-medium">{c.subjectCommonName}</span>],
                    ['Subject DN', <span className="mono break-all text-[11px]">{c.subject}</span>],
                    ['Issuer CN', c.issuerCommonName],
                    ['Issuer DN', <span className="mono break-all text-[11px]">{c.issuer}</span>],
                    [
                      'Self-signed',
                      <Badge tone={c.isSelfSigned ? 'neutral' : 'accent'}>
                        {c.isSelfSigned ? 'yes (normal for APK signing)' : 'no — issued by a CA'}
                      </Badge>,
                    ],
                    ['Serial', <span className="mono break-all text-[11px]">{c.serialNumber}</span>],
                    [
                      'Validity',
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="mono text-[11px]">
                          {c.notBefore.toISOString().slice(0, 10)} → {c.notAfter.toISOString().slice(0, 10)}
                        </span>
                        <span className="text-[11px] text-ink-faint">
                          ({(c.validityDays / 365).toFixed(1)} years)
                        </span>
                        {c.isExpired && <Badge tone="bad">expired</Badge>}
                        {c.isNotYetValid && <Badge tone="bad">not yet valid</Badge>}
                        {!c.isExpired && !c.isNotYetValid && <Badge tone="good">valid</Badge>}
                      </span>,
                    ],
                    ['Signature algorithm', <span className="mono text-[11px]">{c.signatureAlgorithm}</span>],
                    [
                      'Public key',
                      <span className="mono text-[11px]">
                        {c.publicKeyAlgorithm}
                        {c.publicKeyBits ? ` · ${c.publicKeyBits} bits` : ''}
                      </span>,
                    ],
                    ['SHA-1 fingerprint', <span className="mono break-all text-[11px]">{c.sha1}</span>],
                  ]}
                />
              )}
            </Card>

            <div className="space-y-4">
              <Card title="Integrity check">
                <div className="space-y-3 px-4 py-3">
                  {decoded?.fingerprintMatches === true && (
                    <p className="flex items-start gap-2 text-xs text-sev-ok">
                      <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                      <span>
                        Locally recomputed SHA-256 of the DER bytes matches the digest Hubble
                        recorded on-device. The certificate has not been altered in transit.
                      </span>
                    </p>
                  )}
                  {decoded?.fingerprintMatches === false && (
                    <p className="flex items-start gap-2 text-xs text-sev-critical">
                      <XCircle size={14} className="mt-0.5 shrink-0" />
                      <span>
                        <strong>Mismatch.</strong> The DER bytes hash to{' '}
                        {(decoded.derSha256 ?? c?.sha256) ? (
                          <span className="mono">{shortHash(decoded.derSha256 ?? c?.sha256 ?? '', 24)}</span>
                        ) : (
                          <span className="italic">(digest unavailable)</span>
                        )}{' '}
                        but this entry
                        is keyed under <span className="mono">{shortHash(cert.hash, 24)}</span>. Treat
                        this observation as untrustworthy until re-collected.
                      </span>
                    </p>
                  )}
                  {decoded?.fingerprintMatches === null && !decoding && (
                    <p className="text-xs text-ink-faint">Nothing to verify.</p>
                  )}
                  <div className="rounded-md border border-line bg-bg px-3 py-2">
                    <div className="label mb-1">Offline follow-up</div>
                    <code className="mono block break-all text-[11px] text-ink-muted">
                      {opensslHint(filePrefix)}
                    </code>
                  </div>
                </div>
              </Card>

              <Card title="Base64 DER">
                <div className="px-4 py-3">
                  {cert.encodedCert ? (
                    <>
                      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-bg px-2 py-1.5 mono text-[10px] leading-relaxed text-ink-faint">
                        {cert.encodedCert}
                      </pre>
                      <div className="mt-2">
                        <CopyButton value={cert.encodedCert} label="Copy base64" />
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-ink-faint">Not available.</p>
                  )}
                </div>
              </Card>
            </div>
          </div>

          <Card
            title={`Packages this certificate signs (${signed.length})`}
            actions={
              <span className="text-[11px] text-ink-faint">
                {pluralize(aggregate.preinstalled, 'pre-installed package')}
                {aggregate.cleartext > 0 ? ` · ${aggregate.cleartext} allow cleartext` : ''}
              </span>
            }
          >
            <p className="border-b border-line px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
              This key is a current signer of these packages, so it can ship an update to each of
              them. For a co-signed package it is one of several keys that must sign together.
            </p>
            <DataTable
              tableId="certificate-packages"
              rows={signed}
              columns={columns}
              rowKey={(p) => p.name}
              initialSort={{ columnId: 'sensitive', direction: 'asc' }}
              onRowClick={(p) => navigate(`/packages/${encodeURIComponent(p.name)}`)}
              maxHeight="50vh"
              emptyMessage="No package on this device is currently signed by this certificate."
            />
          </Card>

          {retired.length > 0 && (
            <Card title={`Rotated away from this certificate (${retired.length})`}>
              <p className="border-b border-line px-4 py-2 text-[11px] leading-relaxed text-ink-faint">
                These packages carry this key as a <strong>retired ancestor</strong> of their v3
                rotation lineage. It cannot sign an update for them, and their privilege is
                deliberately excluded from the totals above — but the key did control them once,
                which is worth knowing when tracing provenance.
              </p>
              <DataTable
                tableId="certificate-packages-retired"
                rows={retired}
                columns={columns}
                rowKey={(p) => p.name}
                initialSort={{ columnId: 'name', direction: 'asc' }}
                onRowClick={(p) => navigate(`/packages/${encodeURIComponent(p.name)}`)}
                maxHeight="35vh"
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
