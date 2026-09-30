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
 * `/observe/runs/:id`: a run as it happens.
 *
 * Everything shown is rebuilt from the helper's event stream, which replays
 * from the start on every connection; a reload mid-run therefore loses
 * nothing. Whether the run succeeded comes from the helper's snapshots only
 * (see server/README.md), never from re-reading the events here.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Loader2, Play, RefreshCw, Square, WifiOff } from 'lucide-react';
import { Badge, BrokenRobot, Card, CopyButton, PageHeader } from '@/shared/components/ui';
import { ApiError, api, followRun, getToken } from '@/observe/lib/api';
import { applyEntries, deviceSerials, initialView, type RunView, type StreamEntry } from '@/observe/lib/events';
import { RUN_REASONS, RUN_STATE, describe } from '@/observe/lib/reasons';
import { commandLine } from '@/observe/lib/options';
import { DeviceCard } from '@/observe/components/DeviceCard';
import { LogPanel } from '@/observe/components/LogPanel';
import { PromptDialog } from '@/observe/components/PromptDialog';
import { StepList } from '@/observe/components/StepList';

/** How often buffered stream entries are applied. Keeps a chatty log from re-rendering per line. */
const FLUSH_MS = 150;

export function RunPage() {
  const { id = '' } = useParams();
  // A new id is a new run: start from a clean view.
  return <Run key={id} id={id} />;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

function Run({ id }: { id: string }) {
  const [phase, setPhase] = useState<Phase>(() => (getToken() ? { kind: 'loading' } : { kind: 'missing' }));
  const [view, setView] = useState<RunView>(initialView);
  const [stream, setStream] = useState<'open' | 'ended' | 'lost'>('open');
  const [attempt, setAttempt] = useState(0);
  const buffer = useRef<StreamEntry[]>([]);

  useEffect(() => {
    if (!getToken()) return;
    let stop = () => {};
    let cancelled = false;
    const flush = () => {
      if (buffer.current.length === 0) return;
      const batch = buffer.current;
      buffer.current = [];
      setView((v) => applyEntries(v, batch));
    };
    const timer = window.setInterval(flush, FLUSH_MS);

    setStream('open');
    // Ask for the run first: the stream's error event cannot tell a run
    // this helper never had from a helper that went away.
    api
      .getRun(id)
      .then(() => {
        if (cancelled) return;
        setPhase({ kind: 'ready' });
        stop = followRun(id, {
          onEntry: (entry) => buffer.current.push(entry),
          onEnd: () => {
            flush();
            setStream('ended');
          },
          onError: () => setStream('lost'),
        });
      })
      .catch((err: ApiError) => {
        if (cancelled) return;
        setPhase(err.status === 404 ? { kind: 'missing' } : { kind: 'error', message: err.message });
      });

    return () => {
      cancelled = true;
      stop();
      window.clearInterval(timer);
    };
  }, [id, attempt]);

  if (phase.kind === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 p-16 text-sm text-ink-muted">
        <Loader2 size={16} className="animate-spin" />
        Loading the run…
      </div>
    );
  }
  if (phase.kind === 'missing') {
    return (
      <BrokenRobot
        title="This run is not known to the helper"
        hint={
          <>
            Runs are kept only while the helper that started them is running, and only in the tab that opened the
            helper’s link. <Link className="link" to="/observe">Start a new run</Link>.
          </>
        }
      />
    );
  }
  if (phase.kind === 'error') {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 p-16 text-center">
        <p className="text-sm text-sev-critical">{phase.message}</p>
        <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
          <RefreshCw size={13} />
          Try again
        </button>
      </div>
    );
  }

  return (
    <RunBody
      id={id}
      view={view}
      stream={stream}
      onReconnect={() => {
        setPhase({ kind: 'loading' });
        setAttempt((n) => n + 1);
      }}
    />
  );
}

