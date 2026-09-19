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

import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildRawObservation,
  decodeDeviceProps,
  mergeInclusionProofArtifact,
  parseArtifact,
} from './parse';
import {
  buildObservation,
  classifyInstallState,
  isUnguarded,
  summariseInclusionProof,
  hasSplitNotInLog,
  type ExportedComponentRef,
} from './model';
import { providerCaveats, providerGateSummary, providerGates } from './providers';
import { decodeIdentity } from './x509';
import { toCsv } from './format';
import {
  countSensitivePermissions,
  permissionSeverity,
  SEVERITY_ORDER,
  ZERO_WEIGHT_PERMISSIONS,
} from './sensitivity';
import { computeBaselineDelta, diffObservations } from './diff';
import {
  analyseSharedUidSigners,
  classifySignerChange,
  currentSigner,
  derivePlatformIdentity,
  deriveSigningFacts,
  isPlatformSigned,
  SIGNING_INFO_MIN_VERSION,
} from './signing';
import type { RawPackage, RawSigningInfo } from './types';
import { useApp } from './store';

const VERSION = '2.1.0';

function pkg(overrides: Partial<RawPackage> & { name: string }): RawPackage {
  return {
    hash: 'aa',
    label: overrides.name,
    description: null,
    versionCode: 1,
    versionName: '1.0',
    certIds: [],
    signingInfo: null,
    isEnabled: true,
    isTestOnly: false,
    isFactoryTest: false,
    isSuspended: false,
    isApex: false,
    isPreinstalled: true,
    isUpdatedSystemApp: false,
    isHidden: false,
    hasCode: true,
    usesCleartextTraffic: false,
    installLocation: '/system/app/X/X.apk',
    permissionsDeclared: [],
    permissionsGranted: [],
    permissionsNotGranted: [],
    activities: [],
    services: [],
    receivers: [],
    providers: [],
    firstInstallTime: 0,
    sharedUserId: null,
    sharedUserLabel: 0,
    splits: [],
    kernelGids: [],
    fileSizeInBytes: 0,
    ...overrides,
  };
}

function envelope(
  totalKey: string,
  listKey: string,
  items: unknown[],
  version: string = VERSION,
): string {
  return JSON.stringify({ version, [totalKey]: items.length, [listKey]: items });
}

describe('parseArtifact', () => {
  it('detects artifact kind from the envelope, not the filename', () => {
    const a = parseArtifact('renamed.json', envelope('totalCerts', 'certs', [{ hash: 'x' }]));
    expect(a?.kind).toBe('certs');
    expect(a?.actualTotal).toBe(1);
  });

  it('throws a helpful error on truncated JSON', () => {
    expect(() => parseArtifact('packages.txt', '{"version":"2.1.0","packages":[{')).toThrow(
      /not valid JSON/,
    );
  });

  it('unwraps the single-element array used for build/hardware', () => {
    const a = parseArtifact('build.txt', envelope('totalBuild', 'buildInfo', [{ apiLevel: 34 }]));
    expect(a?.kind).toBe('buildInfo');
  });
});

describe('buildRawObservation', () => {
  it('flags a mismatch between the declared total and the parsed count', () => {
    const text = JSON.stringify({ version: VERSION, totalPackages: 5, packages: [{ name: 'a' }] });
    const obs = buildRawObservation([{ name: 'packages.txt', text }]);
    expect(obs.diagnostics.some((d) => /truncated/i.test(d.message))).toBe(true);
  });

  it('falls back to preinstalled_packages.txt when packages.txt is absent', () => {
    const obs = buildRawObservation([
      {
        name: 'preinstalled_packages.txt',
        text: envelope('totalPreinstalledPackages', 'preinstalledPackages', [{ name: 'android' }]),
      },
    ]);
    expect(obs.packages).toHaveLength(1);
    expect(obs.diagnostics.some((d) => d.level === 'info')).toBe(true);
  });

  it('merges inclusion-proof results keyed by package and split hash', () => {
    const obs = buildRawObservation([
      { name: 'packages.txt', text: envelope('totalPackages', 'packages', [{ name: 'a', hash: 'h1' }]) },
      {
        name: 'packages_with_inclusion_proof_signal.txt',
        text: JSON.stringify({
          packages: [
            { name: 'a', versionCode: 1, hash: 'h1', splits: [{ hash: 'h1', inclusion_proof_verified: true }] },
          ],
        }),
      },
    ]);
    expect(obs.inclusionProof.get('a')?.get('h1')).toBe(true);
  });

  it('tells the user a lone proof artifact is not an observation', () => {
    // The artifact is a .txt listing package names, so it is easy to mistake
    // for an observation. It carries verdicts about packages and no packages,
    // and the remedy is the merge flow rather than a missing file.
    const obs = buildRawObservation([
      {
        name: 'packages_with_inclusion_proof_signal.txt',
        text: JSON.stringify({
          packages: [
            { name: 'a', versionCode: 1, hash: 'h1', splits: [{ hash: 'h1', inclusion_proof_verified: true }] },
          ],
        }),
      },
    ]);
    expect(obs.packages).toHaveLength(0);
    const fatal = obs.diagnostics.find((d) => d.level === 'error');
    expect(fatal?.message).toMatch(/inclusion-proof artifact, not an observation/);
    expect(fatal?.message).toMatch(/Transparency tab/);
    // The generic message would send the user looking for a file they have.
    expect(fatal?.message).not.toMatch(/packages\.txt is required/);
  });
});

describe('store.loadFiles', () => {
  beforeEach(() => {
    useApp.setState({ observations: [], activeId: null, baselineId: null });
  });

  it('refuses a file set that yields no packages, committing nothing', () => {
    const outcome = useApp.getState().loadFiles([
      {
        name: 'packages_with_inclusion_proof_signal.txt',
        text: JSON.stringify({
          packages: [{ name: 'a', versionCode: 1, hash: 'h1', splits: [] }],
        }),
      },
    ]);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/not an observation/);
    // The important half: a refused load must not leave a husk behind for the
    // overview to render as an empty device.
    expect(useApp.getState().observations).toHaveLength(0);
    expect(useApp.getState().activeId).toBeNull();
  });

  it('commits a file set that does yield packages', () => {
    const outcome = useApp.getState().loadFiles([
      { name: 'packages.txt', text: envelope('totalPackages', 'packages', [pkg({ name: 'a' })]) },
    ]);

    expect(outcome.ok).toBe(true);
    expect(useApp.getState().observations).toHaveLength(1);
    expect(useApp.getState().activeId).not.toBeNull();
  });
});

