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
 * Type definitions mirroring the JSON emitted by Hubble (Uraniborg's
 * observation APK) and by the Python post-processing scripts.
 *
 * Reference: uraniborg/docs/hubble_results.md and
 * uraniborg/AndroidStudioProject/Hubble/app/src/main/java/com/uraniborg/hubble/*.java
 *
 * Every Hubble artifact shares the same envelope:
 *   { "version": "2.1.0", "total<Thing>": N, "<things>": [ ... ] }
 */

/** One entry of `permissionsDeclared`. */
export interface DeclaredPermission {
  name: string;
  /** e.g. "signature|privileged", "dangerous", "normal". */
  protLevel: string;
}

/** Shared shape for activities / services / receivers (ComponentInfo). */
export interface ComponentEntry {
  name: string;
  isEnabled: boolean;
  isExported: boolean;
  labels: string[];
  desc: string | null;
  /** Permission guarding the component; null means unguarded. */
  permission: string | null;
}

export interface PathPermissionEntry {
  path: string | null;
  type: string | null;
  permissionRead: string | null;
  permissionWrite: string | null;
}

export interface UriPermissionPattern {
  path: string | null;
  type: string | null;
}

/** ContentProvider entry; a superset of ComponentEntry. */
export interface ProviderEntry extends Omit<ComponentEntry, 'permission'> {
  authority: string | null;
  grantUriPermissions: boolean;
  permissionRead: string | null;
  permissionWrite: string | null;
  pathPermissions: PathPermissionEntry[];
  uriPermissionPatterns: UriPermissionPattern[];
  forceUriPermissions: boolean | null;
}

export interface SplitEntry {
  name?: string;
  location?: string;
  hash?: string;
  /** Injected by scripts/python/inclusion_proof_check.py. */
  inclusion_proof_verified?: boolean;
}

/**
 * Verdict of `PackageManager.checkSignatures(pkg, "android")`, recorded
 * verbatim by Hubble >= 2.2.0.
 *
 * Descriptive only. This is what `PackageManager` would tell an app, which
 * matters when reasoning about legacy callers of that API — it is deliberately
 * NOT how this UI decides platform signing. `checkSignatures()` compares
 * current signer sets for exact equality and then retries against the *oldest*
 * ancestor of each lineage, never consulting `SigningDetails.checkCapability()`,
 * so it reports MATCH for a package that rotated *away* from the platform key
 * and NO_MATCH for one co-signed by the platform key plus another key. See
 * `isPlatformSigned` in `lib/signing.ts`.
 */
export type PlatformSignatureMatch =
  | 'MATCH'
  | 'NO_MATCH'
  | 'NEITHER_SIGNED'
  | 'FIRST_NOT_SIGNED'
  | 'SECOND_NOT_SIGNED'
  | 'UNKNOWN_PACKAGE'
  | 'UNKNOWN';

/**
 * Structured signing metadata, introduced in Hubble schema 2.2.0.
 *
 * This is what makes `certIds` decidable: without it a multi-entry list is
 * either a v3 rotation lineage or a set of concurrent co-signers, with no way
 * to tell which. Absent on observations collected with 2.1.0 and earlier.
 *
 * Emitted by MainActivity.getAllCertificates(); see
 * docs/hubble_results.md, "Determining Package Signing Certificate Lineage
 * vs. Co-Signing".
 */
export interface RawSigningInfo {
  /** True when the APK is co-signed by two or more concurrent signers. */
  hasMultipleSigners: boolean;
  /**
   * True when the package has retired ancestor certificates in its v3 lineage.
   *
   * Tri-state on purpose: Hubble emits `null` on API < 28, where
   * `PackageManager` exposes no v3 lineage API at all. There, "not rotated" is
   * *unobservable*, not false, and must not be read as `false`.
   */
  hasPastSigningCertificates: boolean | null;
  /** Digests of the currently active signer(s). Order is not meaningful. */
  apkContentsSigners: string[];
  /**
   * The v3 rotation lineage ordered **oldest ancestor first, current signer
   * last**. Empty for co-signed APKs (v3 rotation and multi-signing are
   * mutually exclusive) and on API < 28.
   */
  signingCertificateLineage: string[];
  platformSignatureMatch: PlatformSignatureMatch | null;
}

