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
 * Observe form options -> automate_observation.py arguments, in the browser.
 *
 * A mirror of `server/options.py` (normalize() and build_argv()) for instant
 * feedback and for building a command line when the helper is not running.
 * The Python side is authoritative: when the helper is up, its
 * `/api/validate` answer wins. `options.test.ts` runs the same
 * `server/tests/option_cases.json` as `test_options.py`, so the two cannot
 * drift apart.
 *
 * Two deliberate differences, both only when the helper is not running:
 *   - `~` cannot be expanded in the browser, so it is refused (the helper
 *     expands it with its own home directory).
 *   - there is no known default output directory, so a blank output leaves
 *     `--output` out and the script writes to `./results`.
 */

export const DEFAULT_PREFETCH_CONCURRENCY = 16;
export const DEFAULT_PREFETCH_TIMEOUT = 600;
export const PREFETCH_CONCURRENCY_RANGE: [number, number] = [1, 64];
export const PREFETCH_TIMEOUT_RANGE: [number, number] = [1, 3600];

export const PULL_APKS = ['none', 'all', 'preinstalled'] as const;
export const HUBBLE_MODES = ['rebuild', 'apk'] as const;
const MAX_SERIALS = 64;
const MAX_SERIAL_LENGTH = 128;
const MAX_PATH_LENGTH = 4096;

const TOP_KEYS = ['serials', 'hubble', 'output', 'debug', 'pullApks', 'inclusionProof'];
const HUBBLE_KEYS = ['mode', 'path'];
const PROOF_KEYS = [
  'enabled',
  'verifierPath',
  'preinstalledOnly',
  'noPrefetch',
  'cacheDir',
  'prefetchConcurrency',
  'prefetchTimeout',
];

export type PullApks = (typeof PULL_APKS)[number];
export type HubbleMode = (typeof HUBBLE_MODES)[number];

/** Field path (e.g. `inclusionProof.verifierPath`) -> message. `''` is the whole object. */
export type FieldErrors = Record<string, string>;

export interface NormalizedOptions {
  serials: string[];
  hubble: { mode: 'rebuild' } | { mode: 'apk'; path: string };
  /** `''` only without the helper: leave `--output` out. */
  output: string;
  debug: boolean;
  pullApks: PullApks;
  inclusionProof:
    | { enabled: false }
    | {
        enabled: true;
        verifierPath: string;
        preinstalledOnly: boolean;
        noPrefetch: boolean;
        cacheDir: string | null;
        prefetchConcurrency?: number;
        prefetchTimeout?: number;
      };
}

export interface NormalizeSettings {
  /** Accept a leading `~`, as the helper expands it. Default true, like Python. */
  tildeOk?: boolean;
}

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownKeys(obj: Obj, allowed: string[], prefix: string, errors: FieldErrors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors[prefix + key] = 'Unknown option.';
  }
}

function bool(obj: Obj, key: string, field: string, errors: FieldErrors): boolean {
  const value = obj[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') {
    errors[field] = 'Must be true or false.';
    return false;
  }
  return value;
}

function pathValue(
  obj: Obj,
  key: string,
  field: string,
  errors: FieldErrors,
  required: boolean,
  settings: NormalizeSettings,
): string | null {
  const value = obj[key];
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    if (required) errors[field] = 'Required.';
    return null;
  }
  if (typeof value !== 'string') {
    errors[field] = 'Must be a path.';
    return null;
  }
  // Python counts code points, not UTF-16 units.
  if (value.includes('\0') || [...value].length > MAX_PATH_LENGTH) {
    errors[field] = 'Not a valid path.';
    return null;
  }
  if (value.startsWith('~')) {
    if (settings.tildeOk ?? true) return value;
    errors[field] = 'Use a full path: only the helper can expand ~.';
    return null;
  }
  if (!value.startsWith('/')) {
    errors[field] = 'Use an absolute path.';
    return null;
  }
  return value;
}

function int(
  obj: Obj,
  key: string,
  field: string,
  errors: FieldErrors,
  fallback: number,
  [low, high]: [number, number],
): number {
  const value = obj[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors[field] = 'Must be a whole number.';
    return fallback;
  }
  if (value < low || value > high) {
    errors[field] = `Must be between ${low} and ${high}.`;
    return fallback;
  }
  return value;
}

