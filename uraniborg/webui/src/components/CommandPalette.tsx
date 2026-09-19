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
 * Global search palette (Cmd/Ctrl-K).
 *
 * Searches across every entity in the active observation: packages, signing
 * certificates, permissions, components and file hashes. Pasting a raw SHA-256
 * resolves it to whatever produced it, which is the single most common
 * "what is this hash?" workflow when triaging Hubble output.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Boxes, KeyRound, Package, ShieldCheck, FileDigit } from 'lucide-react';
import clsx from 'clsx';
import { useActiveObservation, useApp } from '@/lib/store';
import { shortHash, shortPermission } from '@/lib/format';
import { SeverityBadge } from './ui';

interface Hit {
  id: string;
  kind: 'package' | 'certificate' | 'permission' | 'component' | 'hash';
  title: string;
  subtitle: string;
  to: string;
  badge?: React.ReactNode;
}

const KIND_ICON = {
  package: Package,
  certificate: KeyRound,
  permission: ShieldCheck,
  component: Boxes,
  hash: FileDigit,
} as const;

const MAX_PER_KIND = 8;

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setOpen = useApp((s) => s.setPaletteOpen);
  const obs = useActiveObservation();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!obs || q.length < 2) return [];
    const out: Hit[] = [];

    for (const p of obs.packages) {
      if (out.length >= MAX_PER_KIND) break;
      if (p.searchBlob.includes(q)) {
        out.push({
          id: `p:${p.name}`,
          kind: 'package',
          title: p.label,
          subtitle: p.name,
          to: `/packages/${encodeURIComponent(p.name)}`,
          badge: p.isPlatformSigned ? <span className="text-[10px] text-sev-high">PLATFORM</span> : null,
        });
      }
    }

    let certCount = 0;
    for (const c of obs.certificates) {
      if (certCount >= MAX_PER_KIND) break;
      if (c.hash.toLowerCase().includes(q)) {
        certCount++;
        out.push({
          id: `c:${c.hash}`,
          kind: 'certificate',
          title: shortHash(c.hash, 24),
          subtitle: `${c.packageNames.length} package(s)`,
          to: `/certificates/${c.hash}`,
        });
      }
    }

    let permCount = 0;
    for (const perm of obs.permissions) {
      if (permCount >= MAX_PER_KIND) break;
      if (perm.name.toLowerCase().includes(q)) {
        permCount++;
        out.push({
          id: `perm:${perm.name}`,
          kind: 'permission',
          title: shortPermission(perm.name),
          subtitle: `granted to ${perm.grantedTo.length} package(s)`,
          to: `/permissions?q=${encodeURIComponent(perm.name)}`,
          badge: perm.severity ? <SeverityBadge severity={perm.severity} /> : null,
        });
      }
    }

    // Exact-ish hash lookup across APKs, splits, binaries and libraries.
    if (/^[0-9a-f]{8,64}$/.test(q)) {
      let hashCount = 0;
      for (const p of obs.packages) {
        if (hashCount >= MAX_PER_KIND) break;
        const match =
          p.raw.hash?.toLowerCase().startsWith(q) ||
          p.splits.some((s) => s.hash?.toLowerCase().startsWith(q));
        if (match) {
          hashCount++;
          out.push({
            id: `h:${p.name}`,
            kind: 'hash',
            title: p.name,
            subtitle: `APK/split digest match`,
            to: `/packages/${encodeURIComponent(p.name)}`,
          });
        }
      }
      // Tagged with the tab each list lives on: /binaries defaults to the
      // binaries tab, so an untagged library hit would land on an empty table.
      const nativeFiles = [
        ...obs.bins.map((b) => ({ file: b, tab: 'bins' as const })),
        ...obs.libs.map((b) => ({ file: b, tab: 'libs' as const })),
      ];
      for (const { file: b, tab } of nativeFiles) {
        if (hashCount >= MAX_PER_KIND) break;
        if (b.hash?.toLowerCase().startsWith(q)) {
          hashCount++;
          out.push({
            id: `h:${tab}:${b.installPath ?? ''}/${b.name}:${b.hash}`,
            kind: 'hash',
            title: b.name,
            subtitle: b.installPath ?? '',
            to: `/binaries?tab=${tab}&q=${encodeURIComponent(b.hash ?? '')}`,
          });
        }
      }
    }

    let compCount = 0;
    for (const p of obs.packages) {
      if (compCount >= MAX_PER_KIND) break;
      for (const c of p.exportedComponents) {
        if (compCount >= MAX_PER_KIND) break;
        if (c.name.toLowerCase().includes(q)) {
          compCount++;
          out.push({
            id: `comp:${p.name}:${c.name}`,
            kind: 'component',
            title: c.name,
            subtitle: `${c.componentType} in ${p.name}`,
            to: `/packages/${encodeURIComponent(p.name)}?tab=components`,
          });
        }
      }
    }

    return out;
  }, [obs, query]);

  useEffect(() => setCursor(0), [hits.length]);

  if (!open) return null;

  const go = (hit: Hit) => {
    setOpen(false);
    navigate(hit.to);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-line bg-bg-soft shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm outline-none placeholder:text-ink-faint"
          placeholder="Search packages, signers, permissions, components, or paste a SHA-256…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, hits.length - 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            }
            if (e.key === 'Enter' && hits[cursor]) go(hits[cursor]);
          }}
        />
        <div className="max-h-[50vh] overflow-y-auto">
          {hits.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-ink-faint">
              {query.trim().length < 2
                ? 'Type at least two characters.'
                : 'No matches in the active observation.'}
            </p>
          ) : (
            hits.map((hit, i) => {
              const Icon = KIND_ICON[hit.kind];
              return (
                <button
                  key={hit.id}
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => go(hit)}
                  className={clsx(
                    'flex w-full items-center gap-3 px-4 py-2 text-left',
                    i === cursor ? 'bg-accent/15' : 'hover:bg-bg-hover',
                  )}
                >
                  <Icon size={14} className="shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{hit.title}</span>
                    <span className="block truncate font-mono text-[11px] text-ink-faint">
                      {hit.subtitle}
                    </span>
                  </span>
                  {hit.badge}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
