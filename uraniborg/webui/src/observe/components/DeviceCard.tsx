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

/** One device in a run: status, steps, prompts, and the way into Analyze. */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Badge, Card, CopyButton } from '@/shared/components/ui';
import { useApp } from '@/analyze/lib/store';
import { analyzePath } from '@/analyze/paths';
import { api } from '@/observe/lib/api';
import type { DeviceSnapshot, DeviceTimeline } from '@/observe/lib/events';
import { DEVICE_REASONS, DEVICE_STATUS, PROMPT_KINDS, PROMPT_OUTCOMES, describe } from '@/observe/lib/reasons';
import { StepList } from './StepList';

function basename(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path;
}

export function DeviceCard({
  runId,
  serial,
  snapshot,
  timeline,
  live,
  proofChecked,
}: {
  runId: string;
  serial: string;
  snapshot?: DeviceSnapshot;
  timeline?: DeviceTimeline;
  live: boolean;
  /** Whether the run included the inclusion proof check. */
  proofChecked: boolean;
}) {
  const status = snapshot?.status ?? 'pending';
  // A run that ended (cancelled, crashed) before this device finished leaves
  // it at pending or running; say so instead of spinning forever.
  const unfinished = !live && (status === 'pending' || status === 'running');
  const badge = unfinished
    ? { label: 'Did not finish', tone: 'warn' as const }
    : (DEVICE_STATUS[status] ?? { label: status.replace(/_/g, ' '), tone: 'neutral' as const });
  const model = snapshot?.model?.replace(/_/g, ' ');
  const prompts = (timeline?.prompts ?? []).filter((p) => p.outcome && p.outcome !== 'done');

  return (
    <Card
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{model ?? serial}</span>
          {model && <span className="mono truncate font-normal text-ink-faint">{serial}</span>}
        </span>
      }
      actions={<Badge tone={badge.tone}>{badge.label}</Badge>}
    >
      <div className="flex flex-col gap-3 p-4">
        {snapshot?.error && (
          <div className="text-sm">
            <div className="text-sev-critical">{describe(DEVICE_REASONS, snapshot.error.reason)}</div>
            {snapshot.error.message && snapshot.error.message !== describe(DEVICE_REASONS, snapshot.error.reason) && (
              <div className="text-xs text-ink-muted">{snapshot.error.message}</div>
            )}
          </div>
        )}
        {timeline && timeline.steps.length > 0 ? (
          <StepList steps={timeline.steps} live={live} />
        ) : (
          status === 'pending' && live && <p className="text-sm text-ink-faint">Waiting to start.</p>
        )}
        {prompts.map((p, i) => (
          <p key={i} className="text-xs text-sev-high">
            {PROMPT_KINDS[p.kind] ?? p.kind}: {describe(PROMPT_OUTCOMES, p.outcome)}
          </p>
        ))}
        {status === 'success' && proofChecked && (
          <p className="text-xs text-ink-faint">
            Success does not mean every APK was found in the log. Check Integrity after opening in Analyze.
          </p>
        )}
        {snapshot?.resultsDir && <Results runId={runId} serial={serial} dir={snapshot.resultsDir} model={model} />}
      </div>
    </Card>
  );
}

function Results({ runId, serial, dir, model }: { runId: string; serial: string; dir: string; model?: string }) {
  const loadFiles = useApp((s) => s.loadFiles);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const results = await api.results(runId, serial);
      const outcome = loadFiles(results.files, [model, serial, basename(results.dir)].filter(Boolean).join(' · '));
      if (outcome.ok) navigate(analyzePath('/overview'));
      else setError(outcome.error);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="label">Results</div>
      <div className="flex items-center gap-2">
        <span className="mono min-w-0 flex-1 break-all text-ink-muted">{dir}</span>
        <CopyButton value={dir} />
      </div>
      <button type="button" className="btn btn-primary self-start" onClick={open} disabled={busy}>
        {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowRight size={13} />}
        Open in Analyze
      </button>
      {error && <p className="text-xs text-sev-critical">{error}</p>}
    </div>
  );
}
