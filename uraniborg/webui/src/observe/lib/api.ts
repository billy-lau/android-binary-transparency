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
 * Talks to the local helper (server/README.md).
 *
 * The helper prints a URL with its per-process token after `#`, so the token
 * never reaches a server log. On load it is moved into `sessionStorage`
 * (scoped to this tab, gone when it closes) and removed from the address bar.
 *
 * Without a token nothing here makes a request: a page served by a plain
 * static server has no helper behind it, and probing would only produce
 * 404s. The UI then offers the command line instead.
 */

import type { InputFile } from '@/analyze/lib/parse';
import type { RunSnapshot, StreamEntry } from './events';

const TOKEN_KEY = 'uraniborg-explorer/helper-token';
const TOKEN_HEADER = 'X-Uraniborg-Token';

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Moves `?token=` out of the hash URL (`#/path?token=...`) into session
 * storage. Call once, before the router reads the URL.
 */
export function captureTokenFromUrl(): void {
  const hash = window.location.hash;
  const q = hash.indexOf('?');
  if (q < 0) return;
  const params = new URLSearchParams(hash.slice(q + 1));
  const token = params.get('token');
  if (!token) return;
  session()?.setItem(TOKEN_KEY, token);
  params.delete('token');
  const rest = params.toString();
  const cleaned = hash.slice(0, q) + (rest ? `?${rest}` : '');
  window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + cleaned);
}

export function getToken(): string | null {
  return session()?.getItem(TOKEN_KEY) ?? null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const token = getToken();
  if (!token) throw new ApiError(0, 'no_token', 'The helper is not connected.');
  const headers: Record<string, string> = { [TOKEN_HEADER]: token };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
      signal,
      cache: 'no-store',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'unreachable', 'The helper is not reachable. Is it still running?');
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    /* not JSON: e.g. a static server's 404 page */
  }
  if (!response.ok) {
    const error = (parsed.error ?? {}) as { reason?: string; message?: string };
    throw new ApiError(
      response.status,
      error.reason ?? `http_${response.status}`,
      error.message ?? `The helper answered ${response.status}.`,
      parsed,
    );
  }
  return parsed as T;
}

export interface Health {
  helperVersion: string;
  eventsSchema: number;
  scriptPath: string;
  scriptFound: boolean;
  python: string;
  platform: string;
  adbPath?: string;
  activeRun?: string;
  defaults: {
    output: string;
    prefetchConcurrency: number;
    prefetchTimeout: number;
    hubbleLatest?: string;
  };
}

export interface AdbDevice {
  serial: string;
  state: 'device' | 'unauthorized' | 'offline' | 'no permissions' | string;
  model?: string;
  product?: string;
  device?: string;
}

export interface ServerValidation {
  ok: boolean;
  argv: string[];
  errors: Record<string, string>;
  warnings: string[];
}

export interface RunResults {
  dir: string;
  files: InputFile[];
  skipped: Array<{ name: string; reason: string }>;
}

export interface FsEntry {
  name: string;
  dir: boolean;
  exec?: boolean;
  link?: boolean;
}

/** `GET /api/fs/list`: the nearest existing directory to the path asked for. */
export interface FsListing {
  path: string;
  parent?: string;
  home: string;
  /** Set when the path asked for was a file in this directory. */
  selected?: string;
  /**
   * Set when the path asked for does not exist yet: its part below `path`,
   * e.g. "run1" for a new output directory `<path>/run1`.
   */
  missing?: string;
  entries: FsEntry[];
  truncated?: boolean;
}

export type BuildState = 'idle' | 'running' | 'succeeded' | 'failed';

export interface VerifierStatus {
  sourceDir: string;
  sourceFound: boolean;
  /** Where the helper builds it (its cache directory, outside the checkout). */
  binary: string;
  built: boolean;
  go?: string;
  goVersion?: string;
  goRequired?: string;
  goOutdated?: boolean;
  build: { state: BuildState; output: string[]; startedAt?: string; finishedAt?: string; error?: string };
}

export const api = {
  health: (signal?: AbortSignal) => request<Health>('GET', '/health', undefined, signal),
  devices: () => request<{ devices: AdbDevice[] }>('GET', '/devices').then((r) => r.devices),
  validate: (options: unknown, signal?: AbortSignal) =>
    request<ServerValidation>('POST', '/validate', options, signal),
  startRun: (options: unknown) => request<{ id: string; warnings: string[] }>('POST', '/runs', options),
  getRun: (id: string) => request<RunSnapshot>('GET', `/runs/${id}`),
  sendInput: (id: string) => request<{ ok: true }>('POST', `/runs/${id}/input`),
  cancel: (id: string) => request<{ ok: true }>('POST', `/runs/${id}/cancel`),
  results: (id: string, serial: string) =>
    request<RunResults>('GET', `/runs/${id}/results/${encodeURIComponent(serial)}`),
  listDir: (path: string, signal?: AbortSignal) =>
    request<FsListing>('GET', `/fs/list?path=${encodeURIComponent(path)}`, undefined, signal),
  verifier: () => request<VerifierStatus>('GET', '/verifier'),
  buildVerifier: () => request<VerifierStatus>('POST', '/verifier/build'),
};

/**
 * Follows a run's server-sent events until the helper says it is over.
 *
 * `EventSource` reconnects by itself after a dropped connection and resends
 * the last id it saw, so the helper replays only what was missed. Returns a
 * function that stops listening.
 */
/** Failed connection attempts in a row before a stream counts as lost (about 6 s at the helper's 2 s retry). */
const STREAM_MAX_FAILURES = 3;

export function followRun(
  id: string,
  handlers: { onEntry: (entry: StreamEntry) => void; onEnd: () => void; onError: () => void },
): () => void {
  const token = getToken() ?? '';
  const source = new EventSource(`/api/runs/${id}/stream?token=${encodeURIComponent(token)}`);
  const forward = (kind: string) => (e: MessageEvent<string>) => {
    try {
      handlers.onEntry({ id: Number(e.lastEventId), kind, data: JSON.parse(e.data) });
    } catch {
      /* a malformed entry is dropped; the next snapshot corrects the view */
    }
  };
  for (const kind of ['state', 'event', 'log']) source.addEventListener(kind, forward(kind) as EventListener);
  source.addEventListener('end', () => {
    source.close();
    handlers.onEnd();
  });
  // CLOSED means the browser gave up (e.g. a restarted helper refused the
  // token). A helper that has gone away never gets there: the browser keeps
  // retrying in CONNECTING forever. One failed retry is normal (the stream
  // resumes from the last event id), so give up after a few in a row.
  let failures = 0;
  source.onopen = () => {
    failures = 0;
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED || ++failures >= STREAM_MAX_FAILURES) {
      source.close();
      handlers.onError();
    }
  };
  return () => source.close();
}
