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
 * How Hubble data is shown: badges, notes, labels and filter choices for
 * sensitivity tiers, transparency (inclusion proof) and signing.
 */

import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { hashColor, shortHash } from '@/shared/lib/format';
import { Badge, type BadgeTone } from '@/shared/components/ui';
import {
  SENSITIVITY_SOURCE,
  SENSITIVITY_SOURCE_NOTE,
  type PermissionSeverity,
} from '@/analyze/lib/sensitivity';
import { hasSplitNotInLog, type InclusionProofState, type InclusionProofSummary } from '@/analyze/lib/model';
import {
  describeSigning,
  SIGNING_MODE_SHORT,
  UNKNOWN_REASON_NOTE,
  type SigningFacts,
} from '@/analyze/lib/signing';
import { analyzePath } from '@/analyze/paths';

export const SEVERITY_TONE: Record<PermissionSeverity, BadgeTone> = {
  ASTRONOMICAL: 'worst',
  CRITICAL: 'bad',
  HIGH: 'warn',
  MEDIUM: 'accent',
  LOW: 'neutral',
};

/** Short forms for dense table cells where the full word would overflow. */
const SEVERITY_ABBR: Record<PermissionSeverity, string> = {
  ASTRONOMICAL: 'ASTRO',
  CRITICAL: 'CRIT',
  HIGH: 'HIGH',
  MEDIUM: 'MED',
  LOW: 'LOW',
};

export function SeverityBadge({
  severity,
  abbr,
}: {
  severity: PermissionSeverity;
  abbr?: boolean;
}) {
  return (
    <Badge
      tone={SEVERITY_TONE[severity]}
      title={`Sensitivity tier ${severity} — ${SENSITIVITY_SOURCE}`}
    >
      {abbr ? SEVERITY_ABBR[severity] : severity}
    </Badge>
  );
}

/**
 * Attribution for the sensitivity tiers.
 *
 * These tiers are the one thing in this UI that is not observed from the
 * device — they are a judgement call published in a 2020 paper. Anywhere a
 * tier drives what the reader sees, say where it came from, so nobody mistakes
 * it for something Hubble measured.
 */
export function SensitivitySourceNote({ className }: { className?: string }) {
  return (
    <p
      className={clsx('text-[11px] leading-relaxed text-ink-faint', className)}
      title={SENSITIVITY_SOURCE_NOTE}
    >
      Sensitivity tiers: {SENSITIVITY_SOURCE}. Not measured by Hubble; weights and
      composite risk score deliberately not used.
    </p>
  );
}

export const PROOF_STATE_LABEL: Record<InclusionProofState, string> = {
  verified: 'in log',
  partial: 'partially in log',
  failed: 'not in log',
  unchecked: 'not checked',
};

/**
 * Transparency filter choices, shared by every page that filters on them so a
 * `?proof=` link means the same thing wherever it lands. Ordered by triage.
 */
export const PROOF_FILTER_OPTIONS: Array<{ id: InclusionProofState | 'all'; label: string }> = [
  { id: 'all', label: 'All transparency states' },
  { id: 'failed', label: 'Not in log' },
  { id: 'partial', label: 'Partially in log' },
  { id: 'unchecked', label: 'Not checked' },
  { id: 'verified', label: 'In log' },
];

/** Reads a `?proof=` value, falling back to `'all'` for anything unrecognised. */
export function parseProofFilter(value: string | null): InclusionProofState | 'all' {
  return PROOF_FILTER_OPTIONS.find((o) => o.id === value)?.id ?? 'all';
}

/**
 * Android Binary Transparency status for a package.
 *
 * `partial` is deliberately tinted as an error when at least one split was
 * actively *not found*: one unpublished split in an otherwise published app is
 * exactly the anomaly this log exists to expose. A partial result caused only
 * by splits the proof run never covered is merely incomplete, so it warns.
 */
export function ProofBadge({
  proof,
  compact,
}: {
  proof: InclusionProofSummary;
  compact?: boolean;
}) {
  const tone: BadgeTone =
    proof.state === 'verified'
      ? 'good'
      : proof.state === 'failed'
        ? 'bad'
        : proof.state === 'partial'
          ? hasSplitNotInLog(proof)
            ? 'bad'
            : 'warn'
          : 'neutral';
  const label =
    proof.state === 'partial' || (!compact && proof.total > 1 && proof.state !== 'unchecked')
      ? `${proof.verified}/${proof.total} in log`
      : PROOF_STATE_LABEL[proof.state];
  const title =
    proof.state === 'unchecked'
      ? 'No inclusion-proof result was loaded for this package'
      : `${proof.verified} of ${proof.total} splits found in the Android Binary Transparency log` +
        (proof.failed ? ` · ${proof.failed} not found` : '') +
        (proof.unknown ? ` · ${proof.unknown} without a result` : '');
  return (
    <Badge tone={tone} title={title}>
      {label}
    </Badge>
  );
}

