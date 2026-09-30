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
 * Friendly text for the stable codes in the event stream.
 *
 * The codes come from docs/automate_observation.md (the script) and
 * server/README.md (the helper). The event's own `message` is always shown
 * as detail, so an unknown code still reads sensibly.
 */

import type { BadgeTone } from '@/shared/components/ui';
import type { RunState } from './events';

/** `run_finished.error.reason`, plus the helper's own. */
export const RUN_REASONS: Record<string, string> = {
  unsupported_platform: 'This operating system is not supported.',
  android_sdk_not_found: 'Building Hubble failed: the Android SDK was not found.',
  hubble_build_failed: 'Building Hubble failed.',
  invalid_hubble_apk: 'The Hubble path is not an .apk file.',
  adb_not_found: 'adb is not installed.',
  adb_server_failed: 'The adb server could not be started.',
  adb_devices_failed: '`adb devices` failed.',
  no_devices: 'No device is connected.',
  unexpected_error: 'The script hit an unexpected error.',
  interrupted: 'The run was interrupted.',
  terminated: 'The run was stopped.',
  version_mismatch: 'The script and the helper speak different event versions.',
  no_result: 'The script ended without reporting a result.',
  killed: 'The script did not stop when asked and was killed.',
};

/** `device_finished.error.reason`. */
export const DEVICE_REASONS: Record<string, string> = {
  not_connected: 'Not connected.',
  unauthorized: 'Authorize this computer on the device.',
  uninstall_failed: 'A previous Hubble installation could not be removed.',
  install_failed: 'Hubble could not be installed.',
  launch_failed: 'Hubble could not be launched.',
  no_results: 'Hubble produced no results in time.',
  extract_failed: 'Results could not be pulled from the device.',
  stdin_closed: 'Stopped waiting for the manual Hubble install.',
  inclusion_proof_check_incomplete: 'The inclusion proof check could not complete.',
  unexpected_error: 'Unexpected error while observing this device.',
  interrupted: 'Interrupted.',
  terminated: 'Stopped.',
};

/** `prompt_resolved.outcome`, other than `done`. */
export const PROMPT_OUTCOMES: Record<string, string> = {
  done: 'Done.',
  failed: 'Backup failed.',
  stdin_closed: 'Stopped waiting for input.',
  interrupted: 'Interrupted.',
  terminated: 'Stopped.',
  unexpected_error: 'Ended by an unexpected error.',
};

export const PROMPT_KINDS: Record<string, string> = {
  xiaomi_manual_install: 'Manual Hubble install',
  adb_backup_confirm: 'Backup confirmation',
};

export const STEP_LABELS: Record<string, string> = {
  build_hubble: 'Build Hubble',
  verify_hubble: 'Check Hubble APK',
  check_adb: 'Find adb',
  start_adb_server: 'Start adb server',
  list_devices: 'List devices',
  uninstall_previous: 'Remove previous Hubble',
  install_hubble: 'Install Hubble',
  launch_hubble: 'Launch Hubble',
  wait_for_results: 'Wait for results',
  extract_results: 'Pull results',
  extract_selinux: 'Pull SELinux policy',
  inclusion_proof_prefetch: 'Pre-fetch log entries',
  inclusion_proof_check: 'Inclusion proof check',
};

/**
 * What `step_progress` counts, per step: "120 of 314 APK splits checked". A
 * step not listed here shows a bare "120 of 314".
 */
export const STEP_PROGRESS_UNITS: Record<string, string> = {
  inclusion_proof_check: 'APK splits checked',
};

export const DEVICE_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  running: { label: 'Running', tone: 'accent' },
  success: { label: 'Success', tone: 'good' },
  partial_check_incomplete: { label: 'Check incomplete', tone: 'warn' },
  partial_error: { label: 'Partial (error)', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
};

export const RUN_STATE: Record<RunState, { label: string; tone: BadgeTone }> = {
  running: { label: 'Running', tone: 'accent' },
  succeeded: { label: 'Succeeded', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'warn' },
};

export function describe(table: Record<string, string>, code: string | undefined): string | undefined {
  if (!code) return undefined;
  return table[code] ?? code.replace(/_/g, ' ');
}
