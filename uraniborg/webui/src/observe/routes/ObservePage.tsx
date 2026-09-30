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
 * `/observe`: the form that builds an automate_observation.py run.
 *
 * With the helper connected it lists devices and starts the run. Without it,
 * the same form still builds the command line to paste into a terminal.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Loader2, Play, Plus, RefreshCw, RotateCcw, Terminal } from 'lucide-react';
import clsx from 'clsx';
import { Card, CopyButton, PageHeader } from '@/shared/components/ui';
import { useObserve, type HelperStatus } from '@/observe/store';
import { ApiError, api, type AdbDevice, type Health, type ServerValidation } from '@/observe/lib/api';
import {
  DEFAULT_PREFETCH_CONCURRENCY,
  DEFAULT_PREFETCH_TIMEOUT,
  commandLine,
  formToOptions,
  validateClient,
  type ObserveForm,
  type PullApks,
} from '@/observe/lib/options';
import { DEVICE_REASONS } from '@/observe/lib/reasons';
import { PathField } from '@/observe/components/PathField';
import { VerifierSetup } from '@/observe/components/VerifierSetup';

const SCRIPT_NAME = 'automate_observation.py';

function dirname(path: string): string {
  return path.replace(/\/[^/]*\/?$/, '') || '/';
}

/** Error keys shown next to a field; anything else is listed under the command. */
const FIELD_KEYS = new Set([
  'serials',
  'hubble.path',
  'output',
  'inclusionProof.verifierPath',
  'inclusionProof.cacheDir',
  'inclusionProof.prefetchConcurrency',
  'inclusionProof.prefetchTimeout',
]);

