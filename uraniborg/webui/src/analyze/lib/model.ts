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
 * Derived, indexed model built once per loaded observation.
 *
 * All views read from this structure, so every cross-reference (package ->
 * signer, signer -> packages, permission -> packages, component -> package)
 * is an O(1) map lookup rather than a scan over thousands of packages.
 */

import {
  countSensitivePermissions,
  permissionSeverity,
  SEVERITY_ORDER,
  SYSTEM_SHARED_UIDS,
  type PermissionSeverity,
} from './sensitivity';
import type {
  ComponentEntry,
  ProviderEntry,
  RawBinary,
  RawBuildInfo,
  RawCertificate,
  RawHardwareInfo,
  RawLibrary,
  RawPackage,
  SplitEntry,
} from './types';
import { decodeDeviceProps, type LoadDiagnostic, type RawObservation } from './parse';
import {
  analyseSharedUidSigners,
  derivePlatformIdentity,
  deriveSigningFacts,
  isPlatformSigned,
  type PlatformIdentity,
  type SigningFacts,
  type SigningMode,
} from './signing';

/**
 * Installation state, derived per docs/hubble_results.md
 * "Determining Package Installation Status".
 */
export type InstallState =
  | 'factory-apk'
  | 'factory-apex'
  | 'updated-system-app'
  | 'updated-mainline'
  | 'user-installed'
  | 'unknown';

export const INSTALL_STATE_LABEL: Record<InstallState, string> = {
  'factory-apk': 'Factory pre-installed (APK)',
  'factory-apex': 'Factory pre-installed (APEX)',
  'updated-system-app': 'Updated system app (APK)',
  'updated-mainline': 'Updated Mainline module (APEX)',
  'user-installed': 'User-installed',
  unknown: 'Unknown',
};

const SYSTEM_PARTITION_RE = /^\/(system|vendor|product|system_ext|odm|oem|apex)(\/|$)/;

/**
 * Classifies a package's provenance.
 *
 * APEX disambiguation keys on the *filename suffix*, not just the directory:
 * a pristine factory CAPEX is decompressed at boot into /data/apex/... with a
 * `.decompressed.apex` suffix, and keying on directory alone would wrongly
 * flag it as an update. See the WARNING block in docs/hubble_results.md.
 */
export function classifyInstallState(pkg: RawPackage): InstallState {
  const loc = pkg.installLocation ?? '';
  if (pkg.isApex) {
    if (SYSTEM_PARTITION_RE.test(loc)) return 'factory-apex';
    if (/\.decompressed\.apex$/.test(loc)) return 'factory-apex';
    if (/^\/data\/apex\/.*\.apex$/.test(loc)) return 'updated-mainline';
    return pkg.isPreinstalled ? 'factory-apex' : 'unknown';
  }
  if (pkg.isUpdatedSystemApp) return 'updated-system-app';
  if (pkg.isPreinstalled) return 'factory-apk';
  return 'user-installed';
}

export interface ExportedComponentRef {
  packageName: string;
  componentType: 'activity' | 'service' | 'receiver' | 'provider';
  name: string;
  isEnabled: boolean;
  isExported: boolean;
  /** Effective guard; providers report read/write separately. */
  permission: string | null;
  permissionRead?: string | null;
  permissionWrite?: string | null;
  authority?: string | null;
  grantUriPermissions?: boolean;
  /**
   * Number of `<path-permission>` entries. These override the provider-wide
   * read/write guards for specific URI paths, so they qualify both.
   */
  pathPermissionCount?: number;
}

/**
 * Android Binary Transparency status for one package.
 *
 * A package can have several APK splits and each is looked up in the log
 * independently, so the result is not a single boolean: a run can cover some
 * splits and not others, and a single missing split is the interesting case.
 * `unknown` counts splits the loaded proof run said nothing about — typically
 * because the APK changed between the Hubble run and the proof run, so the
 * digests no longer match.
 *
 * The states are defined by how much of the package the log vouches for:
 *  - `verified`:  every split is in the log.
 *  - `partial`:   **at least one** split is in the log, but not all of them —
 *                 the rest were either not found or have no result. Whether any
 *                 split was positively not found is `failed > 0`; see
 *                 {@link hasSplitNotInLog}.
 *  - `failed`:    no split is in the log, and at least one was looked up and
 *                 not found. Splits without a result do not rescue it: nothing
 *                 about the package is vouched for.
 *  - `unchecked`: no split has a result at all.
 */
