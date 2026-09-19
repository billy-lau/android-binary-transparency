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
 * Observation comparison.
 *
 * Two use cases:
 *  - Build A vs build B on the same device (what changed in this OTA?).
 *  - Target build vs an API-level-matched GSI/AOSP baseline, which isolates
 *    what the OEM added on top of stock Android.
 *
 * Everything here is a set difference over observed facts. We intentionally do
 * not roll the result up into a risk score; see the scope note in sensitivity.ts.
 */

import type { Observation, PackageView } from './model';
import { classifySignerChange, type SignerChangeKind } from './signing';

export type ChangeKind = 'added' | 'removed' | 'changed' | 'unchanged';

export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

export interface PackageDiff {
  name: string;
  kind: ChangeKind;
  before: PackageView | null;
  after: PackageView | null;
  changes: FieldChange[];
  /** Permissions granted in `after` but not in `before`. */
  permissionsGained: string[];
  permissionsLost: string[];
  /** Signer set changed — the highest-signal event in a build comparison. */
  signerChanged: boolean;
  /**
   * What kind of signer change it was. `rotation` is the benign case and is
   * separated out so it cannot drown the re-signings, which are the ones worth
   * chasing.
   */
  signerChangeKind: SignerChangeKind;
}

export interface DiffResult {
  baseline: Observation;
  target: Observation;
  packages: PackageDiff[];
  added: PackageDiff[];
  removed: PackageDiff[];
  changed: PackageDiff[];
  /** Every package whose signers moved at all, of any kind. */
  signerChanges: PackageDiff[];
  /** Lineage extended: expected, and separated so it does not raise alarm. */
  keyRotations: PackageDiff[];
  /** Active signers genuinely changed, and not by rotation. */
  reSignings: PackageDiff[];
  /** Moved, but at least one side is pre-2.2.0 so it cannot be attributed. */
  undeterminedSignerChanges: PackageDiff[];
  newSigners: string[];
  retiredSigners: string[];
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '—';
  return String(v);
}

function comparePackage(before: PackageView, after: PackageView): FieldChange[] {
  const changes: FieldChange[] = [];
  const cmp = (field: string, a: unknown, b: unknown) => {
    if (fmt(a) !== fmt(b)) changes.push({ field, before: fmt(a), after: fmt(b) });
  };
  cmp('versionCode', before.raw.versionCode, after.raw.versionCode);
  cmp('versionName', before.raw.versionName, after.raw.versionName);
  cmp('hash', before.raw.hash, after.raw.hash);
  cmp('installLocation', before.raw.installLocation, after.raw.installLocation);
  cmp('installState', before.installState, after.installState);
  cmp('sharedUserId', before.raw.sharedUserId, after.raw.sharedUserId);
  cmp('isEnabled', before.raw.isEnabled, after.raw.isEnabled);
  cmp('hasCode', before.raw.hasCode, after.raw.hasCode);
  cmp('usesCleartextTraffic', before.raw.usesCleartextTraffic, after.raw.usesCleartextTraffic);
  cmp('fileSizeInBytes', before.raw.fileSizeInBytes, after.raw.fileSizeInBytes);
  // Recorded verbatim, because the Raw JSON tab shows it and an analyst will
  // want the artifact-level diff to line up with what is on disk.
  cmp('certIds', [...before.raw.certIds].sort().join(','), [...after.raw.certIds].sort().join(','));
  // The meaningful comparison, but only when both sides can answer it. If one
  // observation predates 2.2.0 its lineage is empty and its mode is `unknown`
  // for want of `signingInfo`, so comparing them would report a change on every
  // single package when nothing on the device moved — the capture schema did.
  // The `certIds` line above still catches a real difference, and
  // `signerChangeKind` reports it as `undetermined`, which is the honest answer.
  if (before.signing.structured && after.signing.structured) {
    // Active signers are order-insensitive (a co-signer set has no order); the
    // lineage is compared positionally, because its order *is* the rotation
    // history and an appended key is a rotation whereas a replaced one is not.
    cmp(
      'activeSigners',
      [...before.signing.activeSigners].sort().join(','),
      [...after.signing.activeSigners].sort().join(','),
    );
    cmp('signingLineage', before.signing.lineage.join(' → '), after.signing.lineage.join(' → '));
    cmp('signingMode', before.signing.mode, after.signing.mode);
  }
  cmp('grantedPermissionCount', before.grantedCount, after.grantedCount);
  cmp('unguardedExportedComponents', before.unguardedExportedCount, after.unguardedExportedCount);
  // A package that used to be in the transparency log and no longer is (or the
  // reverse) is worth surfacing even when the APK digest is unchanged, because
  // it can also mean the log coverage itself regressed. Skipped unless both
  // runs were checked, otherwise comparing against a baseline that has no
  // proof artifact would mark every single package as changed.
  if (before.inclusionProof.state !== 'unchecked' && after.inclusionProof.state !== 'unchecked') {
    cmp('inclusionProof', before.inclusionProof.state, after.inclusionProof.state);
  }
  return changes;
}