export function ObservePage() {
  const helper = useObserve((s) => s.helper);
  const form = useObserve((s) => s.form);
  const setForm = useObserve((s) => s.setForm);
  const resetForm = useObserve((s) => s.resetForm);
  const checkHelper = useObserve((s) => s.checkHelper);
  const navigate = useNavigate();

  useEffect(() => {
    void checkHelper();
  }, [checkHelper]);

  const health = helper.kind === 'connected' ? helper.health : null;
  const options = useMemo(() => formToOptions(form), [form]);
  // Without the helper there is no home directory to expand `~` against and
  // no known default output directory; see options.ts.
  const client = useMemo(
    () => validateClient(options, health?.defaults.output ?? '', { tildeOk: !!health }),
    [options, health],
  );
  const server = useServerValidation(options, !!health);
  const checked = server.result ?? client;
  const errors = checked.errors;
  const warnings = server.result?.warnings ?? [];
  const otherErrors = Object.entries(errors).filter(([key]) => !FIELD_KEYS.has(key));
  const command = checked.ok ? commandLine(health?.scriptPath ?? SCRIPT_NAME, checked.argv) : null;

  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ReactNode>(null);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { id } = await api.startRun(options);
      navigate(`/observe/runs/${id}`);
    } catch (err) {
      const e = err as ApiError;
      if (e.reason === 'invalid_options') {
        server.set({
          ok: false,
          argv: [],
          errors: (e.body.errors as Record<string, string> | undefined) ?? {},
          warnings: (e.body.warnings as string[] | undefined) ?? [],
        });
        setStartError('Some options are not valid. See the highlighted fields.');
      } else if (e.reason === 'busy') {
        const active = e.body.activeRun as string | undefined;
        setStartError(
          <>
            Another run is still in progress.{' '}
            {active && (
              <Link className="link" to={`/observe/runs/${active}`}>
                View it
              </Link>
            )}
          </>,
        );
        void checkHelper();
      } else {
        setStartError(e.message);
      }
    } finally {
      setStarting(false);
    }
  };

  const activeRun = health?.activeRun;
  const canRun = !!health && health.scriptFound && checked.ok && !activeRun && !starting;

  return (
    <div>
      <PageHeader
        title="Observe a device"
        subtitle={
          <>
            Runs <span className="mono">{SCRIPT_NAME}</span>: installs Hubble on each device, collects its results and
            pulls them to this computer.
          </>
        }
        actions={
          <button type="button" className="btn" onClick={resetForm} title="Forget the remembered form values">
            <RotateCcw size={13} />
            Reset form
          </button>
        }
      />

      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
        <HelperBanner helper={helper} onRetry={checkHelper} />

        <DevicesCard
          health={health}
          serials={form.serials}
          onChange={(serials) => setForm({ serials })}
          error={errors.serials}
        />

        <HubbleCard form={form} health={health} setForm={setForm} error={errors['hubble.path']} />

        <Card title="Output">
          <div className="flex flex-col gap-4 p-4">
            <Field
              label="Results directory"
              error={errors.output}
              hint={
                health
                  ? 'Leave blank for the default shown.'
                  : 'Leave blank to write to results/ under the directory you run the script from.'
              }
            >
              <PathField
                value={form.output}
                placeholder={health?.defaults.output ?? 'results/'}
                onChange={(output) => setForm({ output })}
                browse={
                  health
                    ? { mode: 'dir', title: 'Choose the results folder', fallbackStart: health.defaults.output }
                    : undefined
                }
              />
            </Field>
            <Check
              checked={form.debug}
              onChange={(debug) => setForm({ debug })}
              label="Debug logging"
              hint="More detail in the log, useful when something goes wrong."
            />
            <fieldset>
              <legend className="label mb-1.5">APK extraction</legend>
              <div className="flex flex-col gap-1.5">
                {(
                  [
                    ['none', 'Don’t pull APKs'],
                    ['all', 'Pull all APKs'],
                    ['preinstalled', 'Pull pre-installed APKs only'],
                  ] as Array<[PullApks, string]>
                ).map(([value, label]) => (
                  <Radio
                    key={value}
                    name="pullApks"
                    checked={form.pullApks === value}
                    onChange={() => setForm({ pullApks: value })}
                    label={label}
                  />
                ))}
              </div>
            </fieldset>
          </div>
        </Card>

        <ProofCard form={form} health={health} setForm={setForm} errors={errors} />

        <Card
          title={
            <span className="flex items-center gap-2">
              <Terminal size={14} />
              Command
            </span>
          }
          actions={command && <CopyButton value={command} label="Copy" />}
        >
          <div className="flex flex-col gap-3 p-4">
            {command ? (
              <pre className="mono whitespace-pre-wrap break-all rounded-md border border-line bg-bg px-3 py-2 text-ink">
                {command}
              </pre>
            ) : (
              <p className="text-sm text-ink-muted">Fix the highlighted fields to see the command.</p>
            )}
            {!health && command && (
              <p className="text-xs text-ink-faint">
                Run it from <span className="mono">uraniborg/scripts/python</span>, or give the script’s full path.
              </p>
            )}
            {otherErrors.length > 0 && (
              <ul className="space-y-1 text-xs text-sev-critical">
                {otherErrors.map(([key, message]) => (
                  <li key={key}>
                    {key && <span className="mono">{key}: </span>}
                    {message}
                  </li>
                ))}
              </ul>
            )}
            {warnings.length > 0 && (
              <ul className="space-y-1 text-xs text-sev-high">
                {warnings.map((w) => (
                  <li key={w} className="flex items-start gap-1.5">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          {activeRun ? (
            <Link className="btn btn-primary" to={`/observe/runs/${activeRun}`}>
              <Loader2 size={14} className="animate-spin" />A run is in progress: view it
            </Link>
          ) : health ? (
            <button type="button" className="btn btn-primary" disabled={!canRun} onClick={start}>
              {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              Run
            </button>
          ) : (
            command && <CopyButton value={command} label="Copy command" className="btn-primary" />
          )}
          {health && !health.scriptFound && (
            <span className="text-xs text-sev-critical">
              The helper cannot find <span className="mono">{health.scriptPath}</span>.
            </span>
          )}
          {startError && <span className="text-xs text-sev-critical">{startError}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * `/api/validate` for the current options, 300 ms after the last change.
 *
 * The result only counts while it still describes the current options;
 * until the answer for the latest edit arrives, the caller falls back to the
 * client-side check.
 */
function useServerValidation(options: Record<string, unknown>, enabled: boolean) {
  const key = JSON.stringify(options);
  const [answer, setAnswer] = useState<{ key: string; value: ServerValidation } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api
        .validate(JSON.parse(key), controller.signal)
        .then((value) => setAnswer({ key, value }))
        .catch(() => {
          /* the client check stands in; the Run request validates again */
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [key, enabled]);

  const set = useCallback((value: ServerValidation) => setAnswer({ key, value }), [key]);
  return { result: enabled && answer?.key === key ? answer.value : null, set };
}

// --- Helper banner -------------------------------------------------------------

function HelperBanner({ helper, onRetry }: { helper: HelperStatus; onRetry: () => void }) {
  if (helper.kind === 'checking') {
    return (
      <Banner tone="neutral" icon={<Loader2 size={16} className="animate-spin" />}>
        Looking for the helper…
      </Banner>
    );
  }
  if (helper.kind === 'connected') {
    const h = helper.health;
    return (
      <Banner tone="good" icon={<CheckCircle2 size={16} />}>
        <div className="font-medium text-ink">Helper connected</div>
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-ink-faint">Script</dt>
          <dd className={clsx('mono break-all', !h.scriptFound && 'text-sev-critical')}>
            {h.scriptPath}
            {!h.scriptFound && ' (not found)'}
          </dd>
          <dt className="text-ink-faint">adb</dt>
          <dd className={clsx('mono break-all', !h.adbPath && 'text-sev-high')}>{h.adbPath ?? 'not found on PATH'}</dd>
          <dt className="text-ink-faint">Host</dt>
          <dd>
            {h.platform}, Python {h.python}
          </dd>
        </dl>
      </Banner>
    );
  }
  const retry = (
    <button type="button" className="btn mt-2" onClick={onRetry}>
      <RefreshCw size={13} />
      Try again
    </button>
  );
  if (helper.kind === 'error') {
    return (
      <Banner tone="bad" icon={<AlertTriangle size={16} />}>
        <div className="font-medium text-ink">{helper.badToken ? 'The helper refused this page' : 'Helper problem'}</div>
        <p className="mt-0.5">
          {helper.badToken
            ? 'The helper makes a new link each time it starts. Open the link it printed most recently.'
            : helper.message}
        </p>
        {!helper.badToken && retry}
      </Banner>
    );
  }
  return (
    <Banner tone="neutral" icon={<Terminal size={16} />}>
      <div className="font-medium text-ink">Helper not running: you can still build a command line</div>
      <p className="mt-0.5">
        Fill in the form and copy the command below into a terminal. To run from this page instead, start the helper
        with <span className="mono">npm run helper</span> in <span className="mono">uraniborg/webui</span> and open the
        link it prints.
      </p>
    </Banner>
  );
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: 'neutral' | 'good' | 'bad';
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex gap-3 rounded-lg border px-4 py-3 text-sm text-ink-muted',
        tone === 'good' && 'border-sev-ok/30 bg-sev-ok/5',
        tone === 'bad' && 'border-sev-critical/40 bg-sev-critical/5',
        tone === 'neutral' && 'border-line bg-bg-soft',
      )}
    >
      <span
        className={clsx(
          'mt-0.5 shrink-0',
          tone === 'good' && 'text-sev-ok',
          tone === 'bad' && 'text-sev-critical',
          tone === 'neutral' && 'text-ink-faint',
        )}
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// --- Devices -------------------------------------------------------------------

type DeviceList =
  | { kind: 'idle' }
  | { kind: 'loading'; devices: AdbDevice[] }
  | { kind: 'ok'; devices: AdbDevice[] }
  | { kind: 'error'; message: string };

const STATE_NOTES: Record<string, string> = {
  unauthorized: DEVICE_REASONS.unauthorized,
  offline: 'Offline.',
  'no permissions': 'No USB permission for this device.',
};

function DevicesCard({
  health,
  serials,
  onChange,
  error,
}: {
  health: Health | null;
  serials: string[];
  onChange: (serials: string[]) => void;
  error?: string;
}) {
  const [list, setList] = useState<DeviceList>({ kind: 'idle' });
  const [manual, setManual] = useState('');
  const connected = !!health;

  const refresh = useCallback(async () => {
    setList((l) => ({ kind: 'loading', devices: l.kind === 'ok' || l.kind === 'loading' ? l.devices : [] }));
    try {
      setList({ kind: 'ok', devices: await api.devices() });
    } catch (err) {
      setList({ kind: 'error', message: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (connected) void refresh();
    else setList({ kind: 'idle' });
  }, [connected, refresh]);

  const devices = list.kind === 'ok' || list.kind === 'loading' ? list.devices : [];
  const known = new Set(devices.map((d) => d.serial));
  const extra = serials.filter((s) => !known.has(s));
  const toggle = (serial: string, on: boolean) =>
    onChange(on ? [...serials, serial] : serials.filter((s) => s !== serial));

  const addManual = () => {
    const serial = manual.trim();
    if (serial && !serials.includes(serial)) onChange([...serials, serial]);
    setManual('');
  };

  return (
    <Card
      title="Devices"
      actions={
        connected && (
          <button type="button" className="btn" onClick={refresh} disabled={list.kind === 'loading'}>
            <RefreshCw size={13} className={clsx(list.kind === 'loading' && 'animate-spin')} />
            Refresh
          </button>
        )
      }
    >
      <div className="flex flex-col gap-3 p-4">
        {list.kind === 'error' && <p className="text-sm text-sev-critical">{list.message}</p>}
        {list.kind === 'ok' && devices.length === 0 && (
          <p className="text-sm text-ink-muted">No device is connected. Plug one in, then refresh.</p>
        )}
        {(devices.length > 0 || extra.length > 0) && (
          <ul className="flex flex-col divide-y divide-line/60 rounded-md border border-line">
            {devices.map((d) => {
              const usable = d.state === 'device';
              const checked = serials.includes(d.serial);
              return (
                <li key={d.serial} className="px-3 py-2">
                  <Check
                    checked={checked}
                    disabled={!usable && !checked}
                    onChange={(on) => toggle(d.serial, on)}
                    label={
                      <>
                        <span className="text-ink">{d.model?.replace(/_/g, ' ') ?? d.serial}</span>{' '}
                        <span className="mono text-ink-faint">{d.serial}</span>
                      </>
                    }
                    hint={usable ? undefined : (STATE_NOTES[d.state] ?? d.state)}
                    hintTone="warn"
                  />
                </li>
              );
            })}
            {extra.map((serial) => (
              <li key={serial} className="px-3 py-2">
                <Check
                  checked
                  onChange={() => toggle(serial, false)}
                  label={<span className="mono text-ink">{serial}</span>}
                  hint={connected ? 'Not connected right now.' : undefined}
                  hintTone="warn"
                />
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addManual();
          }}
        >
          <input
            className="input mono"
            spellCheck={false}
            placeholder="Add a serial by hand, e.g. emulator-5554"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button type="submit" className="btn shrink-0" disabled={!manual.trim()}>
            <Plus size={13} />
            Add
          </button>
        </form>
        {error ? (
          <p className="text-xs text-sev-critical">{error}</p>
        ) : (
          <p className="text-xs text-ink-faint">
            {serials.length === 0
              ? 'Nothing selected: the script observes every connected device.'
              : `${serials.length} selected. The selection is not remembered.`}
          </p>
        )}
      </div>
    </Card>
  );
}

// --- Hubble --------------------------------------------------------------------

function HubbleCard({
  form,
  health,
  setForm,
  error,
}: {
  form: ObserveForm;
  health: Health | null;
  setForm: (patch: Partial<ObserveForm>) => void;
  error?: string;
}) {
  const latest = health?.defaults.hubbleLatest;
  return (
    <Card title="Hubble APK">
      <div className="flex flex-col gap-2 p-4">
        <Radio
          name="hubble"
          checked={form.hubbleMode === 'rebuild'}
          onChange={() => setForm({ hubbleMode: 'rebuild' })}
          label="Build from source"
          hint="Needs the Android SDK. Slower, but always matches the checked-out code."
        />
        <Radio
          name="hubble"
          checked={form.hubbleMode === 'apk'}
          onChange={() => setForm({ hubbleMode: 'apk' })}
          label="Use an existing APK"
        />
        {form.hubbleMode === 'apk' && (
          <div className="ml-6 flex flex-col gap-2">
            <Field error={error}>
              <PathField
                value={form.hubblePath}
                placeholder="/path/to/hubble.apk"
                onChange={(hubblePath) => setForm({ hubblePath })}
                browse={
                  health
                    ? {
                        mode: 'file',
                        title: 'Choose the Hubble APK',
                        looksRight: (e) => e.name.endsWith('.apk'),
                        fallbackStart: latest ? dirname(latest) : undefined,
                      }
                    : undefined
                }
              />
            </Field>
            {latest && form.hubblePath !== latest && (
              <button type="button" className="btn self-start" onClick={() => setForm({ hubblePath: latest })}>
                Use the prebuilt APK
              </button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// --- Inclusion proof -----------------------------------------------------------

function ProofCard({
  form,
  health,
  setForm,
  errors,
}: {
  form: ObserveForm;
  health: Health | null;
  setForm: (patch: Partial<ObserveForm>) => void;
  errors: Record<string, string>;
}) {
  const p = 'inclusionProof.';
  const fillVerifier = useCallback((verifierPath: string) => setForm({ verifierPath }), [setForm]);
  const advancedErrors = !!(errors[p + 'cacheDir'] || errors[p + 'prefetchConcurrency'] || errors[p + 'prefetchTimeout']);
  return (
    <Card title="Inclusion proof check">
      <div className="flex flex-col gap-3 p-4">
        <Check
          checked={form.proofEnabled}
          onChange={(proofEnabled) => setForm({ proofEnabled })}
          label="Check every APK against the transparency log"
          hint="Needs the verifier binary. The results open in Analyze with the observation."
        />
        {form.proofEnabled && (
          <div className="ml-6 flex flex-col gap-3">
            <Field label="Verifier" error={errors[p + 'verifierPath']}>
              <PathField
                value={form.verifierPath}
                placeholder="/path/to/verifier"
                onChange={(verifierPath) => setForm({ verifierPath })}
                browse={
                  health
                    ? { mode: 'file', title: 'Choose the verifier', looksRight: (e) => !!e.exec }
                    : undefined
                }
              />
            </Field>
            <VerifierSetup connected={!!health} value={form.verifierPath} onUse={fillVerifier} />
            <Check
              checked={form.preinstalledOnly}
              onChange={(preinstalledOnly) => setForm({ preinstalledOnly })}
              label="Pre-installed packages only"
            />
            <Check
              checked={form.noPrefetch}
              onChange={(noPrefetch) => setForm({ noPrefetch })}
              label="Don’t pre-fetch log entries"
              hint="Each APK is then looked up on its own, which is slower."
            />
            <details className="group" open={advancedErrors || undefined}>
              <summary className="cursor-pointer select-none text-xs text-ink-muted hover:text-ink">Advanced</summary>
              <div className="mt-3 flex flex-col gap-3">
                <Field label="Cache directory" error={errors[p + 'cacheDir']} hint="Leave blank for the script’s default.">
                  <PathField
                    value={form.cacheDir}
                    onChange={(cacheDir) => setForm({ cacheDir })}
                    browse={health ? { mode: 'dir', title: 'Choose the cache folder' } : undefined}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Pre-fetch concurrency" error={errors[p + 'prefetchConcurrency']}>
                    <input
                      className="input"
                      inputMode="numeric"
                      disabled={form.noPrefetch}
                      value={form.prefetchConcurrency}
                      placeholder={String(health?.defaults.prefetchConcurrency ?? DEFAULT_PREFETCH_CONCURRENCY)}
                      onChange={(e) => setForm({ prefetchConcurrency: e.target.value })}
                    />
                  </Field>
                  <Field label="Pre-fetch timeout (seconds)" error={errors[p + 'prefetchTimeout']}>
                    <input
                      className="input"
                      inputMode="numeric"
                      disabled={form.noPrefetch}
                      value={form.prefetchTimeout}
                      placeholder={String(health?.defaults.prefetchTimeout ?? DEFAULT_PREFETCH_TIMEOUT)}
                      onChange={(e) => setForm({ prefetchTimeout: e.target.value })}
                    />
                  </Field>
                </div>
                {form.noPrefetch && (
                  <p className="text-xs text-ink-faint">Concurrency and timeout only apply to pre-fetching.</p>
                )}
              </div>
            </details>
          </div>
        )}
      </div>
    </Card>
  );
}

// --- Small form pieces ---------------------------------------------------------

function Field({
  label,
  hint,
  error,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      {label && <span className="label">{label}</span>}
      {children}
      {error ? (
        <span className="text-xs text-sev-critical">{error}</span>
      ) : (
        hint && <span className="text-xs text-ink-faint">{hint}</span>
      )}
    </label>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
  hintTone,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: string;
  hintTone?: 'warn';
  disabled?: boolean;
}) {
  return (
    <label className={clsx('flex items-start gap-2 text-sm', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="text-ink">{label}</span>
        {hint && (
          <span className={clsx('block text-xs', hintTone === 'warn' ? 'text-sev-high' : 'text-ink-faint')}>{hint}</span>
        )}
      </span>
    </label>
  );
}

function Radio({
  name,
  checked,
  onChange,
  label,
  hint,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input
        type="radio"
        name={name}
        className="mt-0.5 h-4 w-4 shrink-0 accent-accent"
        checked={checked}
        onChange={onChange}
      />
      <span>
        <span className="text-ink">{label}</span>
        {hint && <span className="block text-xs text-ink-faint">{hint}</span>}
      </span>
    </label>
  );
}
