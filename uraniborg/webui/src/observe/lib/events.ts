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
 * The live run view, built from the helper's event stream.
 *
 * The stream carries three kinds of entries (see server/README.md):
 *   - `state`: the helper's snapshot of the run. It alone decides the run
 *     state, device statuses and the pending prompt; this module does not
 *     re-derive them, so it cannot disagree with the helper.
 *   - `event`: one automate_observation.py event (schema v1, see
 *     docs/automate_observation.md). Used for what the snapshot leaves out:
 *     the step timelines, device order, and how each prompt ended.
 *   - `log`: one line of the script's log.
 *
 * Unknown event types and fields are ignored, as the schema allows new ones
 * without a version bump.
 */

export type RunState = 'running' | 'succeeded' | 'failed' | 'cancelled';
export type DeviceStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'partial_check_incomplete'
  | 'partial_error'
  | 'failed';

export interface ErrorInfo {
  reason: string;
  message: string;
}

export interface PendingPrompt {
  device: string | null;
  kind: string;
  message: string;
  expectsInput: boolean;
}

export interface DeviceSnapshot {
  status: DeviceStatus | string;
  model?: string;
  resultsDir?: string;
  error?: ErrorInfo;
}

/** `GET /api/runs/:id`, and every `state` entry of the stream. */
export interface RunSnapshot {
  id: string;
  state: RunState;
  argv: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  error?: ErrorInfo;
  devices: Record<string, DeviceSnapshot>;
  anomalies: number;
  pendingPrompt?: PendingPrompt;
  lastPromptOutcome?: string;
}

export interface LogEntry {
  ts: string;
  source: 'stderr' | 'stdout' | 'helper' | string;
  level?: string;
  file?: string;
  func?: string;
  line?: number;
  message: string;
  anomaly?: boolean;
}

/** One script event as it arrives. Only the fields this UI reads are typed. */
export interface ScriptEvent {
  v: number;
  ts: string;
  type: string;
  [field: string]: unknown;
}

export interface StreamEntry {
  id: number;
  kind: 'state' | 'event' | 'log' | string;
  data: unknown;
}

export type StepState = 'started' | 'finished' | 'failed';

export interface StepProgress {
  done: number;
  total: number;
}

export interface StepEntry {
  step: string;
  state: StepState;
  startedAt?: string;
  durationMs?: number;
  message?: string;
  /** The latest `step_progress` for this run of the step, if it reports any. */
  progress?: StepProgress;
}

export interface PromptRecord {
  kind: string;
  outcome?: string;
}

export interface DeviceTimeline {
  steps: StepEntry[];
  prompts: PromptRecord[];
}

export interface RunView {
  /** Highest entry id applied, so a replayed entry is never applied twice. */
  lastId: number;
  snapshot: RunSnapshot | null;
  /** Steps without a device, in the order they started. */
  runSteps: StepEntry[];
  devices: Record<string, DeviceTimeline>;
  /** Serials in the order the script reported them. */
  deviceOrder: string[];
  runFinished: { exitCode: number; ok: boolean; error?: ErrorInfo } | null;
  logs: LogEntry[];
  /** Log lines dropped from the front to stay under {@link LOG_CAP}. */
  logsDropped: number;
}

/** Matches the helper's own cap, so a replay and a live view look the same. */
export const LOG_CAP = 50_000;

export function initialView(): RunView {
  return {
    lastId: 0,
    snapshot: null,
    runSteps: [],
    devices: {},
    deviceOrder: [],
    runFinished: null,
    logs: [],
    logsDropped: 0,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorInfo(value: unknown): ErrorInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { reason, message } = value as Record<string, unknown>;
  return typeof reason === 'string' ? { reason, message: str(message) ?? '' } : undefined;
}

function withDevice(view: RunView, serial: string): { view: RunView; timeline: DeviceTimeline } {
  if (view.devices[serial]) return { view, timeline: view.devices[serial] };
  const timeline: DeviceTimeline = { steps: [], prompts: [] };
  return {
    view: {
      ...view,
      devices: { ...view.devices, [serial]: timeline },
      deviceOrder: [...view.deviceOrder, serial],
    },
    timeline,
  };
}

function applyStep(steps: StepEntry[], event: ScriptEvent): StepEntry[] {
  const step = str(event.step);
  const state = str(event.state) as StepState | undefined;
  if (!step || !state || !['started', 'finished', 'failed'].includes(state)) return steps;
  if (state === 'started') {
    return [...steps, { step, state, startedAt: event.ts }];
  }
  const entry: Partial<StepEntry> = { state };
  if (typeof event.duration_ms === 'number') entry.durationMs = event.duration_ms;
  const message = str(event.message);
  if (message) entry.message = message;
  // Close the latest run of this step; a step that ends without having
  // started (not expected, but harmless) is recorded as it ended.
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].step === step) {
      const next = steps.slice();
      next[i] = { ...steps[i], ...entry };
      return next;
    }
  }
  return [...steps, { step, ...entry } as StepEntry];
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Records a `step_progress` on the latest run of its step that is still
 * going. Progress for a step that has not started, or has already ended, is
 * dropped: the contract only sends it in between.
 */
