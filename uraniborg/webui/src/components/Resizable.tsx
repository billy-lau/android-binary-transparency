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
 * Resizable side panels.
 *
 * Same reasoning as the resizable table columns: the useful width of the
 * navigation rail or a detail pane depends on the data in front of you — fully
 * qualified component class names and `/data/apex/active/...@....decompressed.apex`
 * paths do not fit any default anyone can pick in advance.
 */

import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import clsx from 'clsx';
import { useApp } from '@/lib/store';
import { beginWidthDrag, clampPx } from '@/lib/resize';

const KEYBOARD_STEP_PX = 16;

export interface ResizablePanel {
  /** Current width in px, to apply to the panel element. */
  width: number;
  /** True while the pointer is down; use it to suppress text selection. */
  resizing: boolean;
  /** Spread onto a {@link PanelResizer}. */
  resizerProps: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
  };
}

/**
 * Tracks one panel's width, persisting it under `panelId`.
 *
 * `edge` says which side of the panel the handle sits on, which is what decides
 * whether dragging right grows or shrinks it.
 */
export function useResizablePanel(
  panelId: string,
  { defaultWidth, min, max, edge }: { defaultWidth: number; min: number; max: number; edge: 'start' | 'end' },
): ResizablePanel {
  const stored = useApp((s) => s.prefs.panelWidths[panelId]);
  const setPanelWidth = useApp((s) => s.setPanelWidth);
  const [drag, setDrag] = useState<number | null>(null);

  const width = clampPx(drag ?? stored ?? defaultWidth, min, max);
  const nudge = (delta: number) => setPanelWidth(panelId, clampPx(width + delta, min, max));

  return {
    width,
    resizing: drag !== null,
    resizerProps: {
      onPointerDown: (e) =>
        beginWidthDrag(e, {
          startWidth: width,
          min,
          max,
          // A handle on the panel's leading edge grows it as the pointer moves left.
          direction: edge === 'start' ? -1 : 1,
          onMove: setDrag,
          onEnd: (px) => {
            setPanelWidth(panelId, px);
            setDrag(null);
          },
        }),
      onDoubleClick: () => setPanelWidth(panelId, null),
      onKeyDown: (e) => {
        if (e.key === 'ArrowLeft') nudge(edge === 'start' ? KEYBOARD_STEP_PX : -KEYBOARD_STEP_PX);
        else if (e.key === 'ArrowRight') nudge(edge === 'start' ? -KEYBOARD_STEP_PX : KEYBOARD_STEP_PX);
        else if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Delete') setPanelWidth(panelId, null);
        else return;
        e.preventDefault();
      },
      'aria-valuenow': width,
      'aria-valuemin': min,
      'aria-valuemax': max,
    },
  };
}

/** The visible grab strip. Sits on the panel boundary; 6px wide to stay hittable. */
export function PanelResizer({
  label,
  active,
  className,
  ...props
}: ResizablePanel['resizerProps'] & { label: string; active?: boolean; className?: string }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      title="Drag to resize · double-click or Enter to reset · arrow keys to nudge"
      className={clsx(
        'group relative w-1.5 shrink-0 cursor-col-resize focus:outline-none',
        active ? 'bg-accent/60' : 'bg-transparent hover:bg-accent/40 focus:bg-accent/40',
        className,
      )}
      {...props}
    />
  );
}
