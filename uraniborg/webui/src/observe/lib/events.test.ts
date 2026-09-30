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

import { describe, expect, it } from 'vitest';
import {
  LOG_CAP,
  applyEntries,
  deviceSerials,
  initialView,
  logText,
  type RunSnapshot,
  type RunView,
  type StreamEntry,
} from './events';

let ts = 0;
const at = () => `2026-01-02T03:04:${String(ts++ % 60).padStart(2, '0')}.000Z`;
const ev = (type: string, fields: Record<string, unknown> = {}) => ({ v: 1, ts: at(), type, ...fields });

/** Numbers entries the way the helper does and applies them in one go. */
function play(items: Array<{ kind: string; data: unknown }>, view: RunView = initialView()): RunView {
  const entries: StreamEntry[] = items.map((item, i) => ({ id: view.lastId + i + 1, ...item }));
  return applyEntries(view, entries);
}
const event = (type: string, fields?: Record<string, unknown>) => ({ kind: 'event', data: ev(type, fields) });
const state = (snap: Partial<RunSnapshot>) => ({
  kind: 'state',
  data: { id: 'r', state: 'running', argv: [], startedAt: at(), devices: {}, anomalies: 0, ...snap },
});
const step = (name: string, st: string, extra: Record<string, unknown> = {}) =>
  event('step', { step: name, state: st, ...extra });

const SERIAL = 'emulator-5554';
const preamble = [
  event('run_started', { argv: [], pid: 1 }),
  step('verify_hubble', 'started'),
  step('verify_hubble', 'finished', { duration_ms: 3 }),
  event('devices', { devices: [{ serial: SERIAL, unauthorized: false }], selected: [SERIAL], missing: [] }),
  event('device_started', { device: SERIAL }),
];