export type InclusionProofState = 'verified' | 'partial' | 'failed' | 'unchecked';

export interface InclusionProofSummary {
  state: InclusionProofState;
  /** Splits found in the transparency log. */
  verified: number;
  /** Splits the log did not contain. */
  failed: number;
  /** Splits with no result in the loaded proof run. */
  unknown: number;
  total: number;
}

/** Sort order for triage: the alarming states first. */
export const PROOF_STATE_RANK: Record<InclusionProofState, number> = {
  failed: 0,
  partial: 1,
  unchecked: 2,
  verified: 3,
};

export function summariseInclusionProof(splits: SplitEntry[]): InclusionProofSummary {
  let verified = 0;
  let failed = 0;
  let unknown = 0;
  for (const s of splits) {
    if (s.inclusion_proof_verified === true) verified += 1;
    else if (s.inclusion_proof_verified === false) failed += 1;
    else unknown += 1;
  }
  const state: InclusionProofState =
    verified + failed === 0
      ? 'unchecked'
      : verified === 0
        ? 'failed'
        : failed === 0 && unknown === 0
          ? 'verified'
          : 'partial';
  return { state, verified, failed, unknown, total: splits.length };
}

/**
 * True when at least one split was looked up and positively not found.
 *
 * This is what separates the two kinds of `partial`: an unpublished split in
 * an otherwise published app is exactly the anomaly the log exists to expose,
 * whereas a split that merely has no result is an incomplete check.
 */
export function hasSplitNotInLog(proof: InclusionProofSummary): boolean {
  return proof.failed > 0;
}

export interface PackageView {
  raw: RawPackage;
  name: string;
  label: string;
  installState: InstallState;
  /**
   * Resolved signing configuration. Prefer this over `raw.certIds` everywhere:
   * it knows which certificates are current and which are retired ancestors.
   */
  signing: SigningFacts;
  /**
   * True when one of this package's **active** signers is in the platform's
   * full signing identity.
   *
   * Directional by design — see `isPlatformSigned` in `lib/signing.ts`. A
   * package that rotated away from the platform key is correctly excluded,
   * even though it still carries that key in its own lineage.
   */
  isPlatformSigned: boolean;
  /** True when it joins a privileged shared UID. */
  hasSystemSharedUid: boolean;
  grantedCount: number;
  notGrantedCount: number;
  declaredCount: number;
  /** Count of granted permissions that appear in the sensitivity table. */
  sensitiveGrantedCount: number;
  /** Most sensitive tier present among granted permissions. */
  topSeverity: PermissionSeverity | null;
  grantedBySeverity: Record<PermissionSeverity, string[]>;
  componentCount: number;
  exportedCount: number;
  /** Exported + enabled + no permission guard: the classic attack surface. */
  unguardedExportedCount: number;
  exportedComponents: ExportedComponentRef[];
  /** Splits, carrying any inclusion-proof result merged in from the proof run. */
  splits: SplitEntry[];
  inclusionProof: InclusionProofSummary;
  /**
   * The untouched record for this package from
   * `packages_with_inclusion_proof_signal.txt`, or null when the proof run did
   * not cover it. Kept so an analyst can read the original evidence instead of
   * trusting our summary of it.
   */
  inclusionProofRecord: unknown | null;
  searchBlob: string;
}

export interface CertificateView {
  /** SHA-256 of the DER certificate, as reported by Hubble. */
  hash: string;
  encodedCert: string | null;
  /** Every package that records this certificate, current or retired. */
  packageNames: string[];
  /**
   * Packages this key can ship an update to today. This is the number that
   * describes the key's actual reach.
   */
  activeFor: string[];
  /**
   * Packages that list this key only as a retired ancestor of their rotation
   * lineage. It cannot sign an update for them — kept visible because a key
   * that used to control a package is still worth knowing about.
   */
  retiredFor: string[];
  /**
   * True when this is the platform's **current** signing certificate. On a
   * legacy observation it degrades to the first certificate recorded for the
   * `android` package, which for a rotated key is the lineage root.
   */
  isPlatform: boolean;
  /**
   * True when the certificate is anywhere in the platform's signing identity,
   * including as a retired ancestor. A key that matches here still confers
   * platform trust on packages that carry it, because Android matches against
   * the whole lineage.
   */
  isPlatformLineage: boolean;
  /** True when Hubble referenced it but certificates.txt had no entry. */
  isOrphan: boolean;
}

