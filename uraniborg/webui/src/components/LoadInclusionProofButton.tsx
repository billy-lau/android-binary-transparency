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
 * "The proof run has finished, pick up its results" button.
 *
 * `inclusion_proof_check.py` is a separate and much slower run than Hubble
 * itself, so the common order of events is: pull the observation, open it here,
 * start the proof check, and come back to it. Before this existed the only way
 * to pick up the results was to re-load the whole directory, which throws away
 * the parse of everything else and resets the view.
 *
 * This is a file picker rather than a true reload because the page has no
 * filesystem access — and should not: the app's whole premise is that an
 * observation is read in the tab and never leaves it. So "refresh" means
 * "hand me the one file that is now on disk".
 */

import { useRef, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useApp } from '@/lib/store';
import type { InputFile } from '@/lib/parse';

const PROOF_ARTIFACT = 'packages_with_inclusion_proof_signal.txt';

type Status = { tone: 'good' | 'bad'; text: string } | null;

export function LoadInclusionProofButton({ className }: { className?: string }) {
  const observationId = useApp((s) => s.activeId);
  const mergeInclusionProof = useApp((s) => s.mergeInclusionProof);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const onPick = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || !observationId) return;
    setBusy(true);
    setStatus(null);
    try {
      const files: InputFile[] = await Promise.all(
        Array.from(fileList).map(async (f) => ({ name: f.name, text: await f.text() })),
      );
      const result = mergeInclusionProof(observationId, files);
      // On success the tab re-renders with the merged data underneath this
      // component, so the only thing left to report is a failure.
      if (result.error) setStatus({ tone: 'bad', text: result.error });
    } catch (err) {
      setStatus({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
      // Clear the input so picking the same file twice still fires a change,
      // which is exactly what someone re-running the check will do.
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className={clsx('space-y-2', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="btn"
          disabled={busy || !observationId}
          onClick={() => inputRef.current?.click()}
          title={`Select the ${PROOF_ARTIFACT} produced by a proof run and merge it into this observation. Nothing else is re-read.`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <FileUp size={12} />}
          {busy ? 'Merging…' : 'Load proof results'}
        </button>
        <span className="text-[11px] text-ink-faint">
          Already ran the check? Pick <code className="mono">{PROOF_ARTIFACT}</code> to merge it in
          without reloading the observation.
        </span>
      </div>

      {status && (
        <p
          className={clsx(
            'text-[11px] leading-relaxed',
            status.tone === 'bad' ? 'text-sev-critical' : 'text-sev-ok',
          )}
        >
          {status.text}
        </p>
      )}

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept=".txt,.json"
        multiple
        onChange={(e) => void onPick(e.target.files)}
      />
    </div>
  );
}
