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
 * A path text field with a **Browse…** button, and the dialog behind it.
 *
 * A browser never tells a page the real path of a file the user picks, so
 * the dialog lists directories through the helper instead
 * (`GET /api/fs/list`). Without the helper there is no Browse button; the
 * field is plain text.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, File, FileCode2, Folder, FolderOpen, Home, Link2, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { Toggle } from '@/shared/components/ui';
import { api, type FsEntry, type FsListing } from '@/observe/lib/api';
import { joinPath, listingTarget, listingText, pickedPath, type PickMode } from '@/observe/lib/browse';

export type { PickMode };

export interface BrowseOptions {
  mode: PickMode;
  /** Dialog title, e.g. "Choose the Hubble APK". */
  title: string;
  /** Files that look right for this field are emphasised; others stay pickable. */
  looksRight?: (entry: FsEntry) => boolean;
  /** Where to start when the field is blank. Default: the home directory. */
  fallbackStart?: string;
}

export function PathField({
  value,
  onChange,
  placeholder,
  browse,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Omit to show a plain field (no helper to list directories). */
  browse?: BrowseOptions;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex gap-2">
      <input
        className="input mono"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {browse && (
        <button type="button" className="btn shrink-0" onClick={() => setOpen(true)}>
          <FolderOpen size={13} />
          Browse…
        </button>
      )}
      {browse &&
        open &&
        // A portal, so the dialog is not inside the field's <label> in the
        // DOM: a click on it would otherwise focus the text field.
        createPortal(
          <PathBrowser
          {...browse}
          start={value.trim() || browse.fallbackStart || ''}
          onPick={(path) => {
            onChange(path);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

const join = joinPath;

function PathBrowser({
  mode,
  title,
  looksRight,
  start,
  onPick,
  onClose,
}: BrowseOptions & { start: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [typed, setTyped] = useState(start);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(
    async (path: string) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError(null);
      try {
        const next = await api.listDir(path, controller.signal);
        setListing(next);
        setTyped(listingText(next, mode, next.selected ?? null));
        setSelected(next.selected ?? null);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError((err as Error).message);
      } finally {
        if (request.current === controller) setLoading(false);
      }
    },
    [mode],
  );

  useEffect(() => {
    void load(start);
    return () => request.current?.abort();
  }, [load, start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const entries = (listing?.entries ?? []).filter(
    (e) => showHidden || !e.name.startsWith('.') || e.name === selected,
  );
  const hiddenCount = (listing?.entries.length ?? 0) - entries.length;
  const picked = pickedPath(typed, listing, mode, selected);
  // Say what Choose will do when it is not simply "the folder or file shown".
  const typedWins = !!listing && picked !== null && picked !== listingTarget(listing, mode, selected);
  const newFolder = !typedWins && mode === 'dir' ? listing?.missing : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label={title} className="card flex max-h-[85vh] w-full max-w-2xl flex-col shadow-2xl">
        <header className="card-head">
          <h2 className="text-sm font-semibold">{title}</h2>
          {loading && <Loader2 size={14} className="animate-spin text-ink-faint" />}
        </header>

        <div className="flex gap-2 border-b border-line px-4 py-2">
          <button
            type="button"
            className="btn"
            title="Up one folder"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && load(listing.parent)}
          >
            <ArrowUp size={13} />
          </button>
          <button
            type="button"
            className="btn"
            title="Home folder"
            disabled={!listing}
            onClick={() => listing && load(listing.home)}
          >
            <Home size={13} />
          </button>
          <form
            className="min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              void load(typed);
            }}
          >
            <input
              className="input mono"
              spellCheck={false}
              value={typed}
              aria-label="Path"
              onChange={(e) => setTyped(e.target.value)}
            />
          </form>
        </div>

        {error && <p className="border-b border-line px-4 py-2 text-xs text-sev-critical">{error}</p>}

        <ul className="min-h-[240px] flex-1 overflow-y-auto py-1" role="listbox" aria-label="Folder contents">
          {entries.map((e) => {
            const pickable = e.dir || mode === 'file';
            const isSelected = !e.dir && e.name === selected;
            const good = !e.dir && looksRight?.(e);
            return (
              <li key={e.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={!pickable}
                  className={clsx(
                    'flex w-full items-center gap-2 px-4 py-1 text-left text-sm',
                    isSelected ? 'bg-accent/15 text-accent' : 'hover:bg-bg-hover',
                    !pickable && 'cursor-default opacity-40 hover:bg-transparent',
                  )}
                  onClick={() => {
                    if (!listing) return;
                    if (e.dir) void load(join(listing.path, e.name));
                    else {
                      setSelected(e.name);
                      setTyped(join(listing.path, e.name));
                    }
                  }}
                  onDoubleClick={() => {
                    if (listing && !e.dir && mode === 'file') onPick(join(listing.path, e.name));
                  }}
                >
                  {e.dir ? (
                    <Folder size={14} className="shrink-0 text-accent" />
                  ) : e.exec ? (
                    <FileCode2 size={14} className="shrink-0 text-ink-muted" />
                  ) : (
                    <File size={14} className="shrink-0 text-ink-faint" />
                  )}
                  <span className={clsx('mono truncate', good && !isSelected && 'text-ink', !good && !e.dir && !isSelected && 'text-ink-muted')}>
                    {e.name}
                  </span>
                  {e.link && <Link2 size={11} className="shrink-0 text-ink-faint" aria-label="link" />}
                </button>
              </li>
            );
          })}
          {listing && entries.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-ink-faint">This folder is empty.</li>
          )}
        </ul>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
          <Toggle
            checked={showHidden}
            onChange={setShowHidden}
            label={hiddenCount > 0 ? `Show hidden (${hiddenCount})` : 'Show hidden'}
          />
          {listing?.truncated && <span className="text-xs text-sev-high">Only the first entries are shown.</span>}
          <span className="min-w-0 flex-1 text-xs text-ink-faint">
            {newFolder && (
              <>
                <span className="mono text-ink-muted">{newFolder}</span> does not exist yet; the run creates it.
              </>
            )}
            {typedWins && 'Uses the path typed above. Press Enter to open it instead.'}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!picked}
            onClick={() => picked && onPick(picked)}
          >
            {mode === 'dir' ? 'Choose this folder' : 'Choose'}
          </button>
        </footer>
      </div>
    </div>
  );
}