describe('inclusion proof', () => {
  it('summarises each state from the per-split verdicts', () => {
    expect(summariseInclusionProof([{ hash: 'a', inclusion_proof_verified: true }]).state).toBe(
      'verified',
    );
    expect(summariseInclusionProof([{ hash: 'a', inclusion_proof_verified: false }]).state).toBe(
      'failed',
    );
    expect(summariseInclusionProof([{ hash: 'a' }]).state).toBe('unchecked');
    // One published split and one missing split is the anomaly the log exists
    // to expose, so it must not collapse into a single pass/fail.
    const mixed = summariseInclusionProof([
      { hash: 'a', inclusion_proof_verified: true },
      { hash: 'b', inclusion_proof_verified: false },
    ]);
    expect(mixed).toMatchObject({ state: 'partial', verified: 1, failed: 1, total: 2 });
    // A split the proof run never covered leaves the result incomplete.
    const incomplete = summariseInclusionProof([
      { hash: 'a', inclusion_proof_verified: true },
      { hash: 'b' },
    ]);
    expect(incomplete).toMatchObject({ state: 'partial', unknown: 1, failed: 0 });
    // The two kinds of partial are told apart: only one has a split that was
    // positively not found.
    expect(hasSplitNotInLog(mixed)).toBe(true);
    expect(hasSplitNotInLog(incomplete)).toBe(false);
    // "Partially in log" requires something to actually be in the log. With no
    // split found, a split lacking a result does not make it partial.
    expect(
      summariseInclusionProof([
        { hash: 'a', inclusion_proof_verified: false },
        { hash: 'b' },
      ]),
    ).toMatchObject({ state: 'failed', verified: 0, failed: 1, unknown: 1 });
  });

  it('merges verdicts onto packages.txt splits and tallies them per observation', () => {
    const raw = buildRawObservation([
      {
        name: 'packages.txt',
        text: envelope('totalPackages', 'packages', [
          pkg({ name: 'a', hash: 'h1', splits: [{ hash: 'h1' }, { hash: 'h2' }] }),
          pkg({ name: 'b', hash: 'h3', splits: [{ hash: 'h3' }] }),
          pkg({ name: 'c', hash: 'h4', splits: [{ hash: 'h4' }] }),
        ]),
      },
      {
        name: 'packages_with_inclusion_proof_signal.txt',
        text: JSON.stringify({
          packages: [
            {
              name: 'a',
              hash: 'h1',
              splits: [
                { hash: 'h1', inclusion_proof_verified: true },
                { hash: 'h2', inclusion_proof_verified: false },
              ],
            },
            { name: 'b', hash: 'h3', splits: [{ hash: 'h3', inclusion_proof_verified: true }] },
          ],
        }),
      },
    ]);
    const obs = buildObservation(raw, 't');
    const byName = new Map(obs.packages.map((p) => [p.name, p]));
    // The verdicts must reach the split objects themselves, not just a
    // package-level roll-up: the Integrity view renders them per split.
    expect(byName.get('a')!.splits.map((s) => s.inclusion_proof_verified)).toEqual([true, false]);
    expect(byName.get('a')!.inclusionProof.state).toBe('partial');
    expect(byName.get('b')!.inclusionProof.state).toBe('verified');
    expect(byName.get('c')!.inclusionProof.state).toBe('unchecked');
    expect(obs.inclusionProofCounts).toMatchObject({ verified: 1, partial: 1, unchecked: 1 });
    // The verbatim record is kept for the drill-down tab, which shows the
    // evidence rather than only our summary of it.
    expect(raw.inclusionProofFileName).toBe('packages_with_inclusion_proof_signal.txt');
    expect(byName.get('a')!.inclusionProofRecord).toMatchObject({ name: 'a', hash: 'h1' });
    expect(byName.get('c')!.inclusionProofRecord).toBeNull();
  });
});

describe('decodeDeviceProps', () => {
  it('parses the getprop bracket format', () => {
    const b64 = btoa('[ro.secure]: [1]\n[ro.build.id]: [UP1A.231005.007]');
    expect(decodeDeviceProps(b64)).toEqual([
      ['ro.secure', '1'],
      ['ro.build.id', 'UP1A.231005.007'],
    ]);
  });
});

describe('classifyInstallState', () => {
  it('treats a decompressed CAPEX under /data as factory, not an update', () => {
    expect(
      classifyInstallState(
        pkg({
          name: 'com.google.android.tzdata5',
          isApex: true,
          installLocation: '/data/apex/active/com.google.android.tzdata5@350000000.decompressed.apex',
        }),
      ),
    ).toBe('factory-apex');
  });

  it('treats a plain .apex under /data/apex/active as an updated Mainline module', () => {
    expect(
      classifyInstallState(
        pkg({
          name: 'com.google.android.adservices',
          isApex: true,
          installLocation: '/data/apex/active/com.google.android.adservices@351512020.apex',
        }),
      ),
    ).toBe('updated-mainline');
  });

  it('recognises system-partition APEX, updated system apps and user installs', () => {
    expect(
      classifyInstallState(pkg({ name: 'a', isApex: true, installLocation: '/system/apex/a.apex' })),
    ).toBe('factory-apex');
    expect(classifyInstallState(pkg({ name: 'b', isUpdatedSystemApp: true }))).toBe(
      'updated-system-app',
    );
    expect(classifyInstallState(pkg({ name: 'c', isPreinstalled: false }))).toBe('user-installed');
  });
});

describe('sensitivity table', () => {
  it('maps permissions to the published tiers', () => {
    expect(permissionSeverity('android.permission.INSTALL_PACKAGES')).toBe('ASTRONOMICAL');
    expect(permissionSeverity('android.permission.WRITE_SECURE_SETTINGS')).toBe('CRITICAL');
    expect(permissionSeverity('android.permission.READ_CONTACTS')).toBe('MEDIUM');
    expect(permissionSeverity('android.permission.DEVICE_POWER')).toBe('LOW');
    expect(permissionSeverity('android.permission.INTERNET')).toBeNull();
  });

  // Table 2 labels each tier with a vertically centred multirow cell, so read
  // off the rendered PDF the CRITICAL label sits several rows below where its
  // group starts. That misreading once promoted the first eight HIGH rows.
  it('puts the CRITICAL/HIGH boundary where Table 2 does', () => {
    expect(permissionSeverity('android.permission.MOUNT_UNMOUNT_FILESYSTEMS')).toBe('CRITICAL');
    for (const p of [
      'android.permission.INSTALL_GRANT_RUNTIME_PERMISSIONS',
      'android.permission.READ_SMS',
      'android.permission.WRITE_SMS',
      'android.permission.RECEIVE_MMS',
      'android.permission.SEND_SMS_NO_CONFIRMATION',
      'android.permission.RECEIVE_SMS',
      'android.permission.READ_LOGS',
      'android.permission.READ_PRIVILEGED_PHONE_STATE',
    ]) {
      expect(permissionSeverity(p), p).toBe('HIGH');
    }
  });

  it('does not tag the paper\u2019s weight-0 tier as sensitive', () => {
    for (const p of ZERO_WEIGHT_PERMISSIONS) {
      expect(permissionSeverity(p), p).toBeNull();
    }
    expect(countSensitivePermissions(ZERO_WEIGHT_PERMISSIONS)).toBe(0);
  });

  it('has exactly the row count Table 2 prints for each tier', () => {
    const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
    for (const p of TABLE2_ALL_ROWS) {
      const sev = permissionSeverity(p);
      if (sev) counts[sev] += 1;
    }
    expect(counts).toEqual({ ASTRONOMICAL: 1, CRITICAL: 11, HIGH: 21, MEDIUM: 16, LOW: 7 });
  });

  it('counts only permissions present in the table', () => {
    expect(
      countSensitivePermissions([
        'android.permission.INSTALL_PACKAGES',
        'android.permission.READ_SMS',
        'android.permission.INTERNET',
        'android.permission.RECEIVE_BOOT_COMPLETED',
      ]),
    ).toBe(2);
  });
});