/**
 * A signer hash rendered as a clickable chip. The colour swatch is derived
 * from the hash so the same signer is instantly recognisable anywhere.
 *
 * `role` is the load-bearing part: a retired ancestor of a rotation lineage is
 * rendered visibly differently from a key that can sign an update today,
 * because those two things look identical in the raw JSON and must never look
 * identical here.
 */
export function CertChip({
  hash,
  isPlatform,
  count,
  compact,
  role = 'active',
  ordinal,
}: {
  hash: string;
  isPlatform?: boolean;
  count?: number;
  compact?: boolean;
  /** `retired` marks a superseded lineage ancestor. */
  role?: 'active' | 'retired';
  /** 1-based position in a rotation lineage, shown as a `#n` prefix. */
  ordinal?: number;
}) {
  const retired = role === 'retired';
  const title = [
    hash,
    isPlatform ? '(platform signing certificate)' : '',
    retired
      ? '— RETIRED: a superseded ancestor in this package\u2019s rotation lineage. It cannot sign an update.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <Link
      to={analyzePath(`/certificates/${hash}`)}
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[11px] transition-colors',
        retired
          ? 'border-dashed border-line bg-transparent text-ink-faint hover:border-accent/40 hover:text-ink-muted'
          : isPlatform
            ? 'border-sev-high/50 bg-sev-high/10 text-sev-high hover:bg-sev-high/20'
            : 'border-line bg-bg-raised text-ink-muted hover:border-accent/50 hover:text-accent',
      )}
    >
      <span
        aria-hidden
        className={clsx('h-2 w-2 shrink-0 rounded-sm', retired && 'opacity-40')}
        style={{ background: hashColor(hash) }}
      />
      {ordinal !== undefined && <span className="text-ink-faint">#{ordinal}</span>}
      <span className={clsx(retired && 'line-through decoration-ink-faint/60')}>
        {shortHash(hash, compact ? 8 : 12)}
      </span>
      {isPlatform && <span className="font-sans text-[10px] font-semibold">PLATFORM</span>}
      {retired && <span className="font-sans text-[10px] font-semibold">RETIRED</span>}
      {count !== undefined && <span className="text-ink-faint">×{count}</span>}
    </Link>
  );
}

/**
 * The resolved signing mode, as a badge.
 *
 * Tone encodes what an analyst should do about it, not how unusual it is:
 * co-signing and undetermined both mean "you cannot point at one key", so they
 * get attention; a rotation lineage is normal and gets none.
 */
export function SigningModeBadge({
  facts,
  className,
}: {
  facts: SigningFacts;
  className?: string;
}) {
  const tone: BadgeTone =
    facts.mode === 'unknown' ? 'warn' : facts.mode === 'multiple-signers' ? 'accent' : 'neutral';
  return (
    <Badge tone={tone} title={describeSigning(facts)} className={className}>
      {SIGNING_MODE_SHORT[facts.mode]}
      {facts.mode === 'key-rotation-lineage' && ` · ${facts.pastSigners.length} retired`}
      {facts.mode === 'multiple-signers' && ` · ${facts.activeSigners.length}`}
    </Badge>
  );
}

/**
 * Explains a package's signing configuration in one sentence.
 *
 * Says nothing at all for the unremarkable case (one signer, no history) —
 * there is no ambiguity to warn about and a note on every package would train
 * people to ignore the notes that matter.
 */
export function SigningNote({ facts, className }: { facts: SigningFacts; className?: string }) {
  if (facts.mode === 'single-signer') return null;

  if (facts.mode === 'unknown') {
    return (
      <p className={clsx('text-[11px] leading-relaxed text-sev-high', className)}>
        <strong>Signing configuration undetermined.</strong>{' '}
        {facts.unknownReason ? UNKNOWN_REASON_NOTE[facts.unknownReason] : ''}
        {facts.allSigners.length > 1 &&
          ' Until it is resolved, do not assume any one of these certificates is the current signer.'}
      </p>
    );
  }

  if (facts.mode === 'multiple-signers') {
    return (
      <p className={clsx('text-[11px] leading-relaxed text-ink-muted', className)}>
        <strong>Co-signed by {facts.activeSigners.length} certificates.</strong> All of them are
        current and all are required to ship an update; the order carries no meaning. v3 key
        rotation is not supported for multi-signer APKs, so none of these is a retired key.
      </p>
    );
  }

  return (
    <p className={clsx('text-[11px] leading-relaxed text-ink-muted', className)}>
      <strong>Key rotated.</strong> One current signer with {facts.pastSigners.length} retired{' '}
      {facts.pastSigners.length === 1 ? 'ancestor' : 'ancestors'}, ordered oldest first. Only the
      current key can ship an update; Android verified the v3 proof-of-rotation at install time.
    </p>
  );
}
