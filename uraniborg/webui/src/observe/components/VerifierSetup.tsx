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
 * Help for the verifier field: what the verifier is, and a way to get one.
 *
 * With the helper, it reports whether the helper has already built the
 * verifier and can build it (into the helper's cache directory, never the
 * checkout). Without it, it explains the manual build.
 */

import { useCallback, useEffect, useState } from 'react';
import { Hammer, Loader2 } from 'lucide-react';
import { api, type VerifierStatus } from '@/observe/lib/api';

const POLL_MS = 1000;
const MANUAL_BUILD = 'cd verifier_tools/verify && go build ./cmd/verifier';

export function VerifierSetup({
  connected,
  value,
  onUse,
}: {
  connected: boolean;
  /** The verifier field's current value. */
  value: string;
  /** Fills the verifier field. */
  onUse: (path: string) => void;
}) {
  const [status, setStatus] = useState<VerifierStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startedHere, setStartedHere] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.verifier());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);

  const building = status?.build.state === 'running';
  useEffect(() => {
    if (!building) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [building, refresh]);

  // A build started from this page fills the field when it succeeds.
  useEffect(() => {
    if (startedHere && status?.build.state === 'succeeded' && status.built) {
      onUse(status.binary);
      setStartedHere(false);
    }
  }, [startedHere, status, onUse]);

  const build = async () => {
    setError(null);
    try {
      setStatus(await api.buildVerifier());
      setStartedHere(true);
    } catch (err) {
      setError((err as Error).message);
      void refresh();
    }
  };

  const intro = (
    <>
      The verifier is a small Go program in <span className="mono">verifier_tools/verify</span> that checks each APK
      against Google’s transparency logs.
    </>
  );

  if (!connected) {
    return (
      <div className="flex flex-col gap-1 text-xs text-ink-faint">
        <p>{intro}</p>
        <p>
          Build it with Go 1.25 or newer, from the repository root:{' '}
          <span className="mono whitespace-nowrap text-ink-muted">{MANUAL_BUILD}</span>, then enter the full path of
          the <span className="mono">verifier</span> it creates.
        </p>
      </div>
    );
  }

  const using = !!status?.built && value.trim() === status.binary;
  return (
    <div className="flex flex-col gap-2 text-xs text-ink-faint">
      <p>{intro}</p>
      {status && (
        <>
          {status.built ? (
            <p>
              {using ? 'Using the verifier the helper built' : 'The helper has built a verifier'}:{' '}
              <span className="mono break-all text-ink-muted">{status.binary}</span>
            </p>
          ) : (
            status.sourceFound && status.go && <p>The helper can build it for you. The first build downloads its Go modules.</p>
          )}
          {!status.sourceFound && (
            <p className="text-sev-high">
              The verifier source was not found at <span className="mono break-all">{status.sourceDir}</span>. Browse to a
              verifier built elsewhere.
            </p>
          )}
          {status.sourceFound && !status.go && (
            <p className="text-sev-high">
              Go is not installed or not on the helper’s PATH.{' '}
              <a className="link" href="https://go.dev/doc/install" target="_blank" rel="noreferrer">
                Install Go {status.goRequired ?? '1.25'} or newer
              </a>
              , restart the helper, and build here; or build it yourself (
              <span className="mono text-ink-muted">{MANUAL_BUILD}</span>) and browse to it.
            </p>
          )}
          {status.go && status.goOutdated && (
            <p className="text-sev-high">
              The helper’s Go is {status.goVersion}, older than the {status.goRequired} the verifier needs. Go will try to
              download a newer toolchain, which needs network access.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {status.built && !using && (
              <button type="button" className="btn btn-primary" onClick={() => onUse(status.binary)}>
                Use this verifier
              </button>
            )}
            {status.sourceFound && status.go && (
              <button type="button" className="btn" onClick={build} disabled={building}>
                {building ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />}
                {building ? 'Building…' : status.built ? 'Rebuild' : 'Build verifier'}
              </button>
            )}
          </div>
          {status.build.state === 'failed' && (
            <p className="text-sev-critical">{status.build.error ?? 'The build failed.'}</p>
          )}
          {status.build.state !== 'idle' && status.build.output.length > 0 && (building || status.build.state === 'failed') && (
            <pre className="mono max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-bg px-3 py-2 text-ink-muted">
              {status.build.output.slice(-40).join('\n')}
            </pre>
          )}
        </>
      )}
      {error && <p className="text-sev-critical">{error}</p>}
    </div>
  );
}
