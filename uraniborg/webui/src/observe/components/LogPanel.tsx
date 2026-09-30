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
 * The run log: filterable, searchable, following new lines like a terminal.
 * It lives in memory only; **Download log** is the way to keep it.
 */

import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import clsx from 'clsx';
import { Card, SearchInput } from '@/shared/components/ui';
import { DataTable, type Column } from '@/shared/components/DataTable';
import { downloadBlob } from '@/shared/lib/format';
import { logText, type LogEntry } from '@/observe/lib/events';

const LEVEL_RANK: Record<string, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };

const LEVEL_FILTERS = [
  { id: 'all', label: 'Everything', min: 0 },
  { id: 'info', label: 'Info and above', min: 20 },
  { id: 'warning', label: 'Warnings and errors', min: 30 },
  { id: 'error', label: 'Errors only', min: 40 },
] as const;

type LevelFilter = (typeof LEVEL_FILTERS)[number]['id'];

interface Row {
  n: number;
  entry: LogEntry;
}

/** Lines without a level (plain script output, helper notes) count as info. */
function rank(entry: LogEntry): number {
  return LEVEL_RANK[entry.level ?? ''] ?? 20;
}

/** Local wall-clock time with milliseconds; the full timestamp is in the download. */
function time(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

const COLUMNS: Array<Column<Row>> = [
  {
    id: 'time',
    header: 'Time',
    width: '130px',
    render: (r) => <span className="mono text-ink-faint">{time(r.entry.ts)}</span>,
  },
  {
    id: 'level',
    header: 'Level',
    width: '90px',
    render: (r) => {
      const k = rank(r.entry);
      return (
        <span
          className={clsx(
            'mono',
            k >= 40 ? 'text-sev-critical' : k >= 30 ? 'text-sev-high' : k <= 10 ? 'text-ink-faint' : 'text-ink-muted',
          )}
        >
          {r.entry.level ?? r.entry.source}
        </span>
      );
    },
  },
  {
    id: 'message',
    header: 'Message',
    width: 'minmax(300px, 1fr)',
    render: (r) => (
      <span className={clsx('mono', r.entry.anomaly ? 'text-sev-high' : 'text-ink')} title={r.entry.message}>
        {r.entry.message}
      </span>
    ),
  },
  {
    id: 'where',
    header: 'Where',
    width: '200px',
    render: (r) =>
      r.entry.file ? (
        <span className="mono text-ink-faint">
          {r.entry.file}:{r.entry.line}
        </span>
      ) : (
        <span className="mono text-ink-faint">{r.entry.source}</span>
      ),
  },
];

export function LogPanel({ runId, logs, dropped }: { runId: string; logs: LogEntry[]; dropped: number }) {
  const [level, setLevel] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const min = LEVEL_FILTERS.find((f) => f.id === level)?.min ?? 0;
    const q = query.trim().toLowerCase();
    const out: Row[] = [];
    logs.forEach((entry, i) => {
      if (rank(entry) < min && !entry.anomaly) return;
      if (q && !entry.message.toLowerCase().includes(q)) return;
      out.push({ n: dropped + i, entry });
    });
    return out;
  }, [logs, dropped, level, query]);

  return (
    <Card
      title="Log"
      actions={
        <button
          type="button"
          className="btn"
          disabled={logs.length === 0}
          onClick={() => downloadBlob(`uraniborg-run-${runId}.log`, logText(logs), 'text/plain')}
        >
          <Download size={13} />
          Download log
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <select
          className="input w-auto"
          value={level}
          onChange={(e) => setLevel(e.target.value as LevelFilter)}
          aria-label="Log level"
        >
          {LEVEL_FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <div className="min-w-[200px] flex-1">
          <SearchInput value={query} onChange={setQuery} placeholder="Search the log" />
        </div>
      </div>
      {dropped > 0 && (
        <p className="border-b border-line px-3 py-1.5 text-xs text-ink-faint">
          The first {dropped.toLocaleString()} lines are no longer kept, here or in the download.
        </p>
      )}
      <DataTable
        rows={rows}
        columns={COLUMNS}
        rowKey={(r) => String(r.n)}
        rowHeight={28}
        maxHeight="420px"
        tableId="observe-log"
        emptyMessage={logs.length === 0 ? 'Nothing logged yet.' : 'No line matches.'}
        stickToBottom
      />
    </Card>
  );
}
