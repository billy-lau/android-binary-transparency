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
 * Draggable column-width handle.
 *
 * Extracted from DataTable so that every resizable boundary in the app behaves
 * identically — drag to size, double-click or Enter to reset, arrow keys to
 * nudge. A resize affordance that works one way in tables and another way in a
 * list is worse than one that only exists in tables, because the analyst has to
 * rediscover it.
 *
 * Positioned absolutely against the right edge of its container, so the
 * container must be `relative`.
 */

import clsx from 'clsx';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { beginWidthDrag, clampPx } from '@/lib/resize';

/** Narrow enough to park a column out of the way, wide enough to stay grabbable. */
export const MIN_COLUMN_PX = 56;
export const MAX_COLUMN_PX = 1400;
const KEYBOARD_STEP_PX = 16;

export function ResizeHandle({
  label,
  measure,
  onDrag,
  onCommit,
  active = false,
  min = MIN_COLUMN_PX,
  max = MAX_COLUMN_PX,
}: {
  /** Column name; used for the accessible label and nothing else. */
  label: string;
  /** Current rendered width. Used as the drag origin and for keyboard nudges. */
  measure: () => number;
  /** Fires continuously during the gesture so the layout can follow the pointer. */
  onDrag: (px: number) => void;
  /** Fires once the gesture ends. `null` means "back to the default width". */
  onCommit: (px: number | null) => void;
  /** True while this particular handle is being dragged. */
  active?: boolean;
  min?: number;
  max?: number;
}) {
  const nudge = (delta: number) => onCommit(clampPx(measure() + delta, min, max));

  const onPointerDown = (event: ReactPointerEvent<HTMLSpanElement>) => {
    beginWidthDrag(event, {
      startWidth: measure(),
      min,
      max,
      onMove: onDrag,
      onEnd: onCommit,
    });
  };

  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      tabIndex={0}
      title="Drag to resize · double-click or Enter to reset · arrow keys to nudge"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCommit(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') nudge(-KEYBOARD_STEP_PX);
        else if (e.key === 'ArrowRight') nudge(KEYBOARD_STEP_PX);
        else if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') onCommit(null);
        else return;
        e.preventDefault();
      }}
      className="group absolute right-0 top-0 z-10 flex h-full w-3 cursor-col-resize items-center justify-end focus:outline-none"
    >
      <span
        className={clsx(
          'h-1/2 w-px transition-colors',
          active ? 'bg-accent' : 'bg-line group-hover:bg-accent group-focus:bg-accent',
        )}
      />
    </span>
  );
}
