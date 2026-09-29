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
 * Signing certificate inference.
 *
 * Hubble 2.2.0 records `signingInfo` per package, which is what finally makes
 * the flat `certIds` list decidable: a list of two is either a v3 key rotation
 * lineage or a set of concurrent co-signers, and those have opposite answers to
 * the only question that matters operationally — *which key can ship an update
 * to this package today*. Under rotation it is the last key alone; under
 * co-signing it is all of them, together.
 *
 * This module is the single place that reading happens. Every view derives
 * from {@link SigningFacts} rather than touching `certIds`, so the UI states
 * one consistent thing and legacy observations degrade to an explicit
 * `unknown` instead of a plausible-looking guess.
 *
 * The classification deliberately mirrors
 * `scripts/python/hubble_parser.py::classify_package_signing()` case for case,
 * including its refusals. If you change one, change the other.
 *
 * Reference: docs/hubble_results.md, "Determining Package Signing Certificate
 * Lineage vs. Co-Signing".
 */

import type { PlatformSignatureMatch, RawPackage, RawSigningInfo } from './types';

/** First Hubble schema that emits `signingInfo`. */
export const SIGNING_INFO_MIN_VERSION = '2.2.0';

export type SigningMode =
  /** One signer, no rotation history. */
  | 'single-signer'
  /** One *active* signer, plus retired ancestors in a v3 lineage. */
  | 'key-rotation-lineage'
  /** Two or more concurrent co-signers. Mutually exclusive with rotation. */
  | 'multiple-signers'
  /** Not determinable from this observation. See {@link UnknownSigningReason}. */
  | 'unknown';

/**
 * Why a mode came out `unknown`. The distinction matters in the UI: a legacy
 * observation can be fixed by re-running Hubble, whereas `unobservable` is a
 * property of the device that no re-run will improve.
 */
export type UnknownSigningReason =
  /** Observation predates schema 2.2.0; no `signingInfo` at all. */
  | 'legacy-schema'
  /** API < 28: PackageManager exposes no v3 lineage API on the device. */
  | 'unobservable'
  /** `signingInfo` present but carries no usable digests. */
  | 'no-certificates';

export interface SigningFacts {
  mode: SigningMode;
  /** Set only when {@link mode} is `unknown`. */
  unknownReason: UnknownSigningReason | null;
  /** False on legacy observations, i.e. `signingInfo` was absent. */
  structured: boolean;
  /**
   * The key(s) that can sign an update today. One entry for a single signer or
   * a rotation lineage, several for a co-signed APK.
   *
   * On a legacy observation this degrades to the whole `certIds` list, which
   * over-approximates: a rotated package contributes its retired ancestors
   * too. That is why `mode` is `unknown` there — consumers must say so rather
   * than present this as a current-signer set.
   */
  activeSigners: string[];
  /**
   * Rotation lineage ordered **oldest ancestor first, current signer last**.
   * Empty when co-signed, when unobservable, or on a legacy observation —
   * deliberately never backfilled from `certIds`, so "no lineage" is never
   * confused with "lineage unknown".
   */
  lineage: string[];
  /** Retired ancestors: {@link lineage} minus the current signer. */
  pastSigners: string[];
  /**
   * Every certificate ever associated with the package (lineage ∪ active ∪
   * `certIds`).
   *
   * WARNING: only sound as the *trust anchor* side of a comparison, e.g. "the
   * set of certificates that identify the platform". Never intersect two of
   * these: a package that rotated *away* from a trusted key still carries that
   * key in its lineage, so a symmetric intersection keeps trusting it forever.
   * For the candidate side use {@link activeSigners}.
   */
  allSigners: string[];
  /** Recorded `checkSignatures()` verdict; descriptive only, never a decision. */
  platformSignatureMatch: PlatformSignatureMatch | null;
}

export const SIGNING_MODE_LABEL: Record<SigningMode, string> = {
  'single-signer': 'Single signer',
  'key-rotation-lineage': 'Key rotation lineage',
  'multiple-signers': 'Co-signed',
  unknown: 'Undetermined',
};

/** Compact form for table cells and chips. */
export const SIGNING_MODE_SHORT: Record<SigningMode, string> = {
  'single-signer': 'single',
  'key-rotation-lineage': 'rotated',
  'multiple-signers': 'co-signed',
  unknown: 'undetermined',
};