export function diffObservations(baseline: Observation, target: Observation): DiffResult {
  const names = new Set<string>([
    ...baseline.packagesByName.keys(),
    ...target.packagesByName.keys(),
  ]);

  const packages: PackageDiff[] = [];
  for (const name of [...names].sort()) {
    const before = baseline.packagesByName.get(name) ?? null;
    const after = target.packagesByName.get(name) ?? null;

    if (!before && after) {
      packages.push({
        name,
        kind: 'added',
        before: null,
        after,
        changes: [],
        permissionsGained: [...after.raw.permissionsGranted],
        permissionsLost: [],
        signerChanged: false,
        signerChangeKind: 'none',
      });
      continue;
    }
    if (before && !after) {
      packages.push({
        name,
        kind: 'removed',
        before,
        after: null,
        changes: [],
        permissionsGained: [],
        permissionsLost: [...before.raw.permissionsGranted],
        signerChanged: false,
        signerChangeKind: 'none',
      });
      continue;
    }
    if (!before || !after) continue;

    const changes = comparePackage(before, after);
    const beforeGranted = new Set(before.raw.permissionsGranted);
    const afterGranted = new Set(after.raw.permissionsGranted);
    const permissionsGained = [...afterGranted].filter((p) => !beforeGranted.has(p)).sort();
    const permissionsLost = [...beforeGranted].filter((p) => !afterGranted.has(p)).sort();
    const signerChangeKind = classifySignerChange(before.signing, after.signing);

    packages.push({
      name,
      kind: changes.length > 0 ? 'changed' : 'unchanged',
      before,
      after,
      changes,
      permissionsGained,
      permissionsLost,
      signerChanged: signerChangeKind !== 'none',
      signerChangeKind,
    });
  }

  // Device-wide signer inventory, split by whether a key can still sign.
  // `newSigners` answers "which keys can now ship code that could not before?",
  // so it is built from active signers rather than from every recorded
  // certificate — a key that only appears as a retired lineage entry in the
  // target is not a newly trusted key, it is newly *visible* history.
  const activeHashes = (obs: Observation): Set<string> => {
    const out = new Set<string>();
    for (const p of obs.packages) for (const h of p.signing.activeSigners) out.add(h);
    return out;
  };
  const baselineSigners = activeHashes(baseline);
  const targetSigners = activeHashes(target);

  return {
    baseline,
    target,
    packages,
    added: packages.filter((p) => p.kind === 'added'),
    removed: packages.filter((p) => p.kind === 'removed'),
    changed: packages.filter((p) => p.kind === 'changed'),
    signerChanges: packages.filter((p) => p.signerChanged),
    keyRotations: packages.filter((p) => p.signerChangeKind === 'rotation'),
    reSignings: packages.filter((p) => p.signerChangeKind === 'signer-change'),
    undeterminedSignerChanges: packages.filter((p) => p.signerChangeKind === 'undetermined'),
    newSigners: [...targetSigners].filter((h) => !baselineSigners.has(h)),
    retiredSigners: [...baselineSigners].filter((h) => !targetSigners.has(h)),
  };
}

/** One "what does the target add over the baseline?" category. */
export interface DeltaCategory {
  /** Preloaded packages in the target that fall into this category. */
  targetCount: number;
  /**
   * Of those, the ones whose name matches no pre-installed package in the
   * baseline. Name only: signer and version are not considered.
   */
  novelCount: number;
  /** Package names behind `novelCount`, for drill-down. */
  novelPackages: string[];
}

export interface BaselineDelta {
  platformSigned: DeltaCategory;
  cleartextTraffic: DeltaCategory;
  sensitivePermissions: DeltaCategory;
  /** Every pre-installed package in the target whose name matches no baseline pre-installed package. */
  novelPreloads: string[];
}

/**
 * Summarises the pre-installed surface the target adds on top of the baseline.
 *
 * This is the useful half of a GSI/AOSP comparison, expressed as observed
 * counts only: no weighting, no composite score. `novelCount / targetCount`
 * can be read as "how much of this category is the OEM's own doing", but the
 * UI shows both numbers so the reader does the interpreting.
 *
 * Only pre-installed packages participate; user-installed apps are not part of
 * the shipped image and say nothing about the OEM.
 */
export function computeBaselineDelta(baseline: Observation, target: Observation): BaselineDelta {
  const preloaded = (o: Observation) => o.packages.filter((p) => p.raw.isPreinstalled);
  const basePreloads = preloaded(baseline);
  const targetPreloads = preloaded(target);
  const baseNames = new Set(basePreloads.map((p) => p.name));

  const category = (pred: (p: PackageView) => boolean): DeltaCategory => {
    const inTarget = targetPreloads.filter(pred);
    // Tested against every baseline preload, not just the ones matching `pred`:
    // "novel" means no baseline *pre-installed* package has that name. A package
    // shipped by both builds that merely acquired the attribute is a change to
    // an existing package, not a package the target added, and counting it here
    // would overstate the surface attributable to the OEM. Baseline user
    // installs are deliberately ignored: they are not part of the shipped image.
    const novel = inTarget.filter((p) => !baseNames.has(p.name)).map((p) => p.name);
    return { targetCount: inTarget.length, novelCount: novel.length, novelPackages: novel };
  };

  return {
    platformSigned: category((p) => p.isPlatformSigned),
    cleartextTraffic: category((p) => p.raw.usesCleartextTraffic),
    sensitivePermissions: category((p) => p.sensitiveGrantedCount > 0),
    novelPreloads: targetPreloads.filter((p) => !baseNames.has(p.name)).map((p) => p.name),
  };
}
