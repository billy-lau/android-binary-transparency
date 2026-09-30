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
 * Landing page: pick between observing a device and analyzing results.
 *
 * It has its own minimal shell rather than the Analyze sidebar, because
 * neither mode has started yet when it is shown.
 */

import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, FolderOpen, Smartphone, Telescope } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/analyze/lib/store';
import { analyzePath } from '@/analyze/paths';
import { useObserve, type HelperStatus } from '@/observe/store';

export function LandingPage() {
  const observationCount = useApp((s) => s.observations.length);
  const helper = useObserve((s) => s.helper);
  const checkHelper = useObserve((s) => s.checkHelper);

  useEffect(() => {
    void checkHelper();
  }, [checkHelper]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col justify-center gap-8 px-6 py-12">
        <header className="flex items-center gap-3">
          <Telescope size={28} className="text-accent" />
          <div className="leading-tight">
            <h1 className="text-xl font-semibold">Uraniborg Explorer</h1>
            <p className="text-sm text-ink-muted">What would you like to do?</p>
          </div>
        </header>

        <div className="grid gap-4 md:grid-cols-2">
          <ModeCard
            icon={<Smartphone size={22} />}
            title="Observe a device"
            description={
              <>
                Run Hubble on a connected Android device with <span className="mono">automate_observation.py</span>.
              </>
            }
            to="/observe"
            note={<HelperNote helper={helper} />}
          />
          <ModeCard
            icon={<FolderOpen size={22} />}
            title="Analyze results"
            description="Open a results folder or loose Hubble files and explore what is preloaded."
            to={analyzePath('/load')}
          />
        </div>

        {observationCount > 0 && (
          <Link className="btn btn-primary self-start" to={analyzePath('/overview')}>
            Continue analysis ({observationCount} observation{observationCount === 1 ? '' : 's'} loaded)
            <ArrowRight size={14} />
          </Link>
        )}
      </div>
    </div>
  );
}

/** Whether Observe can run things from here, or only build a command line. */
function HelperNote({ helper }: { helper: HelperStatus }) {
  switch (helper.kind) {
    case 'checking':
      return <>Looking for the helper…</>;
    case 'connected':
      return (
        <span className="text-sev-ok">
          Helper connected{helper.health.activeRun ? ': a run is in progress' : ''}
        </span>
      );
    case 'error':
      return (
        <span className="text-sev-high">
          {helper.badToken
            ? 'The helper refused this page: open the link it printed most recently'
            : 'Helper not reachable: you can still build a command line'}
        </span>
      );
    default:
      return <>Helper not running: you can still build a command line</>;
  }
}

function ModeCard({
  icon,
  title,
  description,
  to,
  note,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  to: string;
  /** A status line under the description. */
  note?: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={clsx(
        'card group flex flex-col gap-3 p-5',
        'transition-colors hover:border-accent/50 hover:bg-bg-hover/40',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-accent">{icon}</span>
        <ArrowRight size={16} className="text-ink-faint transition-colors group-hover:text-accent" />
      </div>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="text-sm text-ink-muted">{description}</p>
      {note && <p className="text-xs text-ink-faint">{note}</p>}
    </Link>
  );
}