export const SIGNING_MODE_DESCRIPTION: Record<SigningMode, string> = {
  'single-signer':
    'Signed by one certificate with no recorded rotation history. That key, and only that key, can ship an update.',
  'key-rotation-lineage':
    'One active signer with retired ancestors in its v3 lineage. Only the newest key can ship an update; the older entries are historical and Android verified the proof-of-rotation at install time.',
  'multiple-signers':
    'Co-signed by several concurrent certificates. All of them together are required to ship an update. v3 key rotation is not supported for multi-signer APKs, so none of these is a retired key.',
  unknown: 'The signing configuration cannot be determined from this observation.',
};

export const UNKNOWN_REASON_NOTE: Record<UnknownSigningReason, string> = {
  'legacy-schema':
    `Collected with Hubble < ${SIGNING_INFO_MIN_VERSION}, which records only a flat certificate list. ` +
    'A list of more than one is either a rotation lineage or a set of co-signers and the artifact does not say which. ' +
    'Re-run Hubble to resolve it.',
  unobservable:
    'Collected on an API < 28 device, where PackageManager exposes no v3 lineage API. ' +
    'Whether this key was ever rotated is unobservable there — not known to be false. ' +
    'Co-signing is still reported affirmatively, because the signer count itself is observable.',
  'no-certificates':
    'Hubble recorded a signingInfo block for this package but no usable certificate digests, ' +
    'so nothing can be concluded about its signers.',
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

const LEGACY_FACTS_BASE = {
  mode: 'unknown' as const,
  unknownReason: 'legacy-schema' as const,
  structured: false,
  lineage: [] as string[],
  pastSigners: [] as string[],
  platformSignatureMatch: null,
};

/**
 * Resolves a package's recorded certificates into what they actually mean.
 *
 * Mirrors `HubbleParser.classify_package_signing()`. The ordering of the
 * checks is load-bearing:
 *
 *  1. Co-signing is tested first, because a signer count > 1 is directly
 *     observable on *every* API level. It stays affirmative even when the
 *     rotation state is not.
 *  2. Rotation next, from either the recorded boolean or a lineage of > 1.
 *  3. Only then is an unobservable rotation state (API < 28, `null`) allowed to
 *     force `unknown` — so a pre-P device never gets reported as
 *     "single signer, never rotated" on the strength of evidence that does not
 *     exist.
 */
export function deriveSigningFacts(pkg: RawPackage): SigningFacts {
  const certIds = asStringArray(pkg?.certIds);
  const info: RawSigningInfo | null = pkg?.signingInfo ?? null;

  if (!info || typeof info !== 'object') {
    return {
      ...LEGACY_FACTS_BASE,
      activeSigners: [...certIds],
      allSigners: unique(certIds),
    };
  }

  const hasMultipleSigners = info.hasMultipleSigners === true;
  // Tri-state. `null` means unobservable (API < 28), not false.
  const rotationStateKnown = typeof info.hasPastSigningCertificates === 'boolean';
  const hasPastSigningCertificates = info.hasPastSigningCertificates === true;

  // A multi-signer APK has no lineage by construction; ignore the field even if
  // the device populated it, so downstream code cannot render a co-signer set
  // as an ordered history.
  const lineage = hasMultipleSigners ? [] : asStringArray(info.signingCertificateLineage);

  let activeSigners = asStringArray(info.apkContentsSigners);
  if (activeSigners.length === 0 && !hasMultipleSigners && lineage.length > 0) {
    // apkContentsSigners should always be populated in 2.2.0+, but a digest can
    // fail to compute on device. Android orders the lineage oldest -> current,
    // so the tail is the active signer.
    activeSigners = [lineage[lineage.length - 1]];
  }

  const pastSigners = lineage.length > 1 ? lineage.slice(0, -1) : [];
  const allSigners = unique([...lineage, ...activeSigners, ...certIds]);
  const platformSignatureMatch = info.platformSignatureMatch ?? null;

  const base = {
    structured: true,
    activeSigners,
    lineage,
    pastSigners,
    allSigners,
    platformSignatureMatch,
  };

  if (activeSigners.length === 0 && lineage.length === 0) {
    return { ...base, mode: 'unknown', unknownReason: 'no-certificates' };
  }
  if (hasMultipleSigners || activeSigners.length > 1) {
    return { ...base, mode: 'multiple-signers', unknownReason: null };
  }
  if (hasPastSigningCertificates || lineage.length > 1) {
    return { ...base, mode: 'key-rotation-lineage', unknownReason: null };
  }
  if (!rotationStateKnown) {
    return { ...base, mode: 'unknown', unknownReason: 'unobservable' };
  }
  if (activeSigners.length === 1 || lineage.length === 1) {
    return { ...base, mode: 'single-signer', unknownReason: null };
  }
  return { ...base, mode: 'unknown', unknownReason: 'no-certificates' };
}

/**
 * The single current signer, when there is exactly one.
 *
 * `null` for a co-signed package (there is no single answer) and for a legacy
 * observation (the list cannot be narrowed). Callers that want "the key to
 * show first" should fall back to `activeSigners[0]`.
 */
export function currentSigner(facts: SigningFacts): string | null {
  if (facts.mode === 'single-signer' || facts.mode === 'key-rotation-lineage') {
    return facts.activeSigners[0] ?? facts.lineage[facts.lineage.length - 1] ?? null;
  }
  return null;
}

/** True when `hash` is a retired ancestor rather than a current signer. */
export function isRetiredSigner(facts: SigningFacts, hash: string): boolean {
  return facts.pastSigners.includes(hash) && !facts.activeSigners.includes(hash);
}

/** One-line summary used for chip and badge tooltips. */
export function describeSigning(facts: SigningFacts): string {
  const base = SIGNING_MODE_DESCRIPTION[facts.mode];
  if (facts.mode === 'unknown' && facts.unknownReason) {
    return `${base} ${UNKNOWN_REASON_NOTE[facts.unknownReason]}`;
  }
  if (facts.mode === 'key-rotation-lineage') {
    return `${base} Current signer: ${currentSigner(facts) ?? 'unknown'}; ${facts.pastSigners.length} retired.`;
  }
  return base;
}

/**
 * The platform's signing identity, read off the `android` framework package.
 */
export interface PlatformIdentity {
  /**
   * The certificate badged as PLATFORM across the UI: the *currently active*
   * platform signer.
   *
   * For a legacy observation this degrades to `certIds[0]`, which for a rotated
   * platform key is the oldest ancestor — matching what this UI showed before
   * `signingInfo` existed, and what Android itself keeps matching against.
   */
  primary: string | null;
  /** Active platform signer(s). */
  active: string[];
  /**
   * Full trust anchor: every certificate the `android` package has ever been
   * signed by, so a platform key rotation does not orphan system packages
   * still signed with a retired platform certificate.
   */
  anchor: Set<string>;
  mode: SigningMode;
  facts: SigningFacts | null;
}

export const PLATFORM_PACKAGE_NAME = 'android';

export function derivePlatformIdentity(packages: RawPackage[]): PlatformIdentity {
  const androidPkg = packages.find((p) => p.name === PLATFORM_PACKAGE_NAME);
  if (!androidPkg) {
    return { primary: null, active: [], anchor: new Set(), mode: 'unknown', facts: null };
  }
  const facts = deriveSigningFacts(androidPkg);
  return {
    primary: facts.activeSigners[0] ?? null,
    active: [...facts.activeSigners],
    anchor: new Set(facts.allSigners),
    mode: facts.mode,
    facts,
  };
}

/**
 * Whether a package shares a signing identity with the platform.
 *
 * Directional on purpose, mirroring `HubbleParser.is_platform_signed()`: the
 * package's **active** signers are tested against the platform's **full**
 * lineage. The platform side may use its whole history because it is the trust
 * anchor; the candidate side may not, or a package that rotated away from the
 * platform key would stay "platform-signed" forever on the strength of a
 * retired certificate.
 *
 * KNOWN LIMITATION: the per-ancestor `SigningDetails.CertCapabilities` flags
 * (`PERMISSION`, `SHARED_USER_ID`, ...) that a rotation may revoke are not
 * reachable from any public API, so Hubble cannot record them and this may
 * over-approximate platform trust for packages still signed with a retired
 * platform certificate.
 */
export function isPlatformSigned(facts: SigningFacts, platform: PlatformIdentity): boolean {
  if (platform.anchor.size === 0) return false;
  return facts.activeSigners.some((h) => platform.anchor.has(h));
}

/**
 * How a package's signers changed between two observations.
 *
 * `rotation` is only claimed when the evidence is positive: the earlier lineage
 * is a strict prefix of the later one, which is exactly what appending a new
 * key to a v3 lineage looks like. Anything else that moved is a signer change,
 * which is the one that warrants attention.
 */
export type SignerChangeKind =
  | 'none'
  /** Lineage extended by one or more newer keys. Expected, benign. */
  | 'rotation'
  /** Active signers genuinely differ, and not by rotation. */
  | 'signer-change'
  /** Something moved, but at least one side is legacy so it cannot be named. */
  | 'undetermined';

export const SIGNER_CHANGE_LABEL: Record<SignerChangeKind, string> = {
  none: '—',
  rotation: 'key rotated',
  'signer-change': 'signer changed',
  undetermined: 'signer set changed',
};

export const SIGNER_CHANGE_TITLE: Record<SignerChangeKind, string> = {
  none: 'Signers are unchanged between the two observations.',
  rotation:
    'The rotation lineage was extended: every certificate recorded before is still present, in the same order, with one or more newer keys appended. This is what a legitimate v3 key rotation looks like.',
  'signer-change':
    'The active signer(s) changed and the earlier lineage was not simply extended. This is a re-signing, not a rotation, and is worth investigating.',
  undetermined:
    'The recorded certificate set changed, but at least one of the two observations predates Hubble 2.2.0, so a rotation cannot be told apart from a re-signing. Re-run Hubble on both to resolve it.',
};

/** Triage order: the change that most warrants investigation sorts first. */
export const SIGNER_CHANGE_RANK: Record<SignerChangeKind, number> = {
  'signer-change': 0,
  undetermined: 1,
  rotation: 2,
  none: 3,
};

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((v) => setB.has(v));
}

function isStrictPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length === 0 || prefix.length >= full.length) return false;
  return prefix.every((v, i) => full[i] === v);
}

export function classifySignerChange(before: SigningFacts, after: SigningFacts): SignerChangeKind {
  // Legacy on either side: `activeSigners` is the raw list there, so a
  // difference is real but cannot be attributed.
  if (!before.structured || !after.structured) {
    return sameSet(before.allSigners, after.allSigners) ? 'none' : 'undetermined';
  }
  if (sameSet(before.activeSigners, after.activeSigners) && sameSet(before.lineage, after.lineage)) {
    return 'none';
  }
  if (isStrictPrefix(before.lineage, after.lineage)) return 'rotation';
  // A package with no prior lineage that now has one, ending in a key it was
  // already signed with, also rotated: the history simply became visible. This
  // is the ordinary shape of an API < 28 baseline compared against an API >= 28
  // target, where the earlier capture could not observe rotation at all. The
  // active signer is deliberately not required to differ — when it is the same
  // key on both sides, nothing was re-signed and only the record grew.
  if (
    before.lineage.length === 0 &&
    after.lineage.length > 1 &&
    before.activeSigners.length === 1 &&
    after.lineage.includes(before.activeSigners[0])
  ) {
    return 'rotation';
  }
  return 'signer-change';
}