/**
 * Every permission row of Table 2 except the weight-0 tier, in the paper's
 * order. Deliberately a second, independent transcription: if this and
 * sensitivity.ts disagree, one of them has drifted from the paper.
 */
const TABLE2_ALL_ROWS = [
  'INSTALL_PACKAGES',
  'COPY_PROTECTED_DATA', 'WRITE_SECURE_SETTINGS', 'READ_FRAME_BUFFER', 'MANAGE_CA_CERTIFICATES',
  'MANAGE_APP_OPS_MODES', 'GRANT_RUNTIME_PERMISSIONS', 'DUMP', 'CAMERA', 'SYSTEM_CAMERA',
  'MANAGE_PROFILE_AND_DEVICE_OWNERS', 'MOUNT_UNMOUNT_FILESYSTEMS',
  'INSTALL_GRANT_RUNTIME_PERMISSIONS', 'READ_SMS', 'WRITE_SMS', 'RECEIVE_MMS',
  'SEND_SMS_NO_CONFIRMATION', 'RECEIVE_SMS', 'READ_LOGS', 'READ_PRIVILEGED_PHONE_STATE',
  'LOCATION_HARDWARE', 'ACCESS_FINE_LOCATION', 'ACCESS_BACKGROUND_LOCATION',
  'BIND_ACCESSIBILITY_SERVICE', 'ACCESS_WIFI_STATE', 'com.android.voicemail.permission.READ_VOICEMAIL',
  'RECORD_AUDIO', 'CAPTURE_AUDIO_OUTPUT', 'ACCESS_NOTIFICATIONS', 'INTERACT_ACROSS_USERS_FULL',
  'BLUETOOTH_PRIVILEGED', 'GET_PASSWORD', 'INTERNAL_SYSTEM_WINDOW',
  'ACCESS_COARSE_LOCATION', 'CHANGE_COMPONENT_ENABLED_STATE', 'READ_CONTACTS', 'WRITE_CONTACTS',
  'CONNECTIVITY_INTERNAL', 'ACCESS_MEDIA_LOCATION', 'READ_EXTERNAL_STORAGE',
  'WRITE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'READ_CALL_LOG', 'WRITE_CALL_LOG',
  'INTERACT_ACROSS_USERS', 'MANAGE_USERS', 'READ_CALENDAR', 'BLUETOOTH_ADMIN', 'BODY_SENSORS',
  'DOWNLOAD_WITHOUT_NOTIFICATION', 'PACKAGE_USAGE_STATS', 'MASTER_CLEAR', 'DELETE_PACKAGES',
  'GET_PACKAGE_SIZE', 'BLUETOOTH', 'DEVICE_POWER',
].map((p) => (p.includes('.') ? p : `android.permission.${p}`));

describe('buildObservation', () => {
  const raw = buildRawObservation([
    {
      name: 'packages.txt',
      text: envelope('totalPackages', 'packages', [
        pkg({ name: 'android', certIds: ['PLAT'], sharedUserId: 'android.uid.system' }),
        pkg({
          name: 'com.oem.app',
          certIds: ['PLAT'],
          sharedUserId: 'android.uid.system',
          permissionsGranted: ['android.permission.INSTALL_PACKAGES'],
          providers: [
            {
              name: 'com.oem.app.P',
              isEnabled: true,
              isExported: true,
              labels: [],
              desc: null,
              authority: 'com.oem.app',
              grantUriPermissions: false,
              permissionRead: 'com.oem.READ',
              permissionWrite: null,
              pathPermissions: [],
              uriPermissionPatterns: [],
              forceUriPermissions: null,
            },
          ],
        }),
        pkg({ name: 'com.third.party', certIds: ['OTHER'], isPreinstalled: false }),
      ]),
    },
    {
      name: 'certificates.txt',
      text: envelope('totalCerts', 'certs', [{ hash: 'PLAT', encodedCert: 'AA==' }]),
    },
  ]);
  const obs = buildObservation(raw, 'test');

  it('identifies the platform certificate from the android package', () => {
    expect(obs.platformCertHash).toBe('PLAT');
    expect(obs.certsByHash.get('PLAT')?.isPlatform).toBe(true);
    expect(obs.packagesByName.get('com.oem.app')?.isPlatformSigned).toBe(true);
  });

  it('builds a reverse index from certificate to packages', () => {
    expect(obs.certsByHash.get('PLAT')?.packageNames.sort()).toEqual(['android', 'com.oem.app']);
  });

  it('marks certificates referenced by packages but absent from certificates.txt', () => {
    expect(obs.certsByHash.get('OTHER')?.isOrphan).toBe(true);
  });

  it('counts a provider with only one of read/write guarded as unguarded', () => {
    expect(obs.packagesByName.get('com.oem.app')?.unguardedExportedCount).toBe(1);
  });

  it('groups packages by shared UID and flags privileged system UIDs', () => {
    const group = obs.sharedUidGroups.find((g) => g.sharedUserId === 'android.uid.system');
    expect(group?.isSystemUid).toBe(true);
    expect(group?.packageNames).toHaveLength(2);
  });

  it('indexes permissions in reverse', () => {
    expect(obs.permissionsByName.get('android.permission.INSTALL_PACKAGES')?.grantedTo).toEqual([
      'com.oem.app',
    ]);
  });
});