/** A single entry of `packages.txt` / `preinstalled_packages.txt`. */
export interface RawPackage {
  hash: string | null;
  name: string;
  label: string | null;
  description: string | null;
  versionCode: number;
  versionName: string | null;
  /**
   * SHA-256 digests of the signing certificates, **as Hubble chose to record
   * them**. Which API produced the list depends on the device and the package
   * (MainActivity.getAllCertificates):
   *
   *  - co-signed APK        -> `signingInfo.getApkContentsSigners()`
   *  - everything else      -> `signingInfo.getSigningCertificateHistory()`,
   *                            i.e. the whole lineage, oldest first
   *  - API < 28             -> `pkgInfo.signatures` (GET_SIGNATURES)
   *
   * Read on its own this field is therefore ambiguous whenever it holds more
   * than one entry. **Do not consume it directly.** Use
   * {@link ../signing!deriveSigningFacts}, which reads {@link signingInfo} to
   * resolve the list into active signers, a rotation lineage and retired
   * ancestors, and which degrades to an explicit `unknown` (rather than a
   * guess) on legacy observations that have no `signingInfo`.
   *
   * Kept on the model because it is what the artifact literally contains, and
   * the Raw JSON tab and CSV exports must reproduce it faithfully.
   */
  certIds: string[];
  /**
   * Structured signing metadata. `null` for observations collected with
   * Hubble < 2.2.0, which is why every consumer has to handle an `unknown`
   * signing mode rather than assuming a single signer.
   */
  signingInfo: RawSigningInfo | null;
  isEnabled: boolean;
  isTestOnly: boolean;
  isFactoryTest: boolean;
  isSuspended: boolean;
  isApex: boolean;
  isPreinstalled: boolean;
  isUpdatedSystemApp: boolean;
  isHidden: boolean;
  hasCode: boolean;
  usesCleartextTraffic: boolean;
  installLocation: string | null;
  permissionsDeclared: DeclaredPermission[];
  permissionsGranted: string[];
  permissionsNotGranted: string[];
  permissionsSpecial?: string[];
  activities: ComponentEntry[];
  services: ComponentEntry[];
  receivers: ComponentEntry[];
  providers: ProviderEntry[];
  firstInstallTime: number;
  sharedUserId: string | null;
  sharedUserLabel: number;
  splits?: SplitEntry[];
  /** Older docs call this splitNames. */
  splitNames?: string[];
  kernelGids: number[];
  fileSizeInBytes: number;
}

export interface RawCertificate {
  hash: string;
  /** Base64 (NO_WRAP) DER-encoded X.509 certificate. */
  encodedCert: string;
}

export interface RawBuildInfo {
  apiLevel: number;
  bootloaderVersion: string | null;
  fingerprint: string | null;
  kernelVersion: string | null;
  locale: string | null;
  radioVersion: string | null;
  securityPatchLevel: string | null;
}

export interface RawHardwareInfo {
  boardName: string | null;
  brand: string | null;
  deviceName: string | null;
  hardwareName: string | null;
  hash: string | null;
  modelName: string | null;
  oem: string | null;
  productName: string | null;
}

export interface RawBinary {
  hash: string | null;
  installPath: string | null;
  name: string;
  fileSizeInBytes?: number;
}

export interface RawLibrary extends RawBinary {
  bits: number;
}

export interface RawDeviceProps {
  /** Base64 of `adb shell getprop` output. */
  encodedDevProps: string;
}

/** Recognised Hubble artifact kinds, keyed by their envelope array field. */
export type ArtifactKind =
  | 'packages'
  | 'preinstalledPackages'
  | 'certs'
  | 'buildInfo'
  | 'hwInfo'
  | 'bins'
  | 'libs'
  | 'b64EncodedDeviceProps'
  | 'inclusionProof';

export interface ParsedArtifact {
  kind: ArtifactKind;
  fileName: string;
  version: string | null;
  /** Declared `total*` value from the envelope, when present. */
  declaredTotal: number | null;
  /** Actual number of parsed items (mismatch => truncated transfer). */
  actualTotal: number;
  items: unknown[];
}