export interface SharedUidGroup {
  sharedUserId: string;
  packageNames: string[];
  isSystemUid: boolean;
  /** Every certificate any member records, current or retired. */
  certHashes: string[];
  /** Union of the members' current signers. */
  activeCertHashes: string[];
  /**
   * True when no certificate links the members' signing histories.
   *
   * Not simply "the recorded lists differ": Android evaluates shared-UID key
   * matching against the whole rotation lineage, so members that rotated at
   * different times legitimately record different certificates. Only a genuine
   * absence of overlap is worth flagging.
   */
  signersDiverge: boolean;
  /**
   * False when at least one member is from a legacy observation, in which case
   * {@link signersDiverge} is a raw set comparison and may be a false alarm.
   */
  divergenceKnown: boolean;
}

export interface PermissionUsage {
  name: string;
  severity: PermissionSeverity | null;
  grantedTo: string[];
  requestedNotGranted: string[];
  declaredBy: string[];
  /** Protection levels observed among declarers. */
  protectionLevels: string[];
}

export interface DeviceSummary {
  oem: string;
  brand: string;
  model: string;
  device: string;
  fingerprint: string;
  apiLevel: number | null;
  securityPatchLevel: string;
  buildId: string;
}

export interface Observation {
  id: string;
  /** Human label shown in the dataset switcher. */
  title: string;
  loadedAt: number;
  /**
   * The parsed artifacts this view was derived from.
   *
   * Retained so an artifact that arrives later - in practice the
   * inclusion-proof results, which come from a separate and much slower run -
   * can be folded in without re-reading and re-parsing the whole directory.
   * Costs almost nothing: every `RawPackage` here is the same object already
   * referenced by `PackageView.raw`.
   */
  raw: RawObservation;
  hubbleVersion: string | null;
  build: RawBuildInfo | null;
  hardware: RawHardwareInfo | null;
  summary: DeviceSummary;
  packages: PackageView[];
  packagesByName: Map<string, PackageView>;
  certificates: CertificateView[];
  certsByHash: Map<string, CertificateView>;
  /**
   * The platform's **current** signing certificate, used for the PLATFORM
   * badge. Prefer {@link platform} when you need the full trust anchor.
   */
  platformCertHash: string | null;
  /** Full platform signing identity, including any retired ancestors. */
  platform: PlatformIdentity;
  /** Device-wide tally of resolved signing modes. */
  signingModeCounts: Record<SigningMode, number>;
  /**
   * False when this observation predates Hubble 2.2.0, so every signing mode
   * is `unknown` for want of `signingInfo` rather than because of anything on
   * the device.
   */
  hasStructuredSigning: boolean;
  sharedUidGroups: SharedUidGroup[];
  permissions: PermissionUsage[];
  permissionsByName: Map<string, PermissionUsage>;
  bins: RawBinary[];
  libs: RawLibrary[];
  deviceProps: Array<[string, string]>;
  diagnostics: LoadDiagnostic[];
  fileNames: string[];
  hasInclusionProofData: boolean;
  /** Artifact the transparency verdicts were read from, shown for provenance. */
  inclusionProofFileName: string | null;
  /** Device-wide tally of package inclusion-proof states. */
  inclusionProofCounts: Record<InclusionProofState, number>;
  /**
   * Of the `partial` packages, how many have a split that was looked up and
   * not found, as opposed to one that merely has no result. These are the
   * partially published apps the log exists to expose; the remainder are
   * incomplete checks.
   */
  partialWithSplitNotInLog: number;
}

function emptyBySeverity(): Record<PermissionSeverity, string[]> {
  return { ASTRONOMICAL: [], CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [] };
}

