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

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, FolderOpen, Smartphone, Telescope } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/analyze/lib/store';
import { analyzePath } from '@/analyze/paths';

export function LandingPage() {
  const observationCount = useApp((s) => s.observations.length);

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
            status="Coming soon"
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

function ModeCard({
  icon,
  title,
  description,
  to,
  status,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  /** Where the card leads. Without it, the card is shown but not clickable. */
  to?: string;
  /** Short note shown instead of the arrow, e.g. why the card is disabled. */
  status?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between">
        <span className="text-accent">{icon}</span>
        {status ? (
          <span className="rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-faint">{status}</span>
        ) : (
          <ArrowRight size={16} className="text-ink-faint transition-colors group-hover:text-accent" />
        )}
      </div>
      <h2 className="text-base font-semibold text-ink">{title}</h2>
      <p className="text-sm text-ink-muted">{description}</p>
    </>
  );
  const className = 'card group flex flex-col gap-3 p-5';

  if (!to) {
    return (
      <section className={clsx(className, 'opacity-60')} aria-disabled="true">
        {body}
      </section>
    );
  }
  return (
    <Link to={to} className={clsx(className, 'transition-colors hover:border-accent/50 hover:bg-bg-hover/40')}>
      {body}
    </Link>
  );
}