/**
 * Whether the members of a shared UID present genuinely divergent keys.
 *
 * Android joins a shared UID by matching against the whole rotation lineage,
 * not one certificate, so members that rotated at different times legitimately
 * report different `certIds`. Comparing recorded lists therefore produces false
 * alarms; comparing *lineages* does not. Two members agree when either shares
 * any certificate with the other's full history.
 *
 * Returns `known: false` when any member is legacy, because then the lineages
 * are not available and the question cannot be answered.
 */
export function analyseSharedUidSigners(memberFacts: SigningFacts[]): {
  known: boolean;
  divergent: boolean;
} {
  if (memberFacts.length < 2) return { known: true, divergent: false };
  if (memberFacts.some((f) => !f.structured)) {
    const first = memberFacts[0].allSigners;
    const anyDifferent = memberFacts.some((f) => !sameSet(f.allSigners, first));
    return { known: false, divergent: anyDifferent };
  }
  // Android matches shared UIDs against the whole lineage on both sides, so
  // full-history overlap is the correct test. The anchor accumulates as we go,
  // which keeps a chain of partially-overlapping members (A~B, B~C) together.
  const anchor = new Set(memberFacts[0].allSigners);
  for (const f of memberFacts.slice(1)) {
    if (!f.allSigners.some((h) => anchor.has(h))) return { known: true, divergent: true };
    for (const h of f.allSigners) anchor.add(h);
  }
  return { known: true, divergent: false };
}