function componentRefs(pkg: RawPackage): ExportedComponentRef[] {
  const out: ExportedComponentRef[] = [];
  const push = (
    type: 'activity' | 'service' | 'receiver',
    list: ComponentEntry[] | undefined,
  ) => {
    for (const c of list ?? []) {
      out.push({
        packageName: pkg.name,
        componentType: type,
        name: c.name,
        isEnabled: c.isEnabled,
        isExported: c.isExported,
        permission: c.permission ?? null,
      });
    }
  };
  push('activity', pkg.activities);
  push('service', pkg.services);
  push('receiver', pkg.receivers);
  for (const p of (pkg.providers ?? []) as ProviderEntry[]) {
    out.push({
      packageName: pkg.name,
      componentType: 'provider',
      name: p.name,
      isEnabled: p.isEnabled,
      isExported: p.isExported,
      // `permission` is the coarse, list-level guard; the read and write gates
      // below are the ones Android actually enforces, and they can differ.
      permission: p.permissionRead ?? p.permissionWrite ?? null,
      permissionRead: p.permissionRead ?? null,
      permissionWrite: p.permissionWrite ?? null,
      authority: p.authority ?? null,
      grantUriPermissions: p.grantUriPermissions,
      pathPermissionCount: p.pathPermissions?.length ?? 0,
    });
  }
  return out;
}

/**
 * Whether an exported component can be reached by another app with no
 * permission at all.
 *
 * For a provider both gates must be tested, because read and write are
 * enforced independently and an app that can only write is still an app that
 * can write. Testing just these two is sufficient rather than a shortcut: a
 * provider-wide `android:permission` is folded into both by the manifest
 * parser before Hubble ever sees it, so a null pair really does mean nothing
 * is enforced. See lib/providers.ts.
 */
export function isUnguarded(c: ExportedComponentRef): boolean {
  if (!c.isExported || !c.isEnabled) return false;
  if (c.componentType === 'provider') {
    return !c.permissionRead || !c.permissionWrite;
  }
  return !c.permission;
}

function deriveSummary(
  hw: RawHardwareInfo | null,
  build: RawBuildInfo | null,
): DeviceSummary {
  const fp = build?.fingerprint ?? '';
  // Fingerprint form: brand/product/device:release/ID/incremental:type/tags
  const buildId = fp.split('/')[4]?.split(':')[0] ?? '';
  return {
    oem: hw?.oem ?? 'unknown',
    brand: hw?.brand ?? 'unknown',
    model: hw?.modelName ?? 'unknown',
    device: hw?.deviceName ?? 'unknown',
    fingerprint: fp,
    apiLevel: build?.apiLevel ?? null,
    securityPatchLevel: build?.securityPatchLevel ?? 'unknown',
    buildId,
  };
}

let observationCounter = 0;

