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

/** Small presentation helpers shared across views. */

export function formatBytes(n: number | undefined | null): string {
  if (!n || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatTimestamp(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Abbreviates a hex digest for dense table cells. */
export function shortHash(hash: string | null | undefined, head = 10): string {
  if (!hash) return '—';
  return hash.length <= head + 4 ? hash : `${hash.slice(0, head)}…`;
}

/** Strips the well-known `android.permission.` prefix for readability. */
export function shortPermission(name: string): string {
  return name.replace(/^android\.permission\./, '');
}

/** Last dotted segment, used for component class names. */
export function shortClassName(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * Deterministic colour for a signer hash, so the same signer is visually
 * recognisable across every table in the app.
 */
export function hashColor(hash: string): string {
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (h * 31 + hash.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 58%)`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Triggers a client-side download; nothing is uploaded anywhere. */
export function downloadBlob(filename: string, data: BlobPart, mime = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * RFC4180-ish CSV serialisation, hardened against formula injection.
 *
 * Most cell text comes off the observed device - package labels, component
 * names, permission names - and is chosen by whoever built the APK. A string
 * cell starting with `=`, `+`, `-`, `@`, tab or CR is evaluated as a formula by
 * Excel, LibreOffice and Sheets when the export is opened, so such cells are
 * prefixed with `'`, which the spreadsheet shows as literal text (OWASP's
 * recommended mitigation). Numbers and booleans are emitted untouched, so a
 * genuine negative number stays numeric.
 */
export function toCsv(headers: string[], rows: Array<Array<string | number | boolean | null>>): string {
  const esc = (v: string | number | boolean | null): string => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}
