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
 * Parsing and normalisation of Hubble observation artifacts.
 *
 * Design notes
 * ------------
 * - Everything runs in the browser; files are read with the File API and never
 *   leave the machine.
 * - Artifact kind is detected from the *envelope shape* rather than the
 *   filename, because users routinely rename `*.txt` to `*.json` or drop
 *   individual files in.
 * - Parsing is defensive: Hubble writes JSON by hand-concatenating strings, so
 *   a truncated ADB pull produces syntactically invalid JSON. We surface that
 *   as a load diagnostic rather than crashing.
 */

import type {
  ArtifactKind,
  ParsedArtifact,
  PlatformSignatureMatch,
  RawBinary,
  RawBuildInfo,
  RawCertificate,
  RawDeviceProps,
  RawHardwareInfo,
  RawLibrary,
  RawPackage,
  RawSigningInfo,
} from './types';
import { SIGNING_INFO_MIN_VERSION } from './signing';

/** Envelope array field -> artifact kind. Order matters for ambiguity. */
const ENVELOPE_KEYS: Array<{ key: string; kind: ArtifactKind; totalKey: string }> = [
  { key: 'packages', kind: 'packages', totalKey: 'totalPackages' },
  { key: 'preinstalledPackages', kind: 'preinstalledPackages', totalKey: 'totalPreinstalledPackages' },
  { key: 'certs', kind: 'certs', totalKey: 'totalCerts' },
  { key: 'buildInfo', kind: 'buildInfo', totalKey: 'totalBuild' },
  { key: 'hwInfo', kind: 'hwInfo', totalKey: 'totalHardware' },
  { key: 'bins', kind: 'bins', totalKey: 'totalBins' },
  { key: 'libs', kind: 'libs', totalKey: 'totalLibs' },
  { key: 'b64EncodedDeviceProps', kind: 'b64EncodedDeviceProps', totalKey: 'totalDeviceProps' },
];