/** Builds the fully indexed observation from raw parsed artifacts. */
export function buildObservation(raw: RawObservation, title?: string): Observation {
  const id = `obs-${++observationCounter}-${Date.now().toString(36)}`;

  // --- platform signing identity ---------------------------------------------
  // Two different things, and conflating them was the old bug:
  //  - `primary` is the platform's *current* signer, what gets badged PLATFORM.
  //  - `anchor` is every key `android` has ever been signed by, which is what a
  //    candidate package must be tested against so a platform key rotation does
  //    not orphan system packages still carrying the retired certificate.
  // On a legacy observation both degrade to the recorded `certIds`, reproducing
  // the previous behaviour rather than inventing a lineage.
  const platform = derivePlatformIdentity(raw.packages);
  const platformCertHash = platform.primary;

  // --- certificate index ----------------------------------------------------
  const certsByHash = new Map<string, CertificateView>();
  for (const c of raw.certs as RawCertificate[]) {
    certsByHash.set(c.hash, {
      hash: c.hash,
      encodedCert: c.encodedCert,
      packageNames: [],
      activeFor: [],
      retiredFor: [],
      isPlatform: c.hash === platformCertHash,
      isPlatformLineage: platform.anchor.has(c.hash),
      isOrphan: false,
    });
  }

  // --- packages -------------------------------------------------------------
  const packages: PackageView[] = [];
  const packagesByName = new Map<string, PackageView>();
  const permissionsByName = new Map<string, PermissionUsage>();
  const sharedUidMap = new Map<string, SharedUidGroup>();
  /** Member signing facts, kept aside so divergence is judged per group. */
  const sharedUidFacts = new Map<string, SigningFacts[]>();

  const getPermission = (name: string): PermissionUsage => {
    let usage = permissionsByName.get(name);
    if (!usage) {
      usage = {
        name,
        severity: permissionSeverity(name),
        grantedTo: [],
        requestedNotGranted: [],
        declaredBy: [],
        protectionLevels: [],
      };
      permissionsByName.set(name, usage);
    }
    return usage;
  };

  for (const pkg of raw.packages) {
    const grantedBySeverity = emptyBySeverity();
    for (const p of pkg.permissionsGranted) {
      const sev = permissionSeverity(p);
      if (sev) grantedBySeverity[sev].push(p);
      getPermission(p).grantedTo.push(pkg.name);
    }
    for (const p of pkg.permissionsNotGranted) getPermission(p).requestedNotGranted.push(pkg.name);
    for (const d of pkg.permissionsDeclared) {
      const usage = getPermission(d.name);
      usage.declaredBy.push(pkg.name);
      if (d.protLevel && !usage.protectionLevels.includes(d.protLevel)) {
        usage.protectionLevels.push(d.protLevel);
      }
    }

    const topSeverity = SEVERITY_ORDER.find((s) => grantedBySeverity[s].length > 0) ?? null;
    const exported = componentRefs(pkg);
    const declaredSplits: SplitEntry[] =
      pkg.splits && pkg.splits.length > 0
        ? pkg.splits
        : pkg.hash
          ? [{ name: 'base', location: pkg.installLocation ?? undefined, hash: pkg.hash }]
          : [];

    // inclusion_proof_check.py writes its verdicts to a *separate* artifact
    // keyed by package name and split digest. Merge them back onto the splits
    // recorded in packages.txt, otherwise the per-split result is invisible
    // whenever both files are loaded (the normal case).
    const proofMap = raw.inclusionProof.get(pkg.name);
    const splits: SplitEntry[] = proofMap
      ? declaredSplits.map((s) => {
          const verdict = s.hash ? proofMap.get(s.hash) : undefined;
          return verdict === undefined ? s : { ...s, inclusion_proof_verified: verdict };
        })
      : declaredSplits;
    const inclusionProof = summariseInclusionProof(splits);

    const label = pkg.label ?? pkg.name;
    const signing = deriveSigningFacts(pkg);
    const view: PackageView = {
      raw: pkg,
      name: pkg.name,
      label,
      installState: classifyInstallState(pkg),
      signing,
      // Directional: this package's *active* signers against the platform's
      // *full* identity. Never the other way round, and never set against set.
      isPlatformSigned: isPlatformSigned(signing, platform),
      hasSystemSharedUid: !!pkg.sharedUserId && SYSTEM_SHARED_UIDS.has(pkg.sharedUserId),
      grantedCount: pkg.permissionsGranted.length,
      notGrantedCount: pkg.permissionsNotGranted.length,
      declaredCount: pkg.permissionsDeclared.length,
      sensitiveGrantedCount: countSensitivePermissions(pkg.permissionsGranted),
      topSeverity,
      grantedBySeverity,
      componentCount: exported.length,
      exportedCount: exported.filter((c) => c.isExported).length,
      unguardedExportedCount: exported.filter(isUnguarded).length,
      exportedComponents: exported,
      splits,
      inclusionProof,
      inclusionProofRecord: raw.inclusionProofRecords.get(pkg.name) ?? null,
      searchBlob: `${pkg.name} ${label} ${pkg.installLocation ?? ''} ${pkg.sharedUserId ?? ''} ${pkg.versionName ?? ''}`.toLowerCase(),
    };
    packages.push(view);
    packagesByName.set(pkg.name, view);

    // --- signer back-references ---------------------------------------------
    // Indexed over `allSigners`, not `certIds`, so a certificate that appears
    // only in `apkContentsSigners` is still reachable. Each reference is
    // attributed: a key that merely sits in a retired lineage position has no
    // ability to ship an update, and the certificate pages must not count it
    // as if it did.
    const activeSet = new Set(signing.activeSigners);
    for (const certId of signing.allSigners) {
      let cert = certsByHash.get(certId);
      if (!cert) {
        cert = {
          hash: certId,
          encodedCert: null,
          packageNames: [],
          activeFor: [],
          retiredFor: [],
          isPlatform: certId === platformCertHash,
          isPlatformLineage: platform.anchor.has(certId),
          isOrphan: true,
        };
        certsByHash.set(certId, cert);
      }
      cert.packageNames.push(pkg.name);
      if (activeSet.has(certId)) cert.activeFor.push(pkg.name);
      else if (signing.pastSigners.includes(certId)) cert.retiredFor.push(pkg.name);
    }

    if (pkg.sharedUserId) {
      let group = sharedUidMap.get(pkg.sharedUserId);
      if (!group) {
        group = {
          sharedUserId: pkg.sharedUserId,
          packageNames: [],
          isSystemUid: SYSTEM_SHARED_UIDS.has(pkg.sharedUserId),
          certHashes: [],
          activeCertHashes: [],
          signersDiverge: false,
          divergenceKnown: true,
        };
        sharedUidMap.set(pkg.sharedUserId, group);
        sharedUidFacts.set(pkg.sharedUserId, []);
      }
      group.packageNames.push(pkg.name);
      for (const c of signing.allSigners) {
        if (!group.certHashes.includes(c)) group.certHashes.push(c);
      }
      for (const c of signing.activeSigners) {
        if (!group.activeCertHashes.includes(c)) group.activeCertHashes.push(c);
      }
      sharedUidFacts.get(pkg.sharedUserId)!.push(signing);
    }
  }

  // Resolved once per group: a shared UID is only worth flagging when nothing
  // links the members' signing histories, since Android joins on the whole
  // lineage and members that rotated at different times legitimately differ.
  for (const [uid, facts] of sharedUidFacts) {
    const group = sharedUidMap.get(uid);
    if (!group) continue;
    const verdict = analyseSharedUidSigners(facts);
    group.signersDiverge = verdict.divergent;
    group.divergenceKnown = verdict.known;
  }

  // Ranked by *live* reach: a key that is merely a retired ancestor of many
  // packages controls none of them today and should not outrank one that does.
  const certificates = [...certsByHash.values()].sort(
    (a, b) =>
      Number(b.isPlatform) - Number(a.isPlatform) ||
      b.activeFor.length - a.activeFor.length ||
      b.packageNames.length - a.packageNames.length ||
      a.hash.localeCompare(b.hash),
  );

  const permissions = [...permissionsByName.values()].sort(
    (a, b) => b.grantedTo.length - a.grantedTo.length || a.name.localeCompare(b.name),
  );

  const sharedUidGroups = [...sharedUidMap.values()].sort(
    (a, b) =>
      Number(b.isSystemUid) - Number(a.isSystemUid) ||
      b.packageNames.length - a.packageNames.length ||
      a.sharedUserId.localeCompare(b.sharedUserId),
  );

  const summary = deriveSummary(raw.hardware, raw.build);
  const autoTitle =
    title ||
    [summary.oem, summary.model].filter((s) => s && s !== 'unknown').join(' ') ||
    summary.fingerprint ||
    'Observation';

  return {
    id,
    title: autoTitle,
    loadedAt: Date.now(),
    raw,
    hubbleVersion: raw.hubbleVersion,
    build: raw.build,
    hardware: raw.hardware,
    summary,
    // Deliberately left in the order Hubble recorded them (PackageManager's
    // enumeration order). Views sort for display; clearing a table's sort
    // returns to this order, which is what its tooltip promises.
    packages,
    packagesByName,
    certificates,
    certsByHash,
    platformCertHash,
    platform,
    signingModeCounts: packages.reduce(
      (acc, p) => {
        acc[p.signing.mode] += 1;
        return acc;
      },
      {
        'single-signer': 0,
        'key-rotation-lineage': 0,
        'multiple-signers': 0,
        unknown: 0,
      } as Record<SigningMode, number>,
    ),
    hasStructuredSigning: packages.some((p) => p.signing.structured),
    sharedUidGroups,
    permissions,
    permissionsByName,
    bins: raw.bins,
    libs: raw.libs,
    deviceProps: decodeDeviceProps(raw.deviceProps),
    diagnostics: raw.diagnostics,
    fileNames: raw.fileNames,
    hasInclusionProofData: raw.inclusionProof.size > 0,
    inclusionProofFileName: raw.inclusionProofFileName,
    inclusionProofCounts: packages.reduce(
      (acc, p) => {
        acc[p.inclusionProof.state] += 1;
        return acc;
      },
      { verified: 0, partial: 0, failed: 0, unchecked: 0 } as Record<InclusionProofState, number>,
    ),
    partialWithSplitNotInLog: packages.filter(
      (p) => p.inclusionProof.state === 'partial' && hasSplitNotInLog(p.inclusionProof),
    ).length,
  };
}