function serialList(raw: unknown, errors: FieldErrors): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    errors.serials = 'Must be a list of serials.';
    return [];
  }
  if (raw.length > MAX_SERIALS) {
    errors.serials = `At most ${MAX_SERIALS} devices.`;
    return [];
  }
  const serials: string[] = [];
  for (const serial of raw) {
    // adb serials are printable ASCII without whitespace (USB serials,
    // host:port, mDNS service names).
    if (
      typeof serial !== 'string' ||
      !serial ||
      serial.length > MAX_SERIAL_LENGTH ||
      [...serial].some((c) => c < '!' || c > '~')
    ) {
      errors.serials = `Not a valid device serial: ${JSON.stringify(serial)}.`;
      return [];
    }
    if (serials.includes(serial)) {
      errors.serials = `Device ${serial} is listed twice.`;
      return [];
    }
    serials.push(serial);
  }
  return serials;
}

/**
 * Checks raw options and fills in defaults, exactly like `options.normalize()`.
 *
 * Fields that the current choices make irrelevant are dropped without being
 * validated: the form hides them, so the user cannot fix them.
 */
export function normalize(
  raw: unknown,
  defaultOutput: string,
  settings: NormalizeSettings = {},
): { options: NormalizedOptions | null; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (!isObject(raw)) return { options: null, errors: { '': 'Options must be a JSON object.' } };
  unknownKeys(raw, TOP_KEYS, '', errors);

  // Only null means "absent"; false, "" or [] are wrong types, not defaults.
  const hubbleRaw = raw.hubble === undefined || raw.hubble === null ? { mode: 'rebuild' } : raw.hubble;
  let hubble: NormalizedOptions['hubble'] = { mode: 'rebuild' };
  if (!isObject(hubbleRaw)) {
    errors.hubble = 'Must be an object.';
  } else {
    unknownKeys(hubbleRaw, HUBBLE_KEYS, 'hubble.', errors);
    const mode = hubbleRaw.mode === undefined ? 'rebuild' : hubbleRaw.mode;
    if (!HUBBLE_MODES.includes(mode as HubbleMode)) {
      errors['hubble.mode'] = `Must be one of: ${HUBBLE_MODES.join(', ')}.`;
    } else if (mode === 'apk') {
      hubble = {
        mode: 'apk',
        path: pathValue(hubbleRaw, 'path', 'hubble.path', errors, true, settings) ?? '',
      };
    }
  }

  let pull = raw.pullApks === undefined || raw.pullApks === null ? 'none' : raw.pullApks;
  if (!PULL_APKS.includes(pull as PullApks)) {
    errors.pullApks = `Must be one of: ${PULL_APKS.join(', ')}.`;
    pull = 'none';
  }

  const proofRaw = raw.inclusionProof === undefined || raw.inclusionProof === null ? {} : raw.inclusionProof;
  let proof: NormalizedOptions['inclusionProof'] = { enabled: false };
  if (!isObject(proofRaw)) {
    errors.inclusionProof = 'Must be an object.';
  } else {
    unknownKeys(proofRaw, PROOF_KEYS, 'inclusionProof.', errors);
    if (bool(proofRaw, 'enabled', 'inclusionProof.enabled', errors)) {
      const p = 'inclusionProof.';
      const enabled = {
        enabled: true as const,
        verifierPath: pathValue(proofRaw, 'verifierPath', p + 'verifierPath', errors, true, settings) ?? '',
        preinstalledOnly: bool(proofRaw, 'preinstalledOnly', p + 'preinstalledOnly', errors),
        noPrefetch: bool(proofRaw, 'noPrefetch', p + 'noPrefetch', errors),
        cacheDir: pathValue(proofRaw, 'cacheDir', p + 'cacheDir', errors, false, settings),
        prefetchConcurrency: undefined as number | undefined,
        prefetchTimeout: undefined as number | undefined,
      };
      if (!enabled.noPrefetch) {
        enabled.prefetchConcurrency = int(
          proofRaw,
          'prefetchConcurrency',
          p + 'prefetchConcurrency',
          errors,
          DEFAULT_PREFETCH_CONCURRENCY,
          PREFETCH_CONCURRENCY_RANGE,
        );
        enabled.prefetchTimeout = int(
          proofRaw,
          'prefetchTimeout',
          p + 'prefetchTimeout',
          errors,
          DEFAULT_PREFETCH_TIMEOUT,
          PREFETCH_TIMEOUT_RANGE,
        );
      }
      proof = enabled;
    }
  }

  const options: NormalizedOptions = {
    serials: serialList(raw.serials, errors),
    hubble,
    output: pathValue(raw, 'output', 'output', errors, false, settings) ?? defaultOutput,
    debug: bool(raw, 'debug', 'debug', errors),
    pullApks: pull as PullApks,
    inclusionProof: proof,
  };
  return { options, errors };
}