describe('diff and baseline delta', () => {
  const mk = (pkgs: RawPackage[]) =>
    buildObservation(
      buildRawObservation([
        { name: 'packages.txt', text: envelope('totalPackages', 'packages', pkgs) },
      ]),
    );

  const baseline = mk([
    pkg({ name: 'android', certIds: ['PLAT'] }),
    pkg({ name: 'com.aosp.a', certIds: ['PLAT'] }),
  ]);
  const target = mk([
    pkg({ name: 'android', certIds: ['PLAT'] }),
    pkg({ name: 'com.aosp.a', certIds: ['OEM'], versionCode: 2 }),
    pkg({
      name: 'com.oem.new',
      certIds: ['PLAT'],
      usesCleartextTraffic: true,
      permissionsGranted: ['android.permission.INSTALL_PACKAGES'],
    }),
  ]);

  const d = diffObservations(baseline, target);

  it('detects additions, modifications and signer-set changes', () => {
    expect(d.added.map((x) => x.name)).toEqual(['com.oem.new']);
    expect(d.removed).toHaveLength(0);
    expect(d.signerChanges.map((x) => x.name)).toEqual(['com.aosp.a']);
    expect(d.newSigners).toContain('OEM');
  });

  it('counts the preloaded surface the target adds over the baseline', () => {
    const delta = computeBaselineDelta(baseline, target);
    // 1 of the 2 platform-signed preloads in the target is not in the baseline.
    expect(delta.platformSigned.targetCount).toBe(2);
    expect(delta.platformSigned.novelCount).toBe(1);
    expect(delta.platformSigned.novelPackages).toEqual(['com.oem.new']);
    // Every cleartext-enabled preload in the target is new.
    expect(delta.cleartextTraffic.novelCount).toBe(1);
    expect(delta.sensitivePermissions.novelPackages).toEqual(['com.oem.new']);
    expect(delta.novelPreloads).toEqual(['com.oem.new']);
  });

  it('does not count a package the baseline also ships as novel when it only gains the attribute', () => {
    // com.aosp.a is preloaded on both sides; it is platform-signed only on the
    // target. That is a change to an existing package, not a package the target
    // added, so it must not inflate the "new" count the compare view reports.
    const b = mk([
      pkg({ name: 'android', certIds: ['PLAT'] }),
      pkg({ name: 'com.aosp.a', certIds: ['OEM'] }),
    ]);
    const t = mk([
      pkg({ name: 'android', certIds: ['PLAT'] }),
      pkg({ name: 'com.aosp.a', certIds: ['PLAT'] }),
    ]);

    const delta = computeBaselineDelta(b, t);
    expect(delta.platformSigned.targetCount).toBe(2);
    expect(delta.platformSigned.novelCount).toBe(0);
    expect(delta.platformSigned.novelPackages).toEqual([]);
    expect(delta.novelPreloads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Signing inference
//
// Mirrors scripts/python/tests/test_hubble_parser.py. The two implementations
// are held to the same cases on purpose: if one starts answering differently,
// the same artifact would be read two ways depending on which tool you used.
// ---------------------------------------------------------------------------

function sinfo(overrides: Partial<RawSigningInfo>): RawSigningInfo {
  return {
    hasMultipleSigners: false,
    hasPastSigningCertificates: false,
    apkContentsSigners: [],
    signingCertificateLineage: [],
    platformSignatureMatch: null,
    ...overrides,
  };
}

describe('deriveSigningFacts', () => {
  it('reports one certificate with no history as a single signer', () => {
    const f = deriveSigningFacts(
      pkg({
        name: 'a',
        certIds: ['A'],
        signingInfo: sinfo({ apkContentsSigners: ['A'], signingCertificateLineage: ['A'] }),
      }),
    );
    expect(f.mode).toBe('single-signer');
    expect(f.activeSigners).toEqual(['A']);
    expect(f.pastSigners).toEqual([]);
    expect(currentSigner(f)).toBe('A');
  });

  it('resolves a lineage into one active signer plus retired ancestors', () => {
    const f = deriveSigningFacts(
      pkg({
        name: 'a',
        certIds: ['OLD', 'NEW'],
        signingInfo: sinfo({
          hasPastSigningCertificates: true,
          apkContentsSigners: ['NEW'],
          signingCertificateLineage: ['OLD', 'NEW'],
        }),
      }),
    );
    expect(f.mode).toBe('key-rotation-lineage');
    expect(f.activeSigners).toEqual(['NEW']);
    expect(f.pastSigners).toEqual(['OLD']);
    expect(currentSigner(f)).toBe('NEW');
    expect(f.allSigners.sort()).toEqual(['NEW', 'OLD']);
  });

  it('treats the same two certificates as co-signers when the device says so', () => {
    const f = deriveSigningFacts(
      pkg({
        name: 'a',
        certIds: ['A', 'B'],
        signingInfo: sinfo({ hasMultipleSigners: true, apkContentsSigners: ['A', 'B'] }),
      }),
    );
    expect(f.mode).toBe('multiple-signers');
    expect(f.activeSigners).toEqual(['A', 'B']);
    expect(f.pastSigners).toEqual([]);
    // No single key can ship an update, so there is no single current signer.
    expect(currentSigner(f)).toBeNull();
  });

  it('ignores a lineage reported alongside multiple signers', () => {
    // v3 rotation is not supported for multi-signer APKs; rendering a
    // co-signer set as an ordered history would invent a retirement.
    const f = deriveSigningFacts(
      pkg({
        name: 'a',
        signingInfo: sinfo({
          hasMultipleSigners: true,
          apkContentsSigners: ['A', 'B'],
          signingCertificateLineage: ['A', 'B'],
        }),
      }),
    );
    expect(f.lineage).toEqual([]);
    expect(f.pastSigners).toEqual([]);
  });

  it('refuses to guess on a pre-2.2.0 observation', () => {
    const f = deriveSigningFacts(pkg({ name: 'a', certIds: ['A', 'B'] }));
    expect(f.mode).toBe('unknown');
    expect(f.unknownReason).toBe('legacy-schema');
    expect(f.structured).toBe(false);
    expect(f.lineage).toEqual([]);
  });

  it('refuses to guess when rotation is unobservable on API < 28', () => {
    const f = deriveSigningFacts(
      pkg({
        name: 'a',
        certIds: ['A'],
        signingInfo: sinfo({ hasPastSigningCertificates: null, apkContentsSigners: ['A'] }),
      }),
    );
    expect(f.mode).toBe('unknown');
    expect(f.unknownReason).toBe('unobservable');
  });

  it('still reports co-signing affirmatively on API < 28', () => {
    // The signer *count* is observable everywhere, unlike the rotation state.
    const f = deriveSigningFacts(
      pkg({
        name: 'a',
        signingInfo: sinfo({
          hasMultipleSigners: true,
          hasPastSigningCertificates: null,
          apkContentsSigners: ['A', 'B'],
        }),
      }),
    );
    expect(f.mode).toBe('multiple-signers');
  });

  it('distinguishes an empty signingInfo block from a legacy one', () => {
    const f = deriveSigningFacts(pkg({ name: 'a', signingInfo: sinfo({}) }));
    expect(f.mode).toBe('unknown');
    expect(f.unknownReason).toBe('no-certificates');
    expect(f.structured).toBe(true);
  });

  it('recovers the active signer from the lineage tail when digests are missing', () => {
    const f = deriveSigningFacts(
      pkg({
        name: 'a',
        signingInfo: sinfo({
          hasPastSigningCertificates: true,
          apkContentsSigners: [],
          signingCertificateLineage: ['OLD', 'NEW'],
        }),
      }),
    );
    expect(f.activeSigners).toEqual(['NEW']);
    expect(f.mode).toBe('key-rotation-lineage');
  });
});

describe('platform identity', () => {
  const platformPkgs = [
    pkg({
      name: 'android',
      certIds: ['PLAT_OLD', 'PLAT_NEW'],
      signingInfo: sinfo({
        hasPastSigningCertificates: true,
        apkContentsSigners: ['PLAT_NEW'],
        signingCertificateLineage: ['PLAT_OLD', 'PLAT_NEW'],
      }),
    }),
  ];
  const platform = derivePlatformIdentity(platformPkgs);

  it('badges the currently active platform key, not the oldest ancestor', () => {
    expect(platform.primary).toBe('PLAT_NEW');
    expect(platform.mode).toBe('key-rotation-lineage');
    expect([...platform.anchor].sort()).toEqual(['PLAT_NEW', 'PLAT_OLD']);
  });

  it('still trusts a package signed with a retired platform certificate', () => {
    // The platform side may use its whole history: rotating the platform key
    // must not orphan system packages that have not been re-signed yet.
    const stale = deriveSigningFacts(
      pkg({
        name: 'com.oem.stale',
        signingInfo: sinfo({ apkContentsSigners: ['PLAT_OLD'] }),
      }),
    );
    expect(isPlatformSigned(stale, platform)).toBe(true);
  });

  it('does not trust a package that rotated away from the platform key', () => {
    // The candidate side may *not* use its whole history, or a package could
    // shed the platform key and keep the privileges forever.
    const rotatedAway = deriveSigningFacts(
      pkg({
        name: 'com.oem.moved',
        certIds: ['PLAT_OLD', 'OEM'],
        signingInfo: sinfo({
          hasPastSigningCertificates: true,
          apkContentsSigners: ['OEM'],
          signingCertificateLineage: ['PLAT_OLD', 'OEM'],
        }),
      }),
    );
    expect(rotatedAway.allSigners).toContain('PLAT_OLD');
    expect(isPlatformSigned(rotatedAway, platform)).toBe(false);
  });

  it('ignores the recorded checkSignatures verdict', () => {
    // MATCH is a false positive for a rotated-away package, because
    // checkSignatures() falls back to comparing each side's oldest ancestor.
    const rotatedAway = deriveSigningFacts(
      pkg({
        name: 'com.oem.moved',
        signingInfo: sinfo({
          hasPastSigningCertificates: true,
          apkContentsSigners: ['OEM'],
          signingCertificateLineage: ['PLAT_OLD', 'OEM'],
          platformSignatureMatch: 'MATCH',
        }),
      }),
    );
    expect(rotatedAway.platformSignatureMatch).toBe('MATCH');
    expect(isPlatformSigned(rotatedAway, platform)).toBe(false);
  });

  it('reports no platform identity when the android package is absent', () => {
    const none = derivePlatformIdentity([pkg({ name: 'com.oem.app', certIds: ['OEM'] })]);
    expect(none.primary).toBeNull();
    expect(isPlatformSigned(deriveSigningFacts(pkg({ name: 'x', certIds: ['OEM'] })), none)).toBe(
      false,
    );
  });
});

describe('classifySignerChange', () => {
  const facts = (o: Partial<RawSigningInfo>) => deriveSigningFacts(pkg({ name: 'a', signingInfo: sinfo(o) }));
  const legacy = (certIds: string[]) => deriveSigningFacts(pkg({ name: 'a', certIds }));

  const single = facts({ apkContentsSigners: ['A'], signingCertificateLineage: ['A'] });

  it('says nothing changed when the lineage and signers match', () => {
    expect(classifySignerChange(single, single)).toBe('none');
  });

  it('calls an appended key a rotation', () => {
    const rotated = facts({
      hasPastSigningCertificates: true,
      apkContentsSigners: ['B'],
      signingCertificateLineage: ['A', 'B'],
    });
    expect(classifySignerChange(single, rotated)).toBe('rotation');
  });

  it('calls a replaced signer a signer change', () => {
    const resigned = facts({ apkContentsSigners: ['B'], signingCertificateLineage: ['B'] });
    expect(classifySignerChange(single, resigned)).toBe('signer-change');
  });

  it('does not accept a rewritten lineage as a rotation', () => {
    const before = facts({
      hasPastSigningCertificates: true,
      apkContentsSigners: ['B'],
      signingCertificateLineage: ['A', 'B'],
    });
    const after = facts({
      hasPastSigningCertificates: true,
      apkContentsSigners: ['C'],
      signingCertificateLineage: ['X', 'C'],
    });
    expect(classifySignerChange(before, after)).toBe('signer-change');
  });

  it('refuses to attribute a change when either side is pre-2.2.0', () => {
    const rotated = facts({
      hasPastSigningCertificates: true,
      apkContentsSigners: ['B'],
      signingCertificateLineage: ['A', 'B'],
    });
    expect(classifySignerChange(legacy(['A']), rotated)).toBe('undetermined');
    expect(classifySignerChange(legacy(['A']), legacy(['A']))).toBe('none');
  });

  it('treats a lineage that merely became observable as a rotation, not a re-signing', () => {
    // The API < 28 shape: Hubble recorded signingInfo, but the platform cannot
    // report rotation there, so the lineage is empty while B signs the APK.
    const unobservable = facts({
      hasPastSigningCertificates: null,
      apkContentsSigners: ['B'],
      signingCertificateLineage: [],
    });
    // The same app seen on API >= 28: same active key, history now visible.
    const observed = facts({
      hasPastSigningCertificates: true,
      apkContentsSigners: ['B'],
      signingCertificateLineage: ['A', 'B'],
    });
    // B still signs on both sides, so nothing was re-signed. Reporting
    // 'signer-change' here would put the loudest verdict in the tool on a
    // package whose signing key never moved.
    expect(classifySignerChange(unobservable, observed)).toBe('rotation');
  });
});

describe('analyseSharedUidSigners', () => {
  const facts = (o: Partial<RawSigningInfo>) => deriveSigningFacts(pkg({ name: 'a', signingInfo: sinfo(o) }));

  it('accepts members that rotated at different times', () => {
    // Android joins a shared UID against the whole lineage, so differing
    // certIds between members is not by itself evidence of anything.
    const notYetRotated = facts({ apkContentsSigners: ['A'], signingCertificateLineage: ['A'] });
    const rotated = facts({
      hasPastSigningCertificates: true,
      apkContentsSigners: ['B'],
      signingCertificateLineage: ['A', 'B'],
    });
    expect(analyseSharedUidSigners([notYetRotated, rotated])).toEqual({
      known: true,
      divergent: false,
    });
  });

  it('flags members whose signing histories share nothing', () => {
    const a = facts({ apkContentsSigners: ['A'], signingCertificateLineage: ['A'] });
    const z = facts({ apkContentsSigners: ['Z'], signingCertificateLineage: ['Z'] });
    expect(analyseSharedUidSigners([a, z])).toEqual({ known: true, divergent: true });
  });

  it('cannot answer when a member is pre-2.2.0', () => {
    const a = facts({ apkContentsSigners: ['A'], signingCertificateLineage: ['A'] });
    const old = deriveSigningFacts(pkg({ name: 'b', certIds: ['Z'] }));
    expect(analyseSharedUidSigners([a, old]).known).toBe(false);
  });
});

describe('buildObservation with structured signing', () => {
  const raw = buildRawObservation([
    {
      name: 'packages.txt',
      text: envelope('totalPackages', 'packages', [
        pkg({
          name: 'android',
          certIds: ['PLAT_OLD', 'PLAT_NEW'],
          signingInfo: sinfo({
            hasPastSigningCertificates: true,
            apkContentsSigners: ['PLAT_NEW'],
            signingCertificateLineage: ['PLAT_OLD', 'PLAT_NEW'],
          }),
        }),
        pkg({
          name: 'com.oem.stale',
          certIds: ['PLAT_OLD'],
          signingInfo: sinfo({
            apkContentsSigners: ['PLAT_OLD'],
            signingCertificateLineage: ['PLAT_OLD'],
          }),
        }),
        pkg({
          name: 'com.oem.moved',
          certIds: ['PLAT_OLD', 'OEM'],
          signingInfo: sinfo({
            hasPastSigningCertificates: true,
            apkContentsSigners: ['OEM'],
            signingCertificateLineage: ['PLAT_OLD', 'OEM'],
          }),
        }),
      ], SIGNING_INFO_MIN_VERSION),
    },
  ]);
  const obs = buildObservation(raw, 'structured');

  it('uses the active platform signer as the platform certificate', () => {
    expect(obs.platformCertHash).toBe('PLAT_NEW');
    expect(obs.certsByHash.get('PLAT_OLD')?.isPlatform).toBe(false);
    expect(obs.certsByHash.get('PLAT_OLD')?.isPlatformLineage).toBe(true);
  });

  it('separates the packages a certificate still signs from the ones it retired from', () => {
    const old = obs.certsByHash.get('PLAT_OLD');
    expect(old?.activeFor.sort()).toEqual(['com.oem.stale']);
    expect(old?.retiredFor.sort()).toEqual(['android', 'com.oem.moved']);
  });

  it('applies platform matching directionally', () => {
    expect(obs.packagesByName.get('com.oem.stale')?.isPlatformSigned).toBe(true);
    expect(obs.packagesByName.get('com.oem.moved')?.isPlatformSigned).toBe(false);
  });

  it('counts the signing modes it observed', () => {
    expect(obs.hasStructuredSigning).toBe(true);
    expect(obs.signingModeCounts['key-rotation-lineage']).toBe(2);
    expect(obs.signingModeCounts['single-signer']).toBe(1);
    expect(obs.signingModeCounts.unknown).toBe(0);
  });
});

describe('diff separates rotations from re-signings', () => {
  const mk = (pkgs: RawPackage[]) =>
    buildObservation(
      buildRawObservation([
        {
          name: 'packages.txt',
          text: envelope('totalPackages', 'packages', pkgs, SIGNING_INFO_MIN_VERSION),
        },
      ]),
    );

  const before = mk([
    pkg({
      name: 'com.rotates',
      certIds: ['A'],
      signingInfo: sinfo({ apkContentsSigners: ['A'], signingCertificateLineage: ['A'] }),
    }),
    pkg({
      name: 'com.resigned',
      certIds: ['C'],
      signingInfo: sinfo({ apkContentsSigners: ['C'], signingCertificateLineage: ['C'] }),
    }),
  ]);
  const after = mk([
    pkg({
      name: 'com.rotates',
      certIds: ['A', 'B'],
      versionCode: 2,
      signingInfo: sinfo({
        hasPastSigningCertificates: true,
        apkContentsSigners: ['B'],
        signingCertificateLineage: ['A', 'B'],
      }),
    }),
    pkg({
      name: 'com.resigned',
      certIds: ['D'],
      versionCode: 2,
      signingInfo: sinfo({ apkContentsSigners: ['D'], signingCertificateLineage: ['D'] }),
    }),
  ]);

  const d = diffObservations(before, after);

  it('does not let an expected rotation sit in the same bucket as a re-signing', () => {
    expect(d.keyRotations.map((p) => p.name)).toEqual(['com.rotates']);
    expect(d.reSignings.map((p) => p.name)).toEqual(['com.resigned']);
    expect(d.undeterminedSignerChanges).toHaveLength(0);
    expect(d.signerChanges).toHaveLength(2);
  });

  it('does not report a schema upgrade as a signing change', () => {
    // Comparing a pre-2.2.0 baseline against a 2.2.0 target must not light up
    // every package: the lineage became *visible*, it did not change.
    const legacy = mk([pkg({ name: 'com.rotates', certIds: ['A'] })]);
    const structured = mk([
      pkg({
        name: 'com.rotates',
        certIds: ['A'],
        signingInfo: sinfo({ apkContentsSigners: ['A'], signingCertificateLineage: ['A'] }),
      }),
    ]);
    const upgraded = diffObservations(legacy, structured);
    expect(upgraded.signerChanges).toHaveLength(0);
    expect(upgraded.changed.flatMap((p) => p.changes.map((c) => c.field))).not.toContain(
      'signingMode',
    );
  });

  it('counts only newly active keys as new signers', () => {
    // 'A' survives in the target only as a retired lineage entry. It is no
    // longer a key that can ship code, so it counts as retired here even
    // though the certificate is still recorded.
    expect(d.newSigners.sort()).toEqual(['B', 'D']);
    expect(d.retiredSigners.sort()).toEqual(['A', 'C']);
  });
});

describe('mergeInclusionProofArtifact', () => {
  // The proof run is a separate, slower job, so an observation is routinely
  // opened before its results exist. Merging them must not require re-reading
  // anything else.
  const base = () =>
    buildRawObservation([
      {
        name: 'packages.txt',
        text: envelope('totalPackages', 'packages', [
          pkg({ name: 'com.oem.app', hash: 'AAAA', splits: [] }),
        ]),
      },
    ]);

  const proofFile = (items: unknown[]) => ({
    name: 'packages_with_inclusion_proof_signal.txt',
    text: JSON.stringify({ packages: items }),
  });

  it('folds late-arriving verdicts into an observation loaded without them', () => {
    const before = base();
    expect(before.inclusionProof.size).toBe(0);

    const merged = mergeInclusionProofArtifact(before, [
      proofFile([
        { name: 'com.oem.app', versionCode: 1, splits: [{ hash: 'AAAA', inclusion_proof_verified: true }] },
      ]),
    ]);

    expect(merged.error).toBeNull();
    expect(merged.packagesCovered).toBe(1);
    expect(merged.fileName).toBe('packages_with_inclusion_proof_signal.txt');
    expect(merged.observation.inclusionProof.get('com.oem.app')?.get('AAAA')).toBe(true);
    // Everything else survives untouched: the point is not to re-parse it.
    expect(merged.observation.packages).toBe(before.packages);
  });

  it('leaves the original observation alone', () => {
    // The caller still holds it, and React needs the identity change to notice.
    const before = base();
    const merged = mergeInclusionProofArtifact(before, [
      proofFile([{ name: 'com.oem.app', splits: [{ hash: 'AAAA', inclusion_proof_verified: false }] }]),
    ]);
    expect(before.inclusionProof.size).toBe(0);
    expect(merged.observation).not.toBe(before);
  });

  it('rejects a file that is not a proof artifact instead of silently doing nothing', () => {
    const before = base();
    const merged = mergeInclusionProofArtifact(before, [
      { name: 'certificates.txt', text: envelope('totalCerts', 'certs', [{ hash: 'PLAT' }]) },
    ]);
    expect(merged.packagesCovered).toBe(0);
    expect(merged.error).toMatch(/not an inclusion-proof artifact/);
    // Unchanged observation returned by identity, so no spurious re-render.
    expect(merged.observation).toBe(before);
  });

  it('reports invalid JSON rather than throwing at the caller', () => {
    const merged = mergeInclusionProofArtifact(base(), [
      { name: 'packages_with_inclusion_proof_signal.txt', text: '{"packages":[' },
    ]);
    expect(merged.packagesCovered).toBe(0);
    expect(merged.error).toMatch(/not valid JSON/);
  });

  it('rebuilds into an observation that reports the proof state', () => {
    const merged = mergeInclusionProofArtifact(base(), [
      proofFile([
        { name: 'com.oem.app', versionCode: 1, splits: [{ hash: 'AAAA', inclusion_proof_verified: true }] },
      ]),
    ]);
    const obs = buildObservation(merged.observation, 'merged');
    expect(obs.hasInclusionProofData).toBe(true);
    expect(obs.packagesByName.get('com.oem.app')?.inclusionProof.state).toBe('verified');
    // The merge is recorded, because the observation is no longer the set of
    // files it was opened with.
    expect(obs.diagnostics.some((d) => /merged after load/.test(d.message))).toBe(true);
  });
});

describe('provider access gates', () => {
  const prov = (over: Partial<ExportedComponentRef> = {}): ExportedComponentRef => ({
    packageName: 'com.oem.app',
    componentType: 'provider',
    name: 'com.oem.app.P',
    isEnabled: true,
    isExported: true,
    permission: null,
    permissionRead: null,
    permissionWrite: null,
    ...over,
  });

  it('reports an exported unguarded provider as reachable by any app', () => {
    const [read, write] = providerGates(prov());
    expect(read.reach).toBe('any-app');
    expect(write.reach).toBe('any-app');
    // The wording has to rule out "the observation did not record this".
    expect(read.label).toBe('any app');
    expect(read.title).toMatch(/android:permission/);
  });

  it('does not raise the alarm when the same provider is not exported', () => {
    const [read, write] = providerGates(prov({ isExported: false }));
    expect(read.reach).toBe('internal');
    expect(write.reach).toBe('internal');
    expect(read.title).toMatch(/own UID/);
  });

  it('treats a disabled provider as unreachable too', () => {
    expect(providerGates(prov({ isEnabled: false }))[0].reach).toBe('internal');
  });

  it('keeps the two gates independent', () => {
    // The case the old "R:x / W:none" rendering buried: readable only with a
    // permission, writable by anybody.
    const [read, write] = providerGates(prov({ permissionRead: 'com.oem.READ' }));
    expect(read.reach).toBe('guarded');
    // A vendor permission has no well-known prefix to strip.
    expect(read.label).toBe('com.oem.READ');
    expect(write.reach).toBe('any-app');
  });

  it('shortens the permission but keeps the full name for the tooltip', () => {
    const [read] = providerGates(prov({ permissionRead: 'android.permission.READ_SECURE_SETTINGS' }));
    expect(read.label).toBe('READ_SECURE_SETTINGS');
    expect(read.permission).toBe('android.permission.READ_SECURE_SETTINGS');
    expect(read.title).toContain('android.permission.READ_SECURE_SETTINGS');
  });

  it('surfaces path permissions and URI grants as caveats, not verdicts', () => {
    expect(providerCaveats(prov())).toEqual([]);
    const caveats = providerCaveats(prov({ pathPermissionCount: 2, grantUriPermissions: true }));
    expect(caveats).toHaveLength(2);
    expect(caveats[0]).toMatch(/2 path permissions/);
    expect(caveats[1]).toMatch(/grantUriPermissions/);
    // Singular reads correctly.
    expect(providerCaveats(prov({ pathPermissionCount: 1 }))[0]).toMatch(/1 path permission /);
  });

  it('collapses the pair when read and write agree', () => {
    expect(providerGateSummary(prov()).map((g) => g.op)).toEqual(['both']);
    expect(providerGateSummary(prov({ isExported: false })).map((g) => g.op)).toEqual(['both']);
    const same = { permissionRead: 'com.oem.RW', permissionWrite: 'com.oem.RW' };
    expect(providerGateSummary(prov(same)).map((g) => g.op)).toEqual(['both']);
    // The collapsed tooltip must cover both operations, not just the read.
    expect(providerGateSummary(prov())[0].title).toMatch(/read and write/);
  });

  it('keeps the pair split whenever the two gates differ at all', () => {
    // Different reach.
    expect(providerGateSummary(prov({ permissionRead: 'com.oem.READ' })).map((g) => g.op)).toEqual([
      'read',
      'write',
    ]);
    // Same reach, different permission: still two, because which key opens
    // which door is the whole point.
    const asym = { permissionRead: 'com.oem.READ', permissionWrite: 'com.oem.WRITE' };
    expect(providerGateSummary(prov(asym)).map((g) => g.op)).toEqual(['read', 'write']);
  });

  it('agrees with isUnguarded about which providers are exposed', () => {
    for (const c of [
      prov(),
      prov({ permissionRead: 'com.oem.READ' }),
      prov({ permissionRead: 'com.oem.READ', permissionWrite: 'com.oem.WRITE' }),
      prov({ isExported: false }),
    ]) {
      const anyOpen = providerGates(c).some((g) => g.reach === 'any-app');
      expect(anyOpen).toBe(isUnguarded(c));
    }
  });
});

describe('certificate identity peek', () => {
  // A real self-signed certificate, `openssl req -x509` with
  // subject "/CN=Test Signer/O=Test Org/C=US". Inlined so the test needs no
  // fixture on disk and does not depend on the sample-data generator having
  // been run.
  const SELF_SIGNED =
    'MIIDTTCCAjWgAwIBAgIUS+DzGZexsrxvY1BRdLguQ2LiV0owDQYJKoZIhvcNAQELBQAwNjEUMBIG' +
    'A1UEAwwLVGVzdCBTaWduZXIxETAPBgNVBAoMCFRlc3QgT3JnMQswCQYDVQQGEwJVUzAeFw0yNjA5' +
    'MjMyMDQ1MzhaFw0zNjA5MjAyMDQ1MzhaMDYxFDASBgNVBAMMC1Rlc3QgU2lnbmVyMREwDwYDVQQK' +
    'DAhUZXN0IE9yZzELMAkGA1UEBhMCVVMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDG' +
    'm8WRuR9SMrSZi5TZ1eAICpmz+e7cvZrb2S0dOOUzDaJM7mUYaaCU1B8enhPFLkr45a2W5g9LbAb6' +
    '7TQohT5FF/x1C7N6ehJiFf3x2GlzZ2FMZ15T76akb0StwvCvPafCPG71CXgumHs4Qzvlyc8aGmKG' +
    'GWU4Hi2C5SpSqJsaQPWi7AthBOnOIfUD51fOMa8RzzGG+UxtFc+MtFFowL0xeJnv+C7jIy8jGkur' +
    'aeYSgGr01Hq5t0DDAxYKUVnpOhaa01trv0O0SZ9PzwH6NDBWOhLVKWsDfkb5FnrEs9LXI21sP3oQ' +
    '3Kr28Y2uLT2IcgbzX0NYM13TOVSUUWgpFcpHAgMBAAGjUzBRMB0GA1UdDgQWBBSd2kHVaYkJ3KmW' +
    'yFKz4/+VxNEOpzAfBgNVHSMEGDAWgBSd2kHVaYkJ3KmWyFKz4/+VxNEOpzAPBgNVHRMBAf8EBTAD' +
    'AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQA1KwNx+fnxGpk6/mc0Myq/ZMreM3yjp6Av1oUqVS04oic6' +
    'xDBdrdakLAx+loquH9a/GRcjsld2mXYaHditXY6iz/f3vb4pMa5hP/4ypZPbEt+gvHzqLREMSjv6' +
    'D5O1VifDAXRKfDTcUlW8r8EBXSrBS+QUaGca+fKbI2akjbLeJ1eCowoOVkhBwh4C3rq22+oIJMPm' +
    'GhiwJdMis8nYlJO6y1kQJsT7FOUpFPG8IB75ECkylZZH0JLYbhhZSx7OUhUvCEn2DlncdS8xib9j' +
    'cafrVLRNgM0gZjhOn0d/33vS31Ar1g7CFMQdMB4eyOP3BXjeTLr4A0UiXDa+jHhYedZ3';

  it('pulls the CN and the O out of the subject', () => {
    const id = decodeIdentity(SELF_SIGNED);
    expect(id).not.toBeNull();
    expect(id?.commonName).toBe('Test Signer');
    expect(id?.organization).toBe('Test Org');
    // The full DN is kept for the tooltip, including the RDNs not surfaced.
    expect(id?.subject).toContain('C=US');
  });

  it('returns null when there are no bytes to read', () => {
    expect(decodeIdentity(null)).toBeNull();
    expect(decodeIdentity(undefined)).toBeNull();
    expect(decodeIdentity('')).toBeNull();
  });

  it('reports null rather than throwing on bytes that are not a certificate', () => {
    // Valid base64, not valid ASN.1. An orphan or a corrupted artifact must not
    // take the whole signer table down with it.
    expect(decodeIdentity('bm90IGEgY2VydGlmaWNhdGU=')).toBeNull();
    expect(decodeIdentity('!!! not base64 !!!')).toBeNull();
  });

  it('caches by the certificate bytes', () => {
    // Same input must return the identical object, so the table can re-derive
    // its rows on every keystroke without re-parsing every DER.
    expect(decodeIdentity(SELF_SIGNED)).toBe(decodeIdentity(SELF_SIGNED));
  });

  // Self-signed, subject
  //   "/CN=Test Signer/O=Google, Inc./OU=Android+L=Mountain View/ST=CA".
  // Two hazards in one certificate: the O contains a comma, which RFC 4514
  // stores escaped as `O=Google\, Inc.`, and the OU/L pair is a single
  // multi-valued RDN joined by `+`.
  const COMMA_IN_ORG =
    'MIIDpTCCAo2gAwIBAgIUZaG1JXgmROZbeqYpxtKG42beuBkwDQYJKoZIhvcNAQELBQAwYjEUMBIG' +
    'A1UEAwwLVGVzdCBTaWduZXIxFTATBgNVBAoMDEdvb2dsZSwgSW5jLjEmMA4GA1UECwwHQW5kcm9p' +
    'ZDAUBgNVBAcMDU1vdW50YWluIFZpZXcxCzAJBgNVBAgMAkNBMB4XDTI2MDkyNDAyMDYyOFoXDTM2' +
    'MDkyMTAyMDYyOFowYjEUMBIGA1UEAwwLVGVzdCBTaWduZXIxFTATBgNVBAoMDEdvb2dsZSwgSW5j' +
    'LjEmMA4GA1UECwwHQW5kcm9pZDAUBgNVBAcMDU1vdW50YWluIFZpZXcxCzAJBgNVBAgMAkNBMIIB' +
    'IjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1pH/iB/shelEIWC9nZWv6fUTGizMkDccEMYg' +
    'kfUlWAUoqUaIGndndbPavKx6zzOPGOaQnG72eSloxCAdGSqDY4LeGluAkp0ubI+QTZXvWVzgp7+V' +
    'lVZNL56tWJaMpAB5UmWZnfcDvw01808rKkRIJg+arn61SCDCKVzEinDSYoFkRqMCqmoahgiE8tM0' +
    'WWv3xBsblKVmENAiffB0aKQdwV9s7hP6CfowBky8w0pzwN0BZayas3JcxO6+/t9fx4XbpjMLA3dS' +
    'OCqu+rDxRxzxpwvbXvpl9NR0nyFmuYSg9oUjdHQmlQSD2cPI1TWENWZPbptW4MpqoCMdAGOI3INS' +
    'iwIDAQABo1MwUTAdBgNVHQ4EFgQUYCgPEpX4SfJGyipSogkRprUbHJYwHwYDVR0jBBgwFoAUYCgP' +
    'EpX4SfJGyipSogkRprUbHJYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAoaTb' +
    'wXrV7RfY6aA76P0HF+LRQqsHaZYcODzJPwEvqWTQtYVtwK3OLcz4lRIYKm5aTKFWOgO+DrWG7QQo' +
    'Srre0CbB67m81cgRyXXInXOcn62xSzLi07C0l6jg6htZff2tBWnxcKPP/b33WT7bJ8KvhCkm1uJN' +
    'abal/poZR85Z+dZTS1ZfKaEDckvm3ydoO8z5D1r2OdSMDlh+3xNLaI3HvtOpYinTFFiMKuXq144H' +
    'CUoL7fOKgR25SlsetJKKmyCxAk9nHhcNQ1f7JpgVXbFmFN16YuwkCxDKmeNOr/MYe59EEsa8Sa02' +
    'pOxZTiEGOghl1Lu6jLDv9NxyAM30w5vZvA==';

  it('keeps a comma that is part of an attribute value', () => {
    const id = decodeIdentity(COMMA_IN_ORG);
    // Reading the DN as comma-separated text truncates this to `Google\`,
    // which reads as a different organisation than the one on the certificate.
    expect(id?.organization).toBe('Google, Inc.');
    expect(id?.commonName).toBe('Test Signer');
  });

  it('does not let a multi-valued RDN bleed into its neighbour', () => {
    const id = decodeIdentity(COMMA_IN_ORG);
    // `OU=Android+L=Mountain View` is one RDN. Splitting the DN on commas
    // alone would hand back `Android+L=Mountain View` for the OU.
    expect(id?.subject).toContain('Mountain View');
    expect(id?.organization).not.toContain('+');
    expect(id?.organization).not.toContain('\\');
  });

  it('exposes the raw DN unchanged for the tooltip', () => {
    // The escaped form is the canonical RFC 4514 rendering and stays verbatim;
    // only the extracted attributes are decoded. The two are shown together, so
    // they must not silently disagree about which is which.
    const id = decodeIdentity(COMMA_IN_ORG);
    expect(id?.subject).toContain('O=Google\\, Inc.');
  });
});

describe('toCsv', () => {
  it('neutralises device-controlled strings a spreadsheet would run as formulas', () => {
    // Package labels and component names are chosen by whoever built the APK,
    // so an export must not hand a spreadsheet a live formula.
    const csv = toCsv(['label'], [['=HYPERLINK("http://x","y")'], ['+1'], ['-2'], ['@SUM(A1)'], ['\tTab']]);
    const cells = csv.split('\n').slice(1);
    expect(cells).toEqual([
      `"'=HYPERLINK(""http://x"",""y"")"`,
      "'+1",
      "'-2",
      "'@SUM(A1)",
      "'\tTab",
    ]);
  });

  it('leaves genuine numbers numeric and quotes CR as well as LF', () => {
    expect(toCsv(['n', 's'], [[-5, 'a\rb']])).toBe('n,s\n-5,"a\rb"');
  });
});
