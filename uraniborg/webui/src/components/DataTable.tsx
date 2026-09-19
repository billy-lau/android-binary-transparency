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
 * Virtualised data table.
 *
 * A Hubble observation routinely contains 400+ packages with thousands of
 * components; rendering every row kills interactivity. This wraps
 * @tanstack/react-virtual with a sticky header, keyboard-navigable rows and
 * click-through-to-detail semantics.
 *
 * Columns are user-resizable. Package names, class names and install paths have
 * no useful upper bound on length, so any fixed default is wrong for someone:
 * the analyst drags the boundary instead of hovering cell by cell for the
 * `title` tooltip. Widths persist per table (see `tableId`) because a column
 * layout you had to set up again on every visit is worse than no layout at all.
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/lib/store';
import { ResizeHandle } from '@/components/ResizeHandle';

export interface Column<T> {
  id: string;
  header: string;
  /** CSS grid track, e.g. `'120px'` or `'minmax(200px, 1.5fr)'`. Defaults to `1fr`. */
  width?: string;
  align?: 'left' | 'right';
  /** Sort key extractor; omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  render: (row: T) => ReactNode;
  title?: string;
}

export interface SortState {
  columnId: string;
  direction: 'asc' | 'desc';
}

const NO_WIDTHS: Record<string, number> = {};

/**
 * The smallest width a grid track can resolve to. Summing these gives the
 * header and the rows a common minimum, so once the columns no longer fit they
 * overflow together and scroll together instead of drifting apart.
 */
function trackMinPx(track: string): number {
  const fixed = /^\s*(\d+(?:\.\d+)?)px\s*$/.exec(track);
  if (fixed) return Number(fixed[1]);
  const minmax = /^\s*minmax\(\s*(\d+(?:\.\d+)?)px/.exec(track);
  if (minmax) return Number(minmax[1]);
  // `1fr` and friends: cells are `min-w-0 truncate`, so they can collapse.
  return 0;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  isRowClickable,
  initialSort,
  rowHeight = 38,
  emptyMessage = 'No matching rows.',
  maxHeight = 'calc(100vh - 260px)',
  tableId,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /**
   * Opts individual rows out of {@link onRowClick}. Such rows are neither
   * focusable nor styled as clickable, so a row with nowhere to go does not
   * pretend otherwise. Defaults to every row being clickable.
   */
  isRowClickable?: (row: T) => boolean;
  initialSort?: SortState;
  rowHeight?: number;
  emptyMessage?: string;
  maxHeight?: string;
  /** Stable id used to remember this table's column widths across visits. */
  tableId?: string;
}) {
  const [sort, setSort] = useState<SortState | undefined>(initialSort);
  const parentRef = useRef<HTMLDivElement>(null);
  const headerScrollRef = useRef<HTMLDivElement>(null);
  const headerCells = useRef<Record<string, HTMLDivElement | null>>({});

  // Committed widths: persisted when the table is identified, in-memory
  // otherwise. `drag` holds the width while the pointer is still down so a
  // resize never writes to storage on every mouse move.
  const storedWidths = useApp((s) => (tableId ? s.prefs.columnWidths[tableId] : undefined));
  const setColumnWidth = useApp((s) => s.setColumnWidth);
  const resetColumnWidths = useApp((s) => s.resetColumnWidths);
  const [localWidths, setLocalWidths] = useState<Record<string, number>>(NO_WIDTHS);
  const [drag, setDrag] = useState<{ columnId: string; px: number } | null>(null);

  const widths = tableId ? (storedWidths ?? NO_WIDTHS) : localWidths;

  const commitWidth = (columnId: string, px: number | null) => {
    if (tableId) {
      setColumnWidth(tableId, columnId, px);
      return;
    }
    setLocalWidths((w) => {
      const next = { ...w };
      if (px === null) delete next[columnId];
      else next[columnId] = px;
      return next;
    });
  };

  const resetWidths = () => {
    if (tableId) resetColumnWidths(tableId);
    else setLocalWidths(NO_WIDTHS);
  };

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.columnId);
    if (!col?.sortValue) return rows;
    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, columns, sort]);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
  });

  /**
   * Cycles ascending → descending → unsorted.
   *
   * The third step matters: unsorted is the order Hubble wrote the records in,
   * which is `PackageManager`'s own enumeration order rather than an arbitrary
   * shuffle. Without a way back to it, reading the artifact as it was recorded
   * would mean reloading the observation.
   */
  const toggleSort = (col: Column<T>) => {
    if (!col.sortValue) return;
    setSort((s) => {
      if (s?.columnId !== col.id) return { columnId: col.id, direction: 'asc' };
      if (s.direction === 'asc') return { columnId: col.id, direction: 'desc' };
      return undefined;
    });
  };

  const sortTitle = (col: Column<T>) => {
    if (col.title) return col.title;
    if (!col.sortValue) return col.header;
    if (sort?.columnId !== col.id) return `Sort by ${col.header}`;
    return sort.direction === 'asc'
      ? `Sort by ${col.header}, descending`
      : `Clear sort, back to default order`;
  };

  // The rendered width, not the stored one: an un-resized column has no stored
  // width, and nudging it from a made-up default would jump before it moved.
  const measuredWidth = (columnId: string) =>
    headerCells.current[columnId]?.getBoundingClientRect().width ?? widths[columnId] ?? 160;

  const tracks = columns.map((c) => {
    const px = drag?.columnId === c.id ? drag.px : widths[c.id];
    return px ? `${px}px` : (c.width ?? '1fr');
  });
  const gridTemplate = tracks.join(' ');
  const minTableWidth = tracks.reduce((sum, t) => sum + trackMinPx(t), 0);
  const resized = columns.some((c) => widths[c.id] !== undefined);

  return (
    <div role="table" className={clsx('flex min-h-0 flex-col', drag && 'select-none')}>
      <div role="rowgroup" ref={headerScrollRef} className="overflow-hidden border-b border-line bg-bg-soft">
        <div role="row" className="grid" style={{ gridTemplateColumns: gridTemplate, minWidth: minTableWidth }}>
          {columns.map((col) => {
            const active = sort?.columnId === col.id;
            const resizing = drag?.columnId === col.id;
            return (
              <div
                key={col.id}
                role="columnheader"
                ref={(el) => {
                  headerCells.current[col.id] = el;
                }}
                className="relative flex min-w-0"
              >
                <button
                  type="button"
                  title={sortTitle(col)}
                  onClick={() => toggleSort(col)}
                  className={clsx(
                    'flex min-w-0 flex-1 items-center gap-1 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide',
                    col.align === 'right' ? 'justify-end' : 'justify-start',
                    col.sortValue ? 'cursor-pointer hover:text-ink' : 'cursor-default',
                    active ? 'text-accent' : 'text-ink-muted',
                  )}
                >
                  <span className="truncate">{col.header}</span>
                  {col.sortValue &&
                    (active ? (
                      sort?.direction === 'asc' ? (
                        <ArrowUp size={11} />
                      ) : (
                        <ArrowDown size={11} />
                      )
                    ) : (
                      <ChevronsUpDown size={11} className="opacity-30" />
                    ))}
                </button>
                <ResizeHandle
                  label={col.header}
                  active={resizing}
                  measure={() => measuredWidth(col.id)}
                  onDrag={(px) => setDrag({ columnId: col.id, px })}
                  onCommit={(px) => {
                    commitWidth(col.id, px);
                    setDrag(null);
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="px-4 py-12 text-center text-sm text-ink-faint">{emptyMessage}</div>
      ) : (
        <div
          ref={parentRef}
          className="overflow-auto"
          style={{ maxHeight }}
          // The header lives outside this box so it stays put vertically; keep
          // it aligned when resized columns push the grid wider than the card.
          onScroll={(e) => {
            const header = headerScrollRef.current;
            if (header) header.scrollLeft = e.currentTarget.scrollLeft;
          }}
        >
          <div
            role="rowgroup"
            style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: minTableWidth }}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const row = sorted[vi.index];
              const clickable = !!onRowClick && (isRowClickable?.(row) ?? true);
              return (
                <div
                  key={rowKey(row)}
                  role="row"
                  tabIndex={clickable ? 0 : -1}
                  onClick={clickable ? () => onRowClick?.(row) : undefined}
                  onKeyDown={(e) => {
                    if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onRowClick?.(row);
                    }
                  }}
                  className={clsx(
                    'absolute left-0 top-0 grid w-full items-center border-b border-line/40',
                    clickable && 'cursor-pointer hover:bg-bg-hover/70',
                  )}
                  style={{
                    height: vi.size,
                    transform: `translateY(${vi.start}px)`,
                    gridTemplateColumns: gridTemplate,
                  }}
                >
                  {columns.map((col) => (
                    <div
                      key={col.id}
                      role="cell"
                      className={clsx(
                        'min-w-0 truncate px-3 text-sm',
                        col.align === 'right' && 'text-right tabular-nums',
                      )}
                    >
                      {col.render(row)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
        <span>
          {sorted.length.toLocaleString()} row{sorted.length === 1 ? '' : 's'}
        </span>
        {resized && (
          <button type="button" className="link text-[11px]" onClick={resetWidths}>
            Reset column widths
          </button>
        )}
      </div>
    </div>
  );
}
