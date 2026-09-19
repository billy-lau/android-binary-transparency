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
 * Pointer-drag width tracking, shared by the table column handles and the panel
 * splitters.
 *
 * Uses pointer capture rather than window listeners so a fast drag that leaves
 * the handle — or the window — keeps tracking and still ends cleanly, and so a
 * second table on the page can never pick up the first one's drag.
 */

import type { PointerEvent as ReactPointerEvent } from 'react';

export function clampPx(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(px)));
}

export interface WidthDragOptions {
  startWidth: number;
  min: number;
  max: number;
  /** +1 when dragging right grows the element, -1 when it shrinks it. */
  direction?: 1 | -1;
  onMove: (px: number) => void;
  onEnd: (px: number) => void;
}

/**
 * Starts tracking a horizontal resize from `event`. Returns false when the
 * gesture is ignored (anything but a primary button).
 */
export function beginWidthDrag(event: ReactPointerEvent<HTMLElement>, options: WidthDragOptions): boolean {
  if (event.button !== 0) return false;
  // Swallow the gesture so it does not also sort a column or select text.
  event.preventDefault();
  event.stopPropagation();

  const handle = event.currentTarget;
  const startX = event.clientX;
  const direction = options.direction ?? 1;
  const widthAt = (clientX: number) =>
    clampPx(options.startWidth + direction * (clientX - startX), options.min, options.max);

  handle.setPointerCapture(event.pointerId);
  // A press with no movement is a click - typically to focus the handle for
  // keyboard nudging - not a resize. Neither callback fires until the pointer
  // actually moves, so a click commits nothing: committing would freeze a fluid
  // `1fr`/`minmax` column at whatever width it happened to render at, and
  // persist that. Callers therefore never see a stray onMove without an onEnd.
  let moved = false;
  const onMove = (e: PointerEvent) => {
    if (!moved && e.clientX === startX) return;
    moved = true;
    options.onMove(widthAt(e.clientX));
  };
  const onEnd = (e: PointerEvent) => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onEnd);
    handle.removeEventListener('pointercancel', onEnd);
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
    if (moved || e.clientX !== startX) options.onEnd(widthAt(e.clientX));
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onEnd);
  handle.addEventListener('pointercancel', onEnd);
  return true;
}