export interface LoadDiagnostic {
  fileName: string;
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface RawObservation {
  packages: RawPackage[];
  preinstalledPackages: RawPackage[];
  certs: RawCertificate[];
  build: RawBuildInfo | null;
  hardware: RawHardwareInfo | null;
  bins: RawBinary[];
  libs: RawLibrary[];
  deviceProps: string | null;
  /** package name -> split hash -> verified. From inclusion_proof_check.py. */
  inclusionProof: Map<string, Map<string, boolean>>;
  /**
   * package name -> the untouched record as written by inclusion_proof_check.py.
   * Retained verbatim so the UI can show the evidence, not just our reading of
   * it: the proof artifact is a second, independent measurement of the same
   * APKs and its digests can legitimately disagree with `packages.txt`.
   */
  inclusionProofRecords: Map<string, unknown>;
  /** File the proof verdicts were read from, for provenance in the UI. */
  inclusionProofFileName: string | null;
  hubbleVersion: string | null;
  diagnostics: LoadDiagnostic[];
  fileNames: string[];
}

/**
 * Detects and parses one Hubble artifact.
 * Returns `null` when the JSON is valid but is not a recognised artifact.
 */
export function parseArtifact(fileName: string, text: string): ParsedArtifact | null {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${fileName}: not valid JSON (${(err as Error).message}). ` +
        'A truncated adb pull is the usual cause.',
    );
  }
  if (typeof json !== 'object' || json === null) return null;

  const version = typeof json.version === 'string' ? json.version : null;

  for (const { key, kind, totalKey } of ENVELOPE_KEYS) {
    const value = json[key];
    if (Array.isArray(value)) {
      return {
        kind,
        fileName,
        version,
        declaredTotal: typeof json[totalKey] === 'number' ? (json[totalKey] as number) : null,
        actualTotal: value.length,
        items: value,
      };
    }
  }

  return null;
}

/** Heuristic: an inclusion-proof file is a `packages` array of trimmed objects. */
function looksLikeInclusionProof(fileName: string, items: unknown[], version: string | null): boolean {
  if (/inclusion_proof/i.test(fileName)) return true;
  if (version !== null) return false;
  const first = items[0] as Record<string, unknown> | undefined;
  if (!first) return false;
  // Trimmed records only ever carry these four keys.
  const keys = Object.keys(first);
  return keys.every((k) => ['name', 'versionCode', 'splits', 'hash'].includes(k));
}

/** One record of `packages_with_inclusion_proof_signal.txt`. */
interface InclusionProofEntry {
  name?: string;
  hash?: string;
  splits?: Array<{ hash?: string; inclusion_proof_verified?: boolean }>;
}

/**
 * Folds proof verdicts into `obs`, returning how many package records were
 * absorbed.
 *
 * Shared by the initial load and by a proof artifact supplied later, so the two
 * cannot read the same file differently — which would be a particularly nasty
 * bug, since the whole point of the artifact is to be an independent second
 * measurement.
 */
function ingestInclusionProof(obs: RawObservation, items: unknown[]): number {
  let absorbed = 0;
  for (const entry of items as InclusionProofEntry[]) {
    if (!entry.name) continue;
    absorbed += 1;
    obs.inclusionProofRecords.set(entry.name, entry);
    const perSplit = obs.inclusionProof.get(entry.name) ?? new Map<string, boolean>();
    for (const split of entry.splits ?? []) {
      const h = split.hash ?? entry.hash;
      if (h && typeof split.inclusion_proof_verified === 'boolean') {
        perSplit.set(h, split.inclusion_proof_verified);
      }
    }
    obs.inclusionProof.set(entry.name, perSplit);
  }
  return absorbed;
}

/**
 * Normalises the Hubble >= 2.2.0 `signingInfo` block.
 *
 * Returns `null` — not a synthesised default — when the field is absent, so a
 * legacy observation stays distinguishable from one that genuinely recorded a
 * single unrotated signer. `hasPastSigningCertificates` keeps its tri-state:
 * Hubble emits `null` on API < 28, where rotation is unobservable rather than
 * known to be absent, and coercing that to `false` would invent evidence.
 */
function normaliseSigningInfo(value: unknown): RawSigningInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<RawSigningInfo>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  return {
    hasMultipleSigners: raw.hasMultipleSigners === true,
    hasPastSigningCertificates:
      typeof raw.hasPastSigningCertificates === 'boolean' ? raw.hasPastSigningCertificates : null,
    apkContentsSigners: strings(raw.apkContentsSigners),
    signingCertificateLineage: strings(raw.signingCertificateLineage),
    platformSignatureMatch:
      typeof raw.platformSignatureMatch === 'string'
        ? (raw.platformSignatureMatch as PlatformSignatureMatch)
        : null,
  };
}

function normalisePackage(raw: Partial<RawPackage>): RawPackage {
  return {
    hash: raw.hash ?? null,
    name: raw.name ?? '(unknown)',
    label: raw.label ?? null,
    description: raw.description ?? null,
    versionCode: raw.versionCode ?? 0,
    versionName: raw.versionName ?? null,
    certIds: Array.isArray(raw.certIds) ? raw.certIds : [],
    signingInfo: normaliseSigningInfo(raw.signingInfo),
    isEnabled: raw.isEnabled ?? false,
    isTestOnly: raw.isTestOnly ?? false,
    isFactoryTest: raw.isFactoryTest ?? false,
    isSuspended: raw.isSuspended ?? false,
    isApex: raw.isApex ?? false,
    isPreinstalled: raw.isPreinstalled ?? false,
    isUpdatedSystemApp: raw.isUpdatedSystemApp ?? false,
    isHidden: raw.isHidden ?? false,
    hasCode: raw.hasCode ?? true,
    usesCleartextTraffic: raw.usesCleartextTraffic ?? false,
    installLocation: raw.installLocation ?? null,
    permissionsDeclared: raw.permissionsDeclared ?? [],
    permissionsGranted: raw.permissionsGranted ?? [],
    permissionsNotGranted: raw.permissionsNotGranted ?? [],
    permissionsSpecial: raw.permissionsSpecial ?? [],
    activities: raw.activities ?? [],
    services: raw.services ?? [],
    receivers: raw.receivers ?? [],
    providers: raw.providers ?? [],
    firstInstallTime: raw.firstInstallTime ?? 0,
    sharedUserId: raw.sharedUserId ?? null,
    sharedUserLabel: raw.sharedUserLabel ?? 0,
    splits: raw.splits ?? [],
    splitNames: raw.splitNames ?? [],
    kernelGids: raw.kernelGids ?? [],
    fileSizeInBytes: raw.fileSizeInBytes ?? 0,
  };
}

export interface InputFile {
  name: string;
  text: string;
}

/**
 * Folds a set of files into a single raw observation, collecting diagnostics
 * for anything unexpected (truncation, missing core files, version skew).
 */
export function buildRawObservation(files: InputFile[]): RawObservation {
  const obs: RawObservation = {
    packages: [],
    preinstalledPackages: [],
    certs: [],
    build: null,
    hardware: null,
    bins: [],
    libs: [],
    deviceProps: null,
    inclusionProof: new Map(),
    inclusionProofRecords: new Map(),
    inclusionProofFileName: null,
    hubbleVersion: null,
    diagnostics: [],
    fileNames: [],
  };

  for (const file of files) {
    let artifact: ParsedArtifact | null;
    try {
      artifact = parseArtifact(file.name, file.text);
    } catch (err) {
      obs.diagnostics.push({ fileName: file.name, level: 'error', message: (err as Error).message });
      continue;
    }
    if (!artifact) {
      obs.diagnostics.push({
        fileName: file.name,
        level: 'warning',
        message: 'Unrecognised JSON shape; ignored.',
      });
      continue;
    }

    obs.fileNames.push(file.name);
    if (artifact.version && !obs.hubbleVersion) obs.hubbleVersion = artifact.version;

    if (
      artifact.declaredTotal !== null &&
      artifact.declaredTotal !== artifact.actualTotal
    ) {
      obs.diagnostics.push({
        fileName: file.name,
        level: 'warning',
        message:
          `Envelope declares ${artifact.declaredTotal} items but ${artifact.actualTotal} ` +
          'were parsed. The file may have been truncated in transit.',
      });
    }

    let kind = artifact.kind;
    if (kind === 'packages' && looksLikeInclusionProof(file.name, artifact.items, artifact.version)) {
      kind = 'inclusionProof';
    }

    switch (kind) {
      case 'packages':
        obs.packages = (artifact.items as Partial<RawPackage>[]).map(normalisePackage);
        break;
      case 'preinstalledPackages':
        obs.preinstalledPackages = (artifact.items as Partial<RawPackage>[]).map(normalisePackage);
        break;
      case 'certs':
        obs.certs = artifact.items as RawCertificate[];
        break;
      case 'buildInfo':
        obs.build = (artifact.items[0] as RawBuildInfo) ?? null;
        break;
      case 'hwInfo':
        obs.hardware = (artifact.items[0] as RawHardwareInfo) ?? null;
        break;
      case 'bins':
        obs.bins = artifact.items as RawBinary[];
        break;
      case 'libs':
        obs.libs = artifact.items as RawLibrary[];
        break;
      case 'b64EncodedDeviceProps': {
        const first = artifact.items[0] as RawDeviceProps | undefined;
        obs.deviceProps = first?.encodedDevProps ?? null;
        break;
      }
      case 'inclusionProof': {
        obs.inclusionProofFileName = file.name;
        ingestInclusionProof(obs, artifact.items);
        break;
      }
    }
  }

  if (obs.packages.length === 0 && obs.preinstalledPackages.length > 0) {
    obs.packages = obs.preinstalledPackages;
    obs.diagnostics.push({
      fileName: 'packages.txt',
      level: 'info',
      message: 'packages.txt not supplied; falling back to preinstalled_packages.txt.',
    });
  }
  if (obs.packages.length === 0) {
    // Two very different mistakes reach this point, and they have different
    // remedies. Dropping inclusion_proof_check.py's output on its own is the
    // easy one to make: it is a .txt full of package names, so it looks like an
    // observation, but it records verdicts *about* packages and contains none.
    // It is not a substitute for an observation — it folds onto one that is
    // already open — so say that rather than reporting a missing file.
    const proofOnly = obs.inclusionProofRecords.size > 0;
    obs.diagnostics.push({
      fileName: proofOnly ? (obs.inclusionProofFileName ?? '(set)') : '(set)',
      level: 'error',
      message: proofOnly
        ? 'This is an inclusion-proof artifact, not an observation: it carries ' +
          'transparency-log verdicts but no packages. Load the Hubble output ' +
          'directory first (the one containing packages.txt), then add this file ' +
          'from the Transparency tab to fold the verdicts in.'
        : 'No packages found. packages.txt is required.',
    });
  }
  if (obs.certs.length === 0 && obs.packages.length > 0) {
    obs.diagnostics.push({
      fileName: 'certificates.txt',
      level: 'warning',
      message: 'certificates.txt not supplied; signer pages will show hashes only.',
    });
  }
  // Called out once at load rather than per package: without `signingInfo`
  // every multi-certificate package is irreducibly ambiguous, and an analyst
  // should know that is a property of the capture, not of the device.
  if (obs.packages.length > 0 && obs.packages.every((p) => p.signingInfo === null)) {
    obs.diagnostics.push({
      fileName: 'packages.txt',
      level: 'info',
      message:
        `No signingInfo recorded (Hubble < ${SIGNING_INFO_MIN_VERSION}). Packages with more than one ` +
        'certificate cannot be resolved into a rotation lineage or a co-signer set, and are ' +
        'reported as undetermined. Re-run Hubble to resolve them.',
    });
  }
  return obs;
}

/** Outcome of topping up an existing observation with a proof artifact. */
export interface InclusionProofMergeResult {
  /** The updated observation, or the original one when nothing was absorbed. */
  observation: RawObservation;
  /** Package records absorbed. Zero means the merge was a no-op. */
  packagesCovered: number;
  /** Artifact the verdicts came from, for provenance in the UI. */
  fileName: string | null;
  /** Why nothing was absorbed, phrased for the user. `null` on success. */
  error: string | null;
}

/**
 * Folds an inclusion-proof artifact into an observation that was loaded without
 * one.
 *
 * `inclusion_proof_check.py` is a separate, often much slower run, so an
 * analyst routinely loads the Hubble output first and produces the proof
 * results afterwards. Re-reading the whole directory to pick up one extra file
 * would discard the parse of everything else for no reason, so the existing
 * raw observation is reused and only the proof maps are replaced.
 *
 * Deliberately refuses anything that is not a proof artifact rather than
 * silently ignoring it: this is invoked from a button whose entire purpose is
 * to load that one file, so "nothing happened" is never the right feedback.
 */
export function mergeInclusionProofArtifact(
  base: RawObservation,
  files: InputFile[],
): InclusionProofMergeResult {
  // Copied, not mutated: the caller still holds the old observation and React
  // needs the identity change to know anything happened.
  const next: RawObservation = {
    ...base,
    inclusionProof: new Map(base.inclusionProof),
    inclusionProofRecords: new Map(base.inclusionProofRecords),
    diagnostics: [...base.diagnostics],
    fileNames: [...base.fileNames],
  };

  let packagesCovered = 0;
  let fileName: string | null = null;
  const rejected: string[] = [];

  for (const file of files) {
    let artifact: ParsedArtifact | null;
    try {
      artifact = parseArtifact(file.name, file.text);
    } catch (err) {
      rejected.push((err as Error).message);
      continue;
    }
    const isProof =
      artifact !== null &&
      (artifact.kind === 'inclusionProof' ||
        (artifact.kind === 'packages' &&
          looksLikeInclusionProof(file.name, artifact.items, artifact.version)));
    if (!artifact || !isProof) {
      rejected.push(
        `${file.name} is not an inclusion-proof artifact. Expected the ` +
          'packages_with_inclusion_proof_signal.txt written by inclusion_proof_check.py.',
      );
      continue;
    }
    fileName = file.name;
    packagesCovered += ingestInclusionProof(next, artifact.items);
    if (!next.fileNames.includes(file.name)) next.fileNames.push(file.name);
  }

  if (packagesCovered === 0) {
    return {
      observation: base,
      packagesCovered: 0,
      fileName: null,
      error:
        rejected[0] ??
        'That artifact carried no package records, so there was nothing to merge.',
    };
  }

  next.inclusionProofFileName = fileName;
  next.diagnostics.push({
    fileName: fileName ?? '(inclusion proof)',
    level: 'info',
    // Recorded because the observation is no longer the set of files it was
    // opened with, and the diagnostics list is where that is accounted for.
    message: `Inclusion-proof results merged after load; ${packagesCovered} package records added.`,
  });
  return { observation: next, packagesCovered, fileName, error: null };
}

/** Decodes the base64 `getprop` blob into `key -> value`. */
export function decodeDeviceProps(b64: string | null): Array<[string, string]> {
  if (!b64) return [];
  let text: string;
  try {
    const bytes = base64ToBytes(b64);
    text = new TextDecoder().decode(bytes);
  } catch {
    return [];
  }
  const out: Array<[string, string]> = [];
  // getprop format: [key]: [value]
  const re = /^\[([^\]]*)\]:\s*\[([\s\S]*?)\]$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push([m[1], m[2]]);
  return out;
}

/**
 * Decodes base64 to bytes.
 *
 * The return type is pinned to `Uint8Array<ArrayBuffer>` (rather than the
 * default `ArrayBufferLike`) so the result is directly usable as a `BlobPart`
 * and as ASN.1 input without a copy.
 */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
