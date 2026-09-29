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
 * Generic presentational primitives shared by Analyze and Observe.
 * Intentionally small and dependency-light; nothing here knows about Hubble
 * data. Hubble-specific badges and notes live in `@/analyze/components/hubble`.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, Copy, Info } from 'lucide-react';
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { copyText, shortHash } from '@/shared/lib/format';

export function Card({
  title,
  actions,
  children,
  className,
  style,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Escape hatch for caller-driven sizing, e.g. a resizable detail pane. */
  style?: CSSProperties;
}) {
  return (
    <section className={clsx('card', className)} style={style}>
      {(title || actions) && (
        <header className="card-head">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = 'default',
  to,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'warn' | 'bad' | 'good';
  to?: string;
}) {
  const toneClass = {
    default: 'text-ink',
    warn: 'text-sev-high',
    bad: 'text-sev-critical',
    good: 'text-sev-ok',
  }[tone];
  const body = (
    <div className="card h-full px-4 py-3 transition-colors hover:border-accent/40">
      <div className="label">{label}</div>
      <div className={clsx('mt-1 text-2xl font-semibold tabular-nums', toneClass)}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-ink-faint">{hint}</div>}
    </div>
  );
  return to ? (
    <Link to={to} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

const BADGE_TONES = {
  neutral: 'border-line bg-bg-raised text-ink-muted',
  accent: 'border-accent/40 bg-accent/10 text-accent',
  good: 'border-sev-ok/40 bg-sev-ok/10 text-sev-ok',
  warn: 'border-sev-high/40 bg-sev-high/10 text-sev-high',
  bad: 'border-sev-critical/40 bg-sev-critical/10 text-sev-critical',
  worst: 'border-sev-astronomical/50 bg-sev-astronomical/15 text-sev-astronomical',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  children,
  tone = 'neutral',
  title,
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={clsx('btn', className)}
      title={`Copy ${label ?? 'value'}`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (await copyText(value)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? <Check size={12} className="text-sev-ok" /> : <Copy size={12} />}
      {label && <span>{label}</span>}
    </button>
  );
}

export function HashText({ value, bytes = 16 }: { value: string | null; bytes?: number }) {
  if (!value) return <span className="text-ink-faint">—</span>;
  return (
    <span className="mono text-ink-muted" title={value}>
      {shortHash(value, bytes)}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <Info size={20} className="text-ink-faint" />
      <p className="text-sm font-medium text-ink-muted">{title}</p>
      {hint && <p className="max-w-md text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

const ROBOT = String.raw`
    ,---------.
    |  x   o  |   ~ bzzt ~
    |    -    |
    '----+----'
     .---+---.
     | # # # |
     '-+---+-'
      _|   |_
     |__| |__|
`;

/**
 * The state for a URL that addresses something this app has no view for.
 *
 * Deliberately lighter in tone than {@link EmptyState}: a mistyped or stale
 * query parameter is a navigation accident rather than anything wrong with the
 * data behind the page, and nothing about it is in question. The recovery
 * is always to pick a real destination, so the caller supplies one.
 */
export function BrokenRobot({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      {/*
        Left-aligned inside a centred block: `text-center` from the wrapper
        would centre each line independently and shear the drawing apart.
      */}
      <pre
        aria-hidden="true"
        className="mx-auto w-fit select-none text-left font-mono text-[11px] leading-[1.35] text-ink-faint"
      >
        {ROBOT}
      </pre>
      <p className="text-sm font-medium text-ink-muted">{title}</p>
      {hint && <p className="max-w-md text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-line px-2">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors',
            value === t.id
              ? 'border-accent text-accent'
              : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="ml-1.5 tabular-nums text-ink-faint">{t.count.toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Horizontal proportion bar: labelled segments of a total, with a legend. */
export function Meter({
  segments,
  total,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
  total: number;
}) {
  const safeTotal = total || 1;
  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-raised">
        {segments.map((s) => (
          <div
            key={s.label}
            title={`${s.label}: ${s.value.toLocaleString()}`}
            style={{ width: `${(s.value / safeTotal) * 100}%`, background: s.color }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <li key={s.label} className="flex items-center gap-1.5 text-ink-muted">
              <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
              {s.label}
              <span className="tabular-nums text-ink-faint">{s.value.toLocaleString()}</span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/** Debounced text input used by every table's search box. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [local, setLocal] = useState(value);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => setLocal(value), [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <input
      className="input"
      value={local}
      autoFocus={autoFocus}
      spellCheck={false}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value;
        setLocal(v);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => onChange(v), 120);
      }}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-ink-muted hover:text-ink">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 rounded border-line bg-bg-raised accent-accent"
      />
      {label}
    </label>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-line/60">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[minmax(140px,220px)_1fr] gap-4 px-4 py-2">
          <dt className="text-xs text-ink-faint">{k}</dt>
          <dd className="min-w-0 break-words text-sm text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
