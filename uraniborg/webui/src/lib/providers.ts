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
 * ContentProvider access semantics.
 *
 * A provider is the only component type with two independent permission gates,
 * and the raw pair Hubble records — `permissionRead` / `permissionWrite` — is
 * easy to misread in two opposite directions.
 *
 * First, an absent permission looks like missing data. It is not. Android's
 * manifest parser folds `android:permission` into *both*
 * `ProviderInfo.readPermission` and `ProviderInfo.writePermission` when the
 * finer-grained attributes are absent, and Hubble reads those resolved fields
 * rather than the raw manifest. So a null here means no component-level
 * permission is enforced at all — not that the observation failed to record
 * one, and not that a blanket `android:permission` is quietly covering it.
 *
 * Second, an absent permission looks uniformly alarming. It is only reachable
 * by other apps when the provider is exported and enabled. On an unexported
 * provider the same null is unremarkable, because a caller has to already be
 * running in the same UID.
 *
 * Both gates are therefore described as *who can perform the operation*,
 * rather than as the presence or absence of a string.
 */

import { shortPermission } from './format';
import type { ExportedComponentRef } from './model';

export type ProviderOp = 'read' | 'write' | 'both';

/** Display text for each gate's operation. */
export const PROVIDER_OP_LABEL: Record<ProviderOp, string> = {
  read: 'read',
  write: 'write',
  both: 'read/write',
};

export type ProviderReach =
  /** A permission is enforced; only holders of it can perform the operation. */
  | 'guarded'
  /** Exported, enabled and unguarded: any app on the device can do this. */
  | 'any-app'
  /** Unguarded, but unreachable from outside the app's own UID. */
  | 'internal';

/** Badge tones, kept as literals so `lib` does not depend on `components`. */
export const PROVIDER_REACH_TONE: Record<ProviderReach, 'neutral' | 'bad'> = {
  guarded: 'neutral',
  'any-app': 'bad',
  internal: 'neutral',
};

/** What each gate actually controls, in ContentResolver terms. */
const OP_VERB: Record<'read' | 'write', string> = {
  read: 'query',
  write: 'insert, update and delete',
};

export interface ProviderGate {
  op: ProviderOp;
  /** The permission enforced, or null when none is. */
  permission: string | null;
  reach: ProviderReach;
  /** Short display text: a permission name, or who can reach the operation. */
  label: string;
  /** Full sentence for a tooltip. */
  title: string;
}

function gate(
  op: 'read' | 'write',
  permission: string | null | undefined,
  exposed: boolean,
): ProviderGate {
  const verb = OP_VERB[op];
  if (permission) {
    return {
      op,
      permission,
      reach: 'guarded',
      label: shortPermission(permission),
      title: `Callers must hold ${permission} to ${verb} through this provider.`,
    };
  }
  if (exposed) {
    return {
      op,
      permission: null,
      reach: 'any-app',
      label: 'any app',
      title:
        `No ${op} permission is enforced and the provider is exported, so any app ` +
        `on the device can ${verb} through it. Android would have used ` +
        `android:permission here had one been declared, so nothing is guarding it.`,
    };
  }
  return {
    op,
    permission: null,
    reach: 'internal',
    label: 'not enforced',
    title:
      `No ${op} permission is enforced, but the provider is not exported, so only ` +
      `code running in this app's own UID can ${verb} through it.`,
  };
}

/**
 * The read and write gates for a provider, in that order.
 *
 * Always two entries, so callers reasoning about exposure do not have to
 * special-case the collapsed form below.
 */
export function providerGates(c: ExportedComponentRef): ProviderGate[] {
  const exposed = c.isExported && c.isEnabled;
  return [gate('read', c.permissionRead, exposed), gate('write', c.permissionWrite, exposed)];
}

/**
 * The same gates, collapsed to one entry when read and write agree.
 *
 * Most providers guard both operations identically, and printing that twice
 * buries the case worth noticing. Collapsing it means a provider showing two
 * entries is, at a glance, one whose read and write differ.
 */
export function providerGateSummary(c: ExportedComponentRef): ProviderGate[] {
  const [read, write] = providerGates(c);
  if (read.reach !== write.reach || read.permission !== write.permission) {
    return [read, write];
  }
  const verb = 'read and write';
  return [
    {
      ...read,
      op: 'both',
      title: read.permission
        ? `Callers must hold ${read.permission} to ${verb} through this provider.`
        : read.reach === 'any-app'
          ? `No permission is enforced and the provider is exported, so any app on the ` +
            `device can ${verb} through it. Android would have used android:permission ` +
            `here had one been declared, so nothing is guarding it.`
          : `No permission is enforced, but the provider is not exported, so only code ` +
            `running in this app's own UID can ${verb} through it.`,
    },
  ];
}

/**
 * Things that stop the two gates above from being the whole story.
 *
 * Neither is a verdict on its own; both change what an unguarded provider is
 * worth investigating for, so they are stated rather than folded into the
 * reach.
 */
export function providerCaveats(c: ExportedComponentRef): string[] {
  const out: string[] = [];
  if (c.pathPermissionCount) {
    out.push(
      `${c.pathPermissionCount} path permission${c.pathPermissionCount === 1 ? '' : 's'} ` +
        `override the provider-wide guard for specific URI paths, in either direction.`,
    );
  }
  if (c.grantUriPermissions) {
    out.push(
      'grantUriPermissions is set: the app can hand a caller temporary access to a ' +
        'specific URI even when that caller holds none of the permissions above.',
    );
  }
  return out;
}

/** Legend for the provider list, explaining the pair once instead of per row. */
export const PROVIDER_GUARD_LEGEND =
  'read and write are the permissions a caller must hold to query versus modify ' +
  'this provider. A provider-wide android:permission counts as both, so “any app” ' +
  'means nothing is enforced rather than nothing was recorded.';
