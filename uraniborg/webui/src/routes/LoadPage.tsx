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
 * Observation loader.
 *
 * Accepts a whole Hubble output directory (drag-and-drop or folder picker) or
 * loose files. Everything is read with the File API in the browser; no bytes
 * are transmitted anywhere.
 */

import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, FileUp, ShieldCheck, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/lib/store';
import type { InputFile } from '@/lib/parse';
import { Card } from '@/components/ui';

const ACCEPTED = /\.(txt|json)$/i;

async function readFiles(fileList: File[]): Promise<InputFile[]> {
  const usable = fileList.filter((f) => ACCEPTED.test(f.name));
  return Promise.all(
    usable.map(async (f) => ({ name: f.name, text: await f.text() })),
  );
}

/** Recursively walks a dropped directory entry. */
async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    out.push(file);
    return;
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns at most 100 entries per call.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) await walkEntry(child, out);
    }
  }
}

export function LoadPage() {
  const loadFiles = useApp((s) => s.loadFiles);
  const hasObservations = useApp((s) => s.observations.length > 0);
  const navigate = useNavigate();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const ingest = useCallback(
    async (files: File[], title?: string) => {
      setBusy(true);
      setError(null);
      try {
        const inputs = await readFiles(files);
        if (inputs.length === 0) {
          setError('No .txt or .json files found in that selection.');
          return;
        }
        const outcome = loadFiles(inputs, title);
        if (!outcome.ok) {
          // Nothing was committed, so stay put and explain. Navigating would
          // land on an overview with no packages and no clue why.
          setError(outcome.error);
          return;
        }
        navigate('/overview');
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [loadFiles, navigate],
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const items = Array.from(e.dataTransfer.items ?? []);
      const entries = items
        .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
        .filter((x): x is FileSystemEntry => !!x);

      let files: File[] = [];
      let title: string | undefined;
      if (entries.length > 0) {
        for (const entry of entries) {
          if (entry.isDirectory && !title) title = entry.name;
          await walkEntry(entry, files);
        }
      } else {
        files = Array.from(e.dataTransfer.files);
      }
      await ingest(files, title);
    },
    [ingest],
  );

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Load a Hubble observation</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Drop the output directory produced by <code className="mono">automate_observation.py</code>,
          or pick the individual result files.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={clsx(
          'flex flex-col items-center gap-4 rounded-xl border-2 border-dashed px-8 py-14 transition-colors',
          dragging ? 'border-accent bg-accent/5' : 'border-line bg-bg-soft',
        )}
      >
        {busy ? (
          <Loader2 size={28} className="animate-spin text-accent" />
        ) : (
          <FolderOpen size={28} className={dragging ? 'text-accent' : 'text-ink-faint'} />
        )}
        <p className="text-sm text-ink-muted">
          {busy ? 'Parsing…' : 'Drag a results folder here'}
        </p>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={() => dirInput.current?.click()} disabled={busy}>
            <FolderOpen size={13} /> Choose folder
          </button>
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={busy}>
            <FileUp size={13} /> Choose files
          </button>
        </div>
        <input
          ref={dirInput}
          type="file"
          hidden
          // Non-standard but universally supported directory picker.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          multiple
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            const title = files[0]?.webkitRelativePath?.split('/')[0];
            void ingest(files, title);
            e.target.value = '';
          }}
        />
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept=".txt,.json"
          onChange={(e) => {
            void ingest(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      {error && (
        <div className="rounded-md border border-sev-critical/40 bg-sev-critical/10 px-4 py-2 text-sm text-sev-critical">
          {error}
        </div>
      )}

      <Card title="What gets read">
        <ul className="space-y-1 px-4 py-3 text-xs text-ink-muted">
          {[
            ['packages.txt', 'required — installed packages, permissions, components, signer IDs'],
            ['certificates.txt', 'signing certificates (base64 DER), decoded in-browser'],
            ['build.txt / hardware.txt', 'device identity, API level, security patch level'],
            ['device_properties.txt', 'base64 getprop dump'],
            ['binaries.txt / libraries.txt', 'accessible native binaries and libraries'],
            ['preinstalled_packages.txt', 'used as a fallback if packages.txt is absent'],
            [
              'packages_with_inclusion_proof_signal.txt',
              'binary-transparency inclusion results from inclusion_proof_check.py',
            ],
          ].map(([file, desc]) => (
            <li key={file} className="flex gap-2">
              <code className="mono w-64 shrink-0 text-ink">{file}</code>
              <span>{desc}</span>
            </li>
          ))}
        </ul>
      </Card>

      <p className="flex items-center justify-center gap-2 text-xs text-ink-faint">
        <ShieldCheck size={13} className="text-sev-ok" />
        Fully client-side. Observations are held in memory only and are never uploaded or persisted.
      </p>

      {hasObservations && (
        <button className="btn mx-auto" onClick={() => navigate('/overview')}>
          Back to current observation
        </button>
      )}
    </div>
  );
}