function RunBody({
  id,
  view,
  stream,
  onReconnect,
}: {
  id: string;
  view: RunView;
  stream: 'open' | 'ended' | 'lost';
  onReconnect: () => void;
}) {
  const snap = view.snapshot;
  const live = snap?.state === 'running';
  const state = snap ? RUN_STATE[snap.state] : null;
  const elapsed = useElapsed(snap?.startedAt, snap?.finishedAt, live);
  const serials = deviceSerials(view);
  const proofChecked = !!snap?.argv.includes('--perform_inclusion_proof_check');
  const prompt = live ? snap?.pendingPrompt : undefined;
  const cancel = <CancelControl runId={id} live={live} />;

  return (
    <div>
      <PageHeader
        title="Observation run"
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {state ? <Badge tone={state.tone}>{state.label}</Badge> : <Badge>Connecting</Badge>}
            {elapsed !== null && <span className="tabular-nums">{formatClock(elapsed)}</span>}
            {snap && snap.anomalies > 0 && (
              <Badge tone="warn" title="Lines on the script's event channel that were not events. See the log.">
                {snap.anomalies} unexpected output line{snap.anomalies === 1 ? '' : 's'}
              </Badge>
            )}
            <span className="mono text-ink-faint">{id}</span>
          </span>
        }
        actions={
          live ? (
            cancel
          ) : (
            snap && (
              <Link className="btn btn-primary" to="/observe">
                <Play size={13} />
                New run
              </Link>
            )
          )
        }
      />

      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
        {stream === 'lost' && (
          <div className="flex items-center gap-3 rounded-lg border border-sev-high/40 bg-sev-high/5 px-4 py-3 text-sm">
            <WifiOff size={16} className="text-sev-high" />
            <span className="flex-1 text-ink-muted">Lost the connection to the helper. Is it still running?</span>
            <button type="button" className="btn" onClick={onReconnect}>
              <RefreshCw size={13} />
              Reconnect
            </button>
          </div>
        )}

        {snap?.error && (
          <div className="rounded-lg border border-sev-critical/40 bg-sev-critical/5 px-4 py-3 text-sm">
            <div className="font-medium text-sev-critical">{describe(RUN_REASONS, snap.error.reason)}</div>
            {snap.error.message && snap.error.message !== describe(RUN_REASONS, snap.error.reason) && (
              <div className="mt-0.5 text-ink-muted">{snap.error.message}</div>
            )}
            {snap.exitCode !== undefined && (
              <div className="mt-0.5 text-xs text-ink-faint">Exit code {snap.exitCode}.</div>
            )}
          </div>
        )}

        {view.runSteps.length > 0 && (
          <Card title="Preparation">
            <div className="p-4">
              <StepList steps={view.runSteps} live={live} />
            </div>
          </Card>
        )}

        {serials.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-2">
            {serials.map((serial) => (
              <DeviceCard
                key={serial}
                runId={id}
                serial={serial}
                snapshot={snap?.devices[serial]}
                timeline={view.devices[serial]}
                live={live}
                proofChecked={proofChecked}
              />
            ))}
          </div>
        )}

        <LogPanel runId={id} logs={view.logs} dropped={view.logsDropped} />

        {snap && (
          <Card title="Command" actions={<CopyButton value={commandLine('automate_observation.py', snap.argv)} />}>
            <pre className="mono whitespace-pre-wrap break-all px-4 py-3 text-ink-muted">
              {commandLine('automate_observation.py', snap.argv)}
            </pre>
          </Card>
        )}
      </div>

      {prompt && (
        <PromptDialog
          runId={id}
          prompt={prompt}
          model={prompt.device ? snap?.devices[prompt.device]?.model?.replace(/_/g, ' ') : undefined}
          footer={cancel}
        />
      )}
    </div>
  );
}

/** `m:ss`, or `h:mm:ss` past the hour. */
function formatClock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Milliseconds since the run started, ticking while it runs. */
function useElapsed(startedAt: string | undefined, finishedAt: string | undefined, live: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const end = finishedAt ? Date.parse(finishedAt) : live ? now : NaN;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, end - start);
}

function CancelControl({ runId, live }: { runId: string; live: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!live) return null;
  if (cancelling) {
    return (
      <span className="flex items-center gap-2 text-xs text-ink-muted">
        <Loader2 size={13} className="animate-spin" />
        Stopping…
      </span>
    );
  }
  if (!confirming) {
    return (
      <button type="button" className="btn" onClick={() => setConfirming(true)}>
        <Square size={12} />
        Cancel run
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-ink-muted">Stop the run? Hubble may be left installed on a device.</span>
      <button
        type="button"
        className="btn border-sev-critical/50 text-sev-critical"
        onClick={async () => {
          setError(null);
          setCancelling(true);
          try {
            await api.cancel(runId);
          } catch (err) {
            const e = err as ApiError;
            // Already over: the next snapshot says how it ended.
            if (e.reason !== 'not_running') {
              setError(e.message);
              setCancelling(false);
            }
          }
        }}
      >
        Stop
      </button>
      <button type="button" className="btn" onClick={() => setConfirming(false)}>
        Keep running
      </button>
      {error && <span className="text-sev-critical">{error}</span>}
    </div>
  );
}