function applyProgress(steps: StepEntry[], event: ScriptEvent): StepEntry[] {
  const step = str(event.step);
  const done = count(event.done);
  const total = count(event.total);
  if (!step || done === undefined || total === undefined) return steps;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].step !== step) continue;
    if (steps[i].state !== 'started') return steps;
    const next = steps.slice();
    next[i] = { ...steps[i], progress: { done: Math.min(done, total), total } };
    return next;
  }
  return steps;
}

/** Applies one script event. Unknown types leave the view unchanged. */
export function applyEvent(view: RunView, event: ScriptEvent): RunView {
  const device = str(event.device);
  switch (event.type) {
    case 'step': {
      if (!device) {
        const runSteps = applyStep(view.runSteps, event);
        return runSteps === view.runSteps ? view : { ...view, runSteps };
      }
      const { view: v, timeline } = withDevice(view, device);
      const steps = applyStep(timeline.steps, event);
      return { ...v, devices: { ...v.devices, [device]: { ...timeline, steps } } };
    }
    case 'step_progress': {
      if (!device) {
        const runSteps = applyProgress(view.runSteps, event);
        return runSteps === view.runSteps ? view : { ...view, runSteps };
      }
      const timeline = view.devices[device];
      if (!timeline) return view;
      const steps = applyProgress(timeline.steps, event);
      return steps === timeline.steps ? view : { ...view, devices: { ...view.devices, [device]: { ...timeline, steps } } };
    }
    case 'devices': {
      let v = view;
      const serials = [
        ...(Array.isArray(event.selected) ? event.selected : []),
        ...(Array.isArray(event.missing) ? event.missing : []),
      ];
      for (const serial of serials) {
        if (typeof serial === 'string') v = withDevice(v, serial).view;
      }
      return v;
    }
    case 'device_started':
    case 'device_finished':
      return device ? withDevice(view, device).view : view;
    case 'prompt': {
      const kind = str(event.kind);
      if (!device || !kind) return view;
      const { view: v, timeline } = withDevice(view, device);
      return { ...v, devices: { ...v.devices, [device]: { ...timeline, prompts: [...timeline.prompts, { kind }] } } };
    }
    case 'prompt_resolved': {
      const kind = str(event.kind);
      if (!device || !kind) return view;
      const { view: v, timeline } = withDevice(view, device);
      const prompts = timeline.prompts.slice();
      const outcome = str(event.outcome);
      let i = prompts.length - 1;
      while (i >= 0 && (prompts[i].kind !== kind || prompts[i].outcome !== undefined)) i--;
      if (i >= 0) prompts[i] = { ...prompts[i], outcome };
      else prompts.push({ kind, outcome });
      return { ...v, devices: { ...v.devices, [device]: { ...timeline, prompts } } };
    }
    case 'run_finished':
      return {
        ...view,
        runFinished: {
          exitCode: typeof event.exit_code === 'number' ? event.exit_code : -1,
          ok: event.ok === true,
          error: errorInfo(event.error),
        },
      };
    default:
      return view;
  }
}

/**
 * Applies a batch of stream entries in order.
 *
 * Batched so that a chatty run appends its log lines in one copy per batch
 * rather than one per line. Entries at or below `lastId` were already applied
 * (a reconnect replays from the last id the browser saw) and are skipped.
 */
export function applyEntries(view: RunView, entries: StreamEntry[]): RunView {
  let next = view;
  const newLogs: LogEntry[] = [];
  for (const entry of entries) {
    if (entry.id <= next.lastId) continue;
    next = { ...next, lastId: entry.id };
    const data = entry.data;
    if (typeof data !== 'object' || data === null) continue;
    if (entry.kind === 'state') {
      next = { ...next, snapshot: data as RunSnapshot };
    } else if (entry.kind === 'event') {
      const event = data as ScriptEvent;
      if (typeof event.type === 'string') next = applyEvent(next, event);
    } else if (entry.kind === 'log') {
      newLogs.push(data as LogEntry);
    }
  }
  if (newLogs.length) {
    let logs = next.logs.concat(newLogs);
    let dropped = next.logsDropped;
    if (logs.length > LOG_CAP) {
      dropped += logs.length - LOG_CAP;
      logs = logs.slice(logs.length - LOG_CAP);
    }
    next = { ...next, logs, logsDropped: dropped };
  }
  return next;
}

/** Serials to show, in script order, then any the snapshot knows but no event named. */
export function deviceSerials(view: RunView): string[] {
  const extra = Object.keys(view.snapshot?.devices ?? {}).filter((s) => !view.devices[s]);
  return [...view.deviceOrder, ...extra];
}

/** A log as plain text, for download. */
export function logText(logs: LogEntry[]): string {
  return logs
    .map((l) => {
      const where = l.file ? `${l.file}:${l.func ?? ''}(${l.line ?? ''}) ` : '';
      return `${l.ts} ${(l.level ?? '').padEnd(8)} [${l.source}] ${where}${l.message}`;
    })
    .join('\n');
}