describe('run view', () => {
  it('builds run and device timelines for a successful run', () => {
    const view = play([
      ...preamble,
      step('install_hubble', 'started', { device: SERIAL }),
      step('install_hubble', 'finished', { device: SERIAL, duration_ms: 1200 }),
      event('device_finished', { device: SERIAL, status: 'success', results_dir: '/r/000' }),
      event('run_finished', { exit_code: 0, ok: true, summary: {} }),
      state({ state: 'succeeded', devices: { [SERIAL]: { status: 'success', resultsDir: '/r/000' } } }),
    ]);
    expect(view.runSteps).toEqual([
      { step: 'verify_hubble', state: 'finished', startedAt: expect.any(String), durationMs: 3 },
    ]);
    expect(view.deviceOrder).toEqual([SERIAL]);
    expect(view.devices[SERIAL].steps).toEqual([
      { step: 'install_hubble', state: 'finished', startedAt: expect.any(String), durationMs: 1200 },
    ]);
    expect(view.runFinished).toEqual({ exitCode: 0, ok: true, error: undefined });
    expect(view.snapshot?.state).toBe('succeeded');
  });

  it('keeps the Xiaomi prompt open across a re-ask, until it resolves', () => {
    let view = play([
      ...preamble,
      step('install_hubble', 'started', { device: SERIAL }),
      event('prompt', { device: SERIAL, kind: 'xiaomi_manual_install', message: 'Install', expects_input: true }),
      state({ pendingPrompt: { device: SERIAL, kind: 'xiaomi_manual_install', message: 'Install', expectsInput: true } }),
    ]);
    expect(view.devices[SERIAL].prompts).toEqual([{ kind: 'xiaomi_manual_install' }]);
    // Pressed too early: the script re-asks without a new prompt event.
    view = play([{ kind: 'log', data: { ts: at(), source: 'stderr', level: 'WARNING', message: 'still not installed' } }], view);
    expect(view.snapshot?.pendingPrompt?.kind).toBe('xiaomi_manual_install');
    view = play(
      [
        event('prompt_resolved', { device: SERIAL, kind: 'xiaomi_manual_install', outcome: 'done' }),
        state({ lastPromptOutcome: 'done' }),
      ],
      view,
    );
    expect(view.devices[SERIAL].prompts).toEqual([{ kind: 'xiaomi_manual_install', outcome: 'done' }]);
    expect(view.snapshot?.pendingPrompt).toBeUndefined();
  });

  it('records a failed backup prompt and the failed step', () => {
    const view = play([
      ...preamble,
      step('extract_results', 'started', { device: SERIAL }),
      event('prompt', { device: SERIAL, kind: 'adb_backup_confirm', message: 'Tap', expects_input: false }),
      event('prompt_resolved', { device: SERIAL, kind: 'adb_backup_confirm', outcome: 'failed' }),
      step('extract_results', 'failed', { device: SERIAL, duration_ms: 9, message: 'backup failed' }),
      event('device_finished', { device: SERIAL, status: 'failed', error: { reason: 'extract_failed', message: 'm' } }),
    ]);
    const timeline = view.devices[SERIAL];
    expect(timeline.prompts).toEqual([{ kind: 'adb_backup_confirm', outcome: 'failed' }]);
    expect(timeline.steps[0]).toMatchObject({ step: 'extract_results', state: 'failed', message: 'backup failed' });
  });

  it('shows an incomplete inclusion proof check as a failed step on a collected device', () => {
    const view = play([
      ...preamble,
      step('inclusion_proof_check', 'started', { device: SERIAL }),
      step('inclusion_proof_check', 'failed', { device: SERIAL, duration_ms: 5 }),
      event('device_finished', {
        device: SERIAL,
        status: 'partial_check_incomplete',
        results_dir: '/r/000',
        error: { reason: 'inclusion_proof_check_incomplete', message: 'm' },
      }),
      state({
        devices: {
          [SERIAL]: {
            status: 'partial_check_incomplete',
            resultsDir: '/r/000',
            error: { reason: 'inclusion_proof_check_incomplete', message: 'm' },
          },
        },
      }),
    ]);
    expect(view.devices[SERIAL].steps.at(-1)?.state).toBe('failed');
    expect(view.snapshot?.devices[SERIAL].status).toBe('partial_check_incomplete');
  });

  it('keeps the terminated run_finished of a cancel', () => {
    const view = play([
      ...preamble,
      event('run_finished', { exit_code: 143, ok: false, summary: {}, error: { reason: 'terminated', message: 'SIGTERM' } }),
      state({ state: 'cancelled', error: { reason: 'terminated', message: 'SIGTERM' } }),
    ]);
    expect(view.runFinished).toEqual({ exitCode: 143, ok: false, error: { reason: 'terminated', message: 'SIGTERM' } });
    expect(view.snapshot?.state).toBe('cancelled');
  });

  it('takes an early exit with exit code 0 as reported, not as success', () => {
    const view = play([
      event('run_started', { argv: [], pid: 1 }),
      event('run_finished', { exit_code: 0, ok: false, summary: {}, error: { reason: 'no_devices', message: 'none' } }),
      state({ state: 'failed', exitCode: 0, error: { reason: 'no_devices', message: 'none' } }),
    ]);
    expect(view.runFinished?.ok).toBe(false);
    expect(view.snapshot?.state).toBe('failed');
    expect(view.deviceOrder).toEqual([]);
  });

  it('has no run_finished when the stream just stops; the helper snapshot says failed', () => {
    const view = play([
      ...preamble,
      event('device_finished', { device: SERIAL, status: 'success', results_dir: '/r/000' }),
      state({ state: 'failed', error: { reason: 'no_result', message: 'm' } }),
    ]);
    expect(view.runFinished).toBeNull();
    expect(view.snapshot?.state).toBe('failed');
  });

  it('ignores unknown event types and malformed entries', () => {
    const before = play(preamble);
    const after = play(
      [
        event('future_event', { detail: 'x' }),
        event('step', { step: 'x', state: 'exploded' }),
        { kind: 'event', data: 'not an object' },
        { kind: 'mystery', data: {} },
      ],
      before,
    );
    expect({ ...after, lastId: before.lastId }).toEqual(before);
    expect(after.lastId).toBe(before.lastId + 4);
  });

  it('lists missing serials, and devices only the snapshot knows', () => {
    const view = play([
      event('devices', { devices: [], selected: [], missing: ['GONE'] }),
      state({ devices: { GONE: { status: 'failed' }, EXTRA: { status: 'pending' } } }),
    ]);
    expect(deviceSerials(view)).toEqual(['GONE', 'EXTRA']);
  });
});

