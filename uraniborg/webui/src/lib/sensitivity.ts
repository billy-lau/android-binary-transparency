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
 * Sensitivity taxonomy for pregranted permissions.
 *
 * SOURCE OF TRUTH
 * ---------------
 * Every tier below is transcribed from Table 2 ("Permission Mapping to
 * Category and Weight") of *Uraniborg's Preloaded App Risks Scoring Metrics
 * (2020-08) v1.0*, which ships in this repository at `uraniborg/docs/`. The
 * paper's own tier weights are recorded here for traceability only:
 *
 *   ASTRONOMICAL 100 | CRITICAL 10 | HIGH 7.5 | MEDIUM 5 | LOW 2.5 | NONE 0
 *
 * Nothing upstream supplies these tags. Hubble records raw permission name
 * lists and `hubble_parser.py` has no severity table at all, so this file is
 * the only place the mapping exists — keep it in step with the paper, and cite
 * the paper wherever a tier is shown.
 *
 * THE PAPER'S SIXTH TIER
 * ----------------------
 * Table 2 has a sixth category, NONE, at weight 0: ACCESS_NETWORK_STATE,
 * RECEIVE_BOOT_COMPLETED, WAKE_LOCK, FLASHLIGHT and VIBRATE. They are
 * deliberately absent from the table below. A weight of zero means the paper
 * enumerated them and concluded they contribute no risk, so tagging them would
 * inflate every "sensitive permissions" count with permissions that are
 * granted almost universally. `permissionSeverity()` returns null for them,
 * exactly as it does for any permission outside Table 2.
 *
 * SCOPE NOTE
 * ----------
 * This UI deliberately does NOT compute a risk score. The paper's numeric
 * weights and the composite DPAR score are relative to an API-level-matched
 * GSI/AOSP baseline, age quickly as the permission model evolves, and invite
 * false precision. We keep only the qualitative tiers, and use them purely as
 * a sort/filter/triage aid so an analyst can find the interesting packages
 * fast. Every number the UI shows is a directly observed count, never a
 * derived score.
 */

/** Short citation, for badge tooltips and column headers. */
export const SENSITIVITY_SOURCE =
  "Uraniborg's Preloaded App Risks Scoring Metrics (2020-08) v1.0, Table 2";

/** Long form, for the footnote shown under any sensitivity-derived view. */
export const SENSITIVITY_SOURCE_NOTE =
  `Sensitivity tiers are quoted from ${SENSITIVITY_SOURCE} (uraniborg/docs/). ` +
  'The paper\u2019s numeric weights and composite risk score are deliberately not ' +
  'used here \u2014 every number shown is a directly observed count.';

export type PermissionSeverity = 'ASTRONOMICAL' | 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Most to least sensitive; also the sort order used throughout the UI. */
export const SEVERITY_ORDER: PermissionSeverity[] = [
  'ASTRONOMICAL',
  'CRITICAL',
  'HIGH',
  'MEDIUM',
  'LOW',
];

/** Rank used for ordering only (0 = most sensitive). */
export function severityRank(sev: PermissionSeverity | null): number {
  return sev ? SEVERITY_ORDER.indexOf(sev) : SEVERITY_ORDER.length;
}

/**
 * Table 2, verbatim: security-relevant pregranted permissions by tier, in the
 * paper's own row order. Row counts are noted so a future edit that drifts
 * from the source is obvious in review (and is caught by a unit test).
 */
const PERMISSION_TABLE: Record<PermissionSeverity, string[]> = {
  // weight 100 (1 row)
  ASTRONOMICAL: ['android.permission.INSTALL_PACKAGES'],
  // weight 10 (11 rows)
  CRITICAL: [
    'android.permission.COPY_PROTECTED_DATA',
    'android.permission.WRITE_SECURE_SETTINGS',
    'android.permission.READ_FRAME_BUFFER',
    'android.permission.MANAGE_CA_CERTIFICATES',
    'android.permission.MANAGE_APP_OPS_MODES',
    'android.permission.GRANT_RUNTIME_PERMISSIONS',
    'android.permission.DUMP',
    'android.permission.CAMERA',
    'android.permission.SYSTEM_CAMERA',
    'android.permission.MANAGE_PROFILE_AND_DEVICE_OWNERS',
    'android.permission.MOUNT_UNMOUNT_FILESYSTEMS',
  ],
  // weight 7.5 (21 rows)
  HIGH: [
    'android.permission.INSTALL_GRANT_RUNTIME_PERMISSIONS',
    'android.permission.READ_SMS',
    'android.permission.WRITE_SMS',
    'android.permission.RECEIVE_MMS',
    'android.permission.SEND_SMS_NO_CONFIRMATION',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_LOGS',
    'android.permission.READ_PRIVILEGED_PHONE_STATE',
    'android.permission.LOCATION_HARDWARE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
    'android.permission.BIND_ACCESSIBILITY_SERVICE',
    'android.permission.ACCESS_WIFI_STATE',
    'com.android.voicemail.permission.READ_VOICEMAIL',
    'android.permission.RECORD_AUDIO',
    'android.permission.CAPTURE_AUDIO_OUTPUT',
    'android.permission.ACCESS_NOTIFICATIONS',
    'android.permission.INTERACT_ACROSS_USERS_FULL',
    'android.permission.BLUETOOTH_PRIVILEGED',
    'android.permission.GET_PASSWORD',
    'android.permission.INTERNAL_SYSTEM_WINDOW',
  ],
  // weight 5 (16 rows)
  MEDIUM: [
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.CHANGE_COMPONENT_ENABLED_STATE',
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
    'android.permission.CONNECTIVITY_INTERNAL',
    'android.permission.ACCESS_MEDIA_LOCATION',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.SYSTEM_ALERT_WINDOW',
    'android.permission.READ_CALL_LOG',
    'android.permission.WRITE_CALL_LOG',
    'android.permission.INTERACT_ACROSS_USERS',
    'android.permission.MANAGE_USERS',
    'android.permission.READ_CALENDAR',
    'android.permission.BLUETOOTH_ADMIN',
    'android.permission.BODY_SENSORS',
  ],
  // weight 2.5 (7 rows). The paper's next tier down, NONE at weight 0, is
  // intentionally omitted — see the header comment.
  LOW: [
    'android.permission.DOWNLOAD_WITHOUT_NOTIFICATION',
    'android.permission.PACKAGE_USAGE_STATS',
    'android.permission.MASTER_CLEAR',
    'android.permission.DELETE_PACKAGES',
    'android.permission.GET_PACKAGE_SIZE',
    'android.permission.BLUETOOTH',
    'android.permission.DEVICE_POWER',
  ],
};

/**
 * Table 2's weight-0 tier, kept only so the omission above is checkable and so
 * nobody "helpfully" re-adds these as LOW. Not exported as a severity: a zero
 * weight means the paper judged them to carry no risk.
 */
export const ZERO_WEIGHT_PERMISSIONS: string[] = [
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'android.permission.FLASHLIGHT',
  'android.permission.VIBRATE',
];

const SEVERITY_BY_PERMISSION: Map<string, PermissionSeverity> = (() => {
  const m = new Map<string, PermissionSeverity>();
  for (const sev of SEVERITY_ORDER) {
    for (const p of PERMISSION_TABLE[sev]) m.set(p, sev);
  }
  return m;
})();

export function permissionSeverity(name: string): PermissionSeverity | null {
  return SEVERITY_BY_PERMISSION.get(name) ?? null;
}

/** How many of a package's *granted* permissions appear in the table above. */
export function countSensitivePermissions(permissions: string[]): number {
  let n = 0;
  for (const p of permissions) if (SEVERITY_BY_PERMISSION.has(p)) n += 1;
  return n;
}


/** Shared user IDs that grant system-level privilege (see hubble_parser.py). */
export const SYSTEM_SHARED_UIDS = new Set([
  'android.uid.system',
  'android.uid.phone',
  'android.uid.log',
  'android.uid.nfc',
  'android.uid.bluetooth',
  'android.uid.shell',
  'android.uid.se',
  'android.uid.networkstack',
]);
