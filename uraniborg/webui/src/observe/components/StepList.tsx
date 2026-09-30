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

/** A step timeline: what the script did, how long each step took, where it stopped. */

import { CheckCircle2, CircleDashed, Loader2, XCircle } from 'lucide-react';
import type { StepEntry, StepProgress } from '@/observe/lib/events';
import { STEP_LABELS, STEP_PROGRESS_UNITS } from '@/observe/lib/reasons';

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * @param live Whether the run is still going. A step still marked started
 *   once the run is over never finished (the script was stopped), so it is
 *   not shown as spinning.
 */
export function StepList({ steps, live }: { steps: StepEntry[]; live: boolean }) {
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((s, i) => (
        <li key={`${s.step}-${i}`} className="flex items-start gap-2 text-sm">
          <span className="mt-0.5 shrink-0">
            {s.state === 'finished' ? (
              <CheckCircle2 size={14} className="text-sev-ok" />
            ) : s.state === 'failed' ? (
              <XCircle size={14} className="text-sev-critical" />
            ) : live ? (
              <Loader2 size={14} className="animate-spin text-accent" />
            ) : (
              <CircleDashed size={14} className="text-ink-faint" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="text-ink">{STEP_LABELS[s.step] ?? s.step.replace(/_/g, ' ')}</span>
            {s.durationMs !== undefined && (
              <span className="ml-2 text-xs tabular-nums text-ink-faint">{formatDuration(s.durationMs)}</span>
            )}
            {s.state === 'started' && !live && <span className="ml-2 text-xs text-ink-faint">did not finish</span>}
            {s.progress && <Progress step={s.step} progress={s.progress} running={s.state === 'started' && live} />}
            {s.message && (
              <span
                className={
                  s.state === 'failed' ? 'block text-xs text-sev-critical' : 'block text-xs text-ink-faint'
                }
              >
                {s.message}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function progressText(step: string, { done, total }: StepProgress): string {
  const unit = STEP_PROGRESS_UNITS[step];
  return `${done.toLocaleString()} of ${total.toLocaleString()}${unit ? ` ${unit}` : ''}`;
}

/**
 * How far a long step has got. The bar shows only while the step runs; after
 * it ends the count stays as a record (for a stopped step, where it stopped).
 */
function Progress({ step, progress, running }: { step: string; progress: StepProgress; running: boolean }) {
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 100;
  return (
    <span className="block">
      <span className="block text-xs tabular-nums text-ink-faint">{progressText(step, progress)}</span>
      {running && progress.total > 0 && (
        <span
          className="mt-1 block h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
          aria-label={STEP_LABELS[step] ?? step}
        >
          <span className="block h-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
        </span>
      )}
    </span>
  );
}