/** automate_observation.py arguments for normalized options, like `options.build_argv()`. */
export function buildArgv(options: NormalizedOptions): string[] {
  const argv = options.serials.map((s) => `--serial=${s}`);
  if (options.hubble.mode === 'apk') argv.push(`--hubble=${options.hubble.path}`);
  if (options.output) argv.push(`--output=${options.output}`);
  if (options.debug) argv.push('--debug');
  if (options.pullApks === 'all') argv.push('--pull-all-apks');
  else if (options.pullApks === 'preinstalled') argv.push('--pull-preinstalled-apks-only');
  const proof = options.inclusionProof;
  if (proof.enabled) {
    argv.push('--perform_inclusion_proof_check', `--verifier_path=${proof.verifierPath}`);
    if (proof.preinstalledOnly) argv.push('--check_preinstalled_only');
    if (proof.noPrefetch) argv.push('--no_prefetch');
    if (proof.cacheDir) argv.push(`--cache_dir=${proof.cacheDir}`);
    const concurrency = proof.prefetchConcurrency ?? DEFAULT_PREFETCH_CONCURRENCY;
    if (concurrency !== DEFAULT_PREFETCH_CONCURRENCY) argv.push(`--cache_prefetch_concurrency=${concurrency}`);
    const timeout = proof.prefetchTimeout ?? DEFAULT_PREFETCH_TIMEOUT;
    if (timeout !== DEFAULT_PREFETCH_TIMEOUT) argv.push(`--cache_prefetch_timeout=${timeout}`);
  }
  return argv;
}

export interface ClientValidation {
  ok: boolean;
  /** Filled in once the options are well-formed, like `/api/validate`. */
  argv: string[];
  errors: FieldErrors;
}

export function validateClient(
  raw: unknown,
  defaultOutput: string,
  settings: NormalizeSettings = {},
): ClientValidation {
  const { options, errors } = normalize(raw, defaultOutput, settings);
  const ok = Object.keys(errors).length === 0;
  return { ok, argv: ok && options ? buildArgv(options) : [], errors };
}

// --- The form ------------------------------------------------------------------

/** What the form edits. Text fields stay text so half-typed numbers survive. */
export interface ObserveForm {
  serials: string[];
  hubbleMode: HubbleMode;
  hubblePath: string;
  /** Blank means the default output directory. */
  output: string;
  debug: boolean;
  pullApks: PullApks;
  proofEnabled: boolean;
  verifierPath: string;
  preinstalledOnly: boolean;
  noPrefetch: boolean;
  cacheDir: string;
  /** Blank means the default. */
  prefetchConcurrency: string;
  /** Blank means the default. */
  prefetchTimeout: string;
}

export const DEFAULT_FORM: ObserveForm = {
  serials: [],
  hubbleMode: 'rebuild',
  hubblePath: '',
  output: '',
  debug: false,
  pullApks: 'none',
  proofEnabled: false,
  verifierPath: '',
  preinstalledOnly: false,
  noPrefetch: false,
  cacheDir: '',
  prefetchConcurrency: '',
  prefetchTimeout: '',
};

/** A whole number stays a number; anything else is sent as typed, to be rejected. */
function numberField(text: string): number | string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * The options body for `/api/validate` and `/api/runs`.
 *
 * Only what the current choices make relevant is sent, mirroring what the
 * form shows: no APK path when rebuilding, nothing under a disabled
 * inclusion proof check, no pre-fetch tuning with pre-fetching off.
 */
export function formToOptions(form: ObserveForm): Record<string, unknown> {
  const options: Record<string, unknown> = {
    serials: form.serials,
    hubble: form.hubbleMode === 'apk' ? { mode: 'apk', path: form.hubblePath } : { mode: 'rebuild' },
    debug: form.debug,
    pullApks: form.pullApks,
  };
  if (form.output.trim()) options.output = form.output.trim();
  if (form.proofEnabled) {
    const proof: Record<string, unknown> = {
      enabled: true,
      verifierPath: form.verifierPath,
      preinstalledOnly: form.preinstalledOnly,
      noPrefetch: form.noPrefetch,
    };
    if (form.cacheDir.trim()) proof.cacheDir = form.cacheDir.trim();
    if (!form.noPrefetch) {
      const concurrency = numberField(form.prefetchConcurrency);
      const timeout = numberField(form.prefetchTimeout);
      if (concurrency !== undefined) proof.prefetchConcurrency = concurrency;
      if (timeout !== undefined) proof.prefetchTimeout = timeout;
    }
    options.inclusionProof = proof;
  } else {
    options.inclusionProof = { enabled: false };
  }
  return options;
}

// --- Command line ------------------------------------------------------------------

const SHELL_SAFE = /^[A-Za-z0-9_\-.,:/=@%+]+$/;

/** Quotes one argument for a POSIX shell. */
export function shellQuote(arg: string): string {
  if (SHELL_SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** A command a person can paste into a terminal. */
export function commandLine(script: string, argv: string[]): string {
  return ['python3', script, ...argv].map(shellQuote).join(' ');
}
