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

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useActiveObservation } from '@/lib/store';
import { PageHeader } from '@/components/Layout';
import { Badge, Card, CertChip, EmptyState, SearchInput, Toggle } from '@/components/ui';
import type { SharedUidGroup } from '@/lib/model';

function GroupCard({ group, platformCertHash }: { group: SharedUidGroup; platformCertHash: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const retiredOnly = group.certHashes.filter((h) => !group.activeCertHashes.includes(h));
  return (
    <Card className="flex flex-col overflow-hidden">
       {/* The toggle covers the title area only. The certificate chips are links,
           and a link nested inside a <button> is invalid HTML: clicking one
           would also toggle the card, and some browsers swallow the click. */}
       <div className="flex flex-wrap items-center justify-between gap-2 bg-bg-soft p-4">
          <button
            type="button"
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 flex-wrap items-center gap-3 rounded text-left hover:text-ink"
            onClick={() => setExpanded(!expanded)}
          >
             <span className="mono font-semibold text-sm">{group.sharedUserId}</span>
             {group.isSystemUid && <Badge tone="bad">PRIVILEGED SYSTEM UID</Badge>}
             {/* Only raised when nothing links the members' signing histories.
                 Members mid-rotation legitimately record different certificates
                 and Android joins them anyway, so comparing recorded lists —
                 which is what this used to do — was mostly false alarms. */}
             {group.signersDiverge && group.divergenceKnown && (
               <Badge
                 tone="warn"
                 title="No certificate links these members' signing lineages. Android should not be joining them on a key match, so this is worth understanding."
               >
                 UNRELATED SIGNING KEYS
               </Badge>
             )}
             {group.signersDiverge && !group.divergenceKnown && (
               <Badge
                 tone="warn"
                 title="Members record different certificate sets, but this observation predates Hubble 2.2.0 so their lineages are unknown. This may simply be a rotation in progress. Re-run Hubble to resolve it."
               >
                 SIGNER SETS DIFFER · UNDETERMINED
               </Badge>
             )}
             <span className="text-ink-muted text-xs tabular-nums">{group.packageNames.length} pkgs</span>
          </button>
          <div className="flex flex-wrap items-center gap-1">
             {group.activeCertHashes.map(h => <CertChip key={h} hash={h} isPlatform={h === platformCertHash} compact />)}
             {retiredOnly.map(h => (
               <CertChip key={h} hash={h} role="retired" isPlatform={h === platformCertHash} compact />
             ))}
          </div>
       </div>
       {expanded && (
          <div className="p-4 border-t border-line bg-bg flex flex-col gap-2">
             <div className="text-xs">
                <Link to={`/packages?uid=${encodeURIComponent(group.sharedUserId)}`} className="text-accent hover:underline">
                  View all in Packages →
                </Link>
             </div>
             <ul className="flex flex-col gap-1 mt-1">
                {group.packageNames.map(name => (
                   <li key={name}>
                     <Link to={`/packages/${encodeURIComponent(name)}`} className="text-[13px] hover:underline mono text-ink-muted hover:text-ink">
                       {name}
                     </Link>
                   </li>
                ))}
             </ul>
          </div>
       )}
    </Card>
  );
}

export function SharedUidsPage() {
  const obs = useActiveObservation();
  const [params, setParams] = useSearchParams();

  const q = params.get('q') ?? '';
  const onlySys = params.get('sys') === '1';

  const groups = useMemo(() => {
    if (!obs) return [];
    const needle = q.toLowerCase().trim();
    return obs.sharedUidGroups.filter(g => {
       if (onlySys && !g.isSystemUid) return false;
       if (needle) {
          if (g.sharedUserId.toLowerCase().includes(needle)) return true;
          if (g.packageNames.some(p => p.toLowerCase().includes(needle))) return true;
          return false;
       }
       return true;
    });
  }, [obs, q, onlySys]);

  if (!obs) {
    return <EmptyState title="No observation loaded." hint={<Link className="link" to="/load">Load one →</Link>} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <PageHeader
        title="Shared UIDs"
        subtitle={`${groups.length.toLocaleString()} group${groups.length === 1 ? '' : 's'}`}
      />
      <div className="border-b border-line bg-bg-soft/50 px-6 py-4 text-sm text-ink-muted">
        <div className="xl:max-w-[80%]">
          <p>
            Packages that share a UID run inside the same sandbox: they can read each other&apos;s
            data files and effectively inherit each other&apos;s granted permissions. A shared UID
            is therefore a <strong>privilege-aggregation boundary</strong> — the group should be
            assessed as a single trust unit, not as individual apps.
          </p>
          <p className="mt-2">
            Android only honours a shared UID between packages whose signing keys match — but that
            match is evaluated against the whole <strong>rotation lineage</strong>, not one
            certificate, so members that have rotated at different times legitimately report
            different certificate sets. This view compares <em>lineages</em> rather than recorded
            lists, so it only flags a group when{' '}
            <strong>nothing at all links its members&apos; signing histories</strong> — which is
            the case actually worth understanding. Observations collected before Hubble 2.2.0 have
            no lineage data, and groups from those are marked undetermined instead.
          </p>
          <p className="mt-2 text-xs text-ink-faint">
            One thing remains out of reach: a rotation can <em>revoke</em> an ancestor&apos;s{' '}
            <code className="mono">SHARED_USER_ID</code> capability, and those flags are not exposed
            by any public API. A group can therefore look linked here while the framework treats it
            as not linked.
          </p>
        </div>
      </div>
      <div className="space-y-2 border-b border-line px-6 py-3 sticky top-0 bg-bg z-10">
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-[280px] flex-1">
            <SearchInput
              value={q}
              onChange={(v) => {
                const next = new URLSearchParams(params);
                if (v) next.set('q', v);
                else next.delete('q');
                setParams(next, { replace: true });
              }}
              placeholder="Filter by UID or member package name…"
            />
          </div>
          <Toggle
            checked={onlySys}
            onChange={(v) => {
                const next = new URLSearchParams(params);
                if (v) next.set('sys', '1');
                else next.delete('sys');
                setParams(next, { replace: true });
            }}
            label="Only privileged system UIDs"
          />
        </div>
      </div>

      <div className="p-6 flex flex-col gap-3 min-h-0">
        {groups.length === 0 ? (
           <EmptyState title="No matching shared UIDs found." />
        ) : (
           groups.map(g => <GroupCard key={g.sharedUserId} group={g} platformCertHash={obs.platformCertHash} />)
        )}
      </div>
    </div>
  );
}