describe('stream entries', () => {
  it('skips entries it has already applied, as a reconnect replays them', () => {
    const view = applyEntries(initialView(), [
      { id: 1, kind: 'log', data: { ts: 't', source: 'stderr', message: 'a' } },
      { id: 2, kind: 'log', data: { ts: 't', source: 'stderr', message: 'b' } },
    ]);
    const again = applyEntries(view, [
      { id: 2, kind: 'log', data: { ts: 't', source: 'stderr', message: 'b' } },
      { id: 3, kind: 'log', data: { ts: 't', source: 'stderr', message: 'c' } },
    ]);
    expect(again.logs.map((l) => l.message)).toEqual(['a', 'b', 'c']);
  });

  it('caps the log and counts what it dropped', () => {
    const entries: StreamEntry[] = Array.from({ length: LOG_CAP + 5 }, (_, i) => ({
      id: i + 1,
      kind: 'log',
      data: { ts: 't', source: 'stderr', message: String(i) },
    }));
    const view = applyEntries(initialView(), entries);
    expect(view.logs).toHaveLength(LOG_CAP);
    expect(view.logs[0].message).toBe('5');
    expect(view.logsDropped).toBe(5);
  });

  it('writes a readable log file', () => {
    expect(
      logText([
        { ts: 'T', source: 'stderr', level: 'INFO', file: 'a.py', func: 'main', line: 3, message: 'hi' },
        { ts: 'T', source: 'helper', message: 'plain' },
      ]),
    ).toBe('T INFO     [stderr] a.py:main(3) hi\nT          [helper] plain');
  });
});

describe('step progress', () => {
  const PROOF = 'inclusion_proof_check';
  const progress = (done: unknown, total: unknown, extra: Record<string, unknown> = {}) =>
    event('step_progress', { step: PROOF, device: SERIAL, done, total, ...extra });
  const proofStep = (view: RunView) => view.devices[SERIAL].steps.find((s) => s.step === PROOF);

  it('tracks the latest done/total while the step runs and keeps it after', () => {
    let view = play([...preamble, step(PROOF, 'started', { device: SERIAL }), progress(0, 314)]);
    expect(proofStep(view)?.progress).toEqual({ done: 0, total: 314 });
    view = play([progress(120, 314)], view);
    expect(proofStep(view)?.progress).toEqual({ done: 120, total: 314 });
    view = play([progress(314, 314), step(PROOF, 'finished', { device: SERIAL, duration_ms: 9300 })], view);
    expect(proofStep(view)).toMatchObject({ state: 'finished', durationMs: 9300, progress: { done: 314, total: 314 } });
  });

  it('keeps where a stopped step got to', () => {
    const view = play([
      ...preamble,
      step(PROOF, 'started', { device: SERIAL }),
      progress(0, 314),
      progress(57, 314),
      step(PROOF, 'failed', { device: SERIAL, duration_ms: 4000 }),
    ]);
    expect(proofStep(view)).toMatchObject({ state: 'failed', progress: { done: 57, total: 314 } });
  });

  it('drops progress outside the step, for other steps, or with bad counts', () => {
    const before = play([...preamble, progress(1, 314)]);
    expect(before.devices[SERIAL].steps).toEqual([]);

    const view = play([
      ...preamble,
      step(PROOF, 'started', { device: SERIAL }),
      progress(10, 314),
      progress(-1, 314),
      progress(11.5, 314),
      progress('12', 314),
      progress(13, null),
      event('step_progress', { step: 'extract_results', device: SERIAL, done: 1, total: 2 }),
      event('step_progress', { step: PROOF, device: 'someone-else', done: 1, total: 2 }),
    ]);
    expect(proofStep(view)?.progress).toEqual({ done: 10, total: 314 });
    expect(view.deviceOrder).toEqual([SERIAL]);

    const after = play([step(PROOF, 'finished', { device: SERIAL }), progress(300, 314)], view);
    expect(proofStep(after)?.progress).toEqual({ done: 10, total: 314 });
  });

  it('applies to the latest run of a repeated step, and to run-level steps', () => {
    const view = play([
      ...preamble,
      step(PROOF, 'started', { device: SERIAL }),
      progress(5, 5),
      step(PROOF, 'finished', { device: SERIAL }),
      step(PROOF, 'started', { device: SERIAL }),
      progress(2, 7),
      step('build_hubble', 'started'),
      event('step_progress', { step: 'build_hubble', done: 3, total: 4 }),
    ]);
    const runs = view.devices[SERIAL].steps.filter((s) => s.step === PROOF);
    expect(runs.map((s) => s.progress)).toEqual([
      { done: 5, total: 5 },
      { done: 2, total: 7 },
    ]);
    expect(view.runSteps.find((s) => s.step === 'build_hubble')?.progress).toEqual({ done: 3, total: 4 });
  });

  it('clamps done to total and accepts an empty check', () => {
    const view = play([...preamble, step(PROOF, 'started', { device: SERIAL }), progress(400, 314)]);
    expect(proofStep(view)?.progress).toEqual({ done: 314, total: 314 });
    const empty = play([...preamble, step(PROOF, 'started', { device: SERIAL }), progress(0, 0)]);
    expect(proofStep(empty)?.progress).toEqual({ done: 0, total: 0 });
  });
});
