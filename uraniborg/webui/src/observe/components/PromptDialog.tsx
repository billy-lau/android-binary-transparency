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
 * The script is waiting for the person at the device.
 *
 * It cannot be dismissed: the run does not move until the prompt is resolved,
 * and it closes by itself when the helper reports that it was. Cancelling the
 * run stays possible from inside it.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Hand, Loader2 } from 'lucide-react';
import { api } from '@/observe/lib/api';
import type { PendingPrompt } from '@/observe/lib/events';
import { PROMPT_KINDS } from '@/observe/lib/reasons';

export function PromptDialog({
  runId,
  prompt,
  model,
  footer,
}: {
  runId: string;
  prompt: PendingPrompt;
  model?: string;
  footer: ReactNode;
}) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new prompt starts fresh. A Xiaomi re-ask is the same prompt, so "sent"
  // stays and the hint to try again remains visible.
  useEffect(() => {
    setSent(false);
    setError(null);
  }, [prompt.device, prompt.kind]);

  const confirm = async () => {
    setSending(true);
    setError(null);
    try {
      await api.sendInput(runId);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const device = model ? `${model} (${prompt.device})` : prompt.device;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        className="card flex w-full max-w-lg flex-col gap-4 p-5 shadow-2xl"
      >
        <div className="flex items-center gap-2">
          <Hand size={18} className="text-sev-high" />
          <h2 id="prompt-title" className="text-base font-semibold">
            {PROMPT_KINDS[prompt.kind] ?? 'The script needs you'}
          </h2>
        </div>
        {device && (
          <p className="text-sm text-ink-muted">
            Device: <span className="text-ink">{device}</span>
          </p>
        )}

        {/*
          The script's own text is written for a terminal ("press Enter"), so
          known prompts get wording for this page; unknown ones show it as is.
        */}
        {prompt.kind === 'xiaomi_manual_install' ? (
          <p className="text-sm text-ink">
            On Xiaomi phones Hubble is installed by hand; it has been copied to the device. On the device, open the{' '}
            <strong>Files Manager</strong> app (it may already be open), go to <strong>Downloads</strong> and install
            Hubble.
          </p>
        ) : prompt.kind === 'adb_backup_confirm' ? (
          <p className="text-sm text-ink">
            On the device, tap <strong>Back up my data</strong>. This closes by itself once the backup is done.
          </p>
        ) : (
          prompt.message && (
          <pre className="mono max-h-60 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg px-3 py-2 text-ink-muted">
            {prompt.message}
          </pre>
          )
        )}

        {prompt.expectsInput && (
          <div className="flex flex-col gap-2">
            <button type="button" className="btn btn-primary self-start" onClick={confirm} disabled={sending}>
              {sending && <Loader2 size={13} className="animate-spin" />}
              {prompt.kind === 'xiaomi_manual_install' ? 'I’ve installed Hubble' : 'Continue'}
            </button>
            {sent && (
              <p className="text-xs text-ink-faint">
                Checking… If this stays open, the script did not find what it needs yet. Finish on the device and press
                the button again.
              </p>
            )}
            {error && <p className="text-xs text-sev-critical">{error}</p>}
          </div>
        )}

        <div className="border-t border-line pt-3">{footer}</div>
      </div>
    </div>
  );
}
