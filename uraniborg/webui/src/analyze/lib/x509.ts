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
 * X.509 decoding for Hubble's `certificates.txt` entries.
 *
 * Two things matter for an analyst here:
 *  1. Human-readable identity (subject/issuer/validity/key) so a signer hash
 *     stops being an opaque 64-hex blob.
 *  2. *Independent verification* that the DER blob actually hashes to the
 *     `hash` Hubble reported. Hubble computes that digest on-device; if the
 *     file were tampered with in transit the two would disagree. We recompute
 *     it locally with WebCrypto and show the result.
 */

import { X509Certificate, type Name } from '@peculiar/x509';
import { base64ToBytes, bytesToHex } from './parse';

export interface DecodedCertificate {
  subject: string;
  issuer: string;
  subjectCommonName: string;
  issuerCommonName: string;
  serialNumber: string;
  notBefore: Date;
  notAfter: Date;
  signatureAlgorithm: string;
  publicKeyAlgorithm: string;
  publicKeyBits: number | null;
  /** Subject === issuer, the norm for Android app-signing certs. */
  isSelfSigned: boolean;
  isExpired: boolean;
  isNotYetValid: boolean;
  /** Validity window in whole days. */
  validityDays: number;
  sha256: string;
  sha1: string;
  pem: string;
  der: Uint8Array<ArrayBuffer>;
}

export interface CertificateDecodeResult {
  ok: boolean;
  cert?: DecodedCertificate;
  error?: string;
  /** null when we could not compute; true/false otherwise. */
  fingerprintMatches: boolean | null;
  /**
   * SHA-256 of the DER bytes, set whenever it could be computed — including
   * when the bytes then fail to parse as X.509, which is exactly when
   * `cert` is absent but a fingerprint mismatch still needs reporting.
   */
  derSha256?: string;
}

/**
 * One attribute out of a distinguished name, or null when it is absent.
 *
 * Read from the parsed ASN.1 rather than from the stringified DN. The string
 * form is RFC 4514, which escapes a comma inside a value as `\,` — so a subject
 * of `O=Google, Inc.` prints as `O=Google\, Inc.` and any split-on-comma parse
 * truncates it to `Google\`. Multi-valued RDNs have the same hazard with `+`
 * (`OU=Android+L=Mountain View`), as do the `\XX` hex escapes RFC 4514 allows
 * for non-printable bytes. Going through `getField` sidesteps all three,
 * because the value never gets serialised and re-split.
 *
 * Returns the first value present. An attribute may legitimately repeat, but
 * the places that call this have room for one name and show the full DN beside
 * it.
 */
function nameField(name: Name, type: string): string | null {
  try {
    const first = name.getField(type).find((v) => v.trim() !== '');
    return first ? first.trim() : null;
  } catch {
    // getField rejects a type it cannot map to an OID. Ours are constants, but
    // a certificate carrying a malformed RDN should degrade to "no name" rather
    // than take the page down.
    return null;
  }
}

function commonName(name: Name, dn: string): string {
  return nameField(name, 'CN') ?? (dn || '(no CN)');
}

async function digestHex(
  algorithm: 'SHA-256' | 'SHA-1',
  data: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const buf = await crypto.subtle.digest(algorithm, data);
  return bytesToHex(new Uint8Array(buf));
}

function toPem(b64: string): string {
  const lines = b64.replace(/\s+/g, '').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Decodes a base64 DER certificate and verifies its SHA-256 against
 * `expectedHash` (the value Hubble recorded).
 */
export async function decodeCertificate(
  encodedCert: string,
  expectedHash?: string,
): Promise<CertificateDecodeResult> {
  let der: Uint8Array<ArrayBuffer>;
  try {
    der = base64ToBytes(encodedCert);
  } catch (err) {
    return { ok: false, error: `Invalid base64: ${(err as Error).message}`, fingerprintMatches: null };
  }

  let sha256: string;
  let sha1: string;
  try {
    sha256 = await digestHex('SHA-256', der);
    sha1 = await digestHex('SHA-1', der);
  } catch (err) {
    return { ok: false, error: `Digest failed: ${(err as Error).message}`, fingerprintMatches: null };
  }

  const fingerprintMatches = expectedHash
    ? sha256.toLowerCase() === expectedHash.toLowerCase()
    : null;

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(der);
  } catch (err) {
    return {
      ok: false,
      error: `Not a parsable X.509 certificate: ${(err as Error).message}`,
      fingerprintMatches,
      derSha256: sha256,
    };
  }

  const now = Date.now();
  const notBefore = x509.notBefore;
  const notAfter = x509.notAfter;
  const publicKeyBits =
    (x509.publicKey.algorithm as { modulusLength?: number }).modulusLength ?? null;

  return {
    ok: true,
    fingerprintMatches,
    derSha256: sha256,
    cert: {
      subject: x509.subject,
      issuer: x509.issuer,
      subjectCommonName: commonName(x509.subjectName, x509.subject),
      issuerCommonName: commonName(x509.issuerName, x509.issuer),
      serialNumber: x509.serialNumber,
      notBefore,
      notAfter,
      signatureAlgorithm: describeAlgorithm(x509.signatureAlgorithm),
      publicKeyAlgorithm: describeAlgorithm(x509.publicKey.algorithm),
      publicKeyBits,
      isSelfSigned: x509.subject === x509.issuer,
      isExpired: notAfter.getTime() < now,
      isNotYetValid: notBefore.getTime() > now,
      validityDays: Math.round((notAfter.getTime() - notBefore.getTime()) / 86_400_000),
      sha256,
      sha1,
      pem: toPem(encodedCert),
      der,
    },
  };
}

function describeAlgorithm(alg: Algorithm | KeyAlgorithm): string {
  const a = alg as { name?: string; hash?: { name?: string }; namedCurve?: string };
  const parts = [a.name ?? 'unknown'];
  if (a.hash?.name) parts.push(`with ${a.hash.name}`);
  if (a.namedCurve) parts.push(`(${a.namedCurve})`);
  return parts.join(' ');
}

/** `openssl` one-liner shown on the certificate page for offline follow-up. */
export function opensslHint(hashPrefix: string): string {
  return `openssl x509 -inform der -in ${hashPrefix}.der -noout -text`;
}


/**
 * The self-asserted label on a certificate, without the digest work.
 *
 * `decodeCertificate` above hashes the DER twice, which is right for a detail
 * page and wasteful when a list only wants a name for each of N signers. This
 * parses the ASN.1 and stops, so it can run synchronously inside a memo.
 *
 * > A certificate's subject is **not** an identity claim anyone has checked.
 * > Android app-signing certificates are self-signed, so the CN and O are
 * > whatever the signer typed. Two different keys can both say "Google Inc".
 * > The hash is the identity; this is a hint for recognising it.
 */
export interface CertificateIdentity {
  /** Subject CN, falling back to the whole DN when there is no CN. */
  commonName: string;
  /** Subject O. Often the more recognisable of the two. */
  organization: string | null;
  /** Full subject DN, for a tooltip. */
  subject: string;
}

/**
 * Parsed identities, keyed by the certificate bytes.
 *
 * The certificate list is re-derived on every filter keystroke, and re-parsing
 * every DER each time is the kind of cost that only shows up on a real device
 * with a few hundred signers. Bounded by the number of distinct certificates
 * loaded in a session.
 */
const identityCache = new Map<string, CertificateIdentity | null>();

/** null when there are no bytes to read, or they do not parse. */
export function decodeIdentity(encodedCert: string | null | undefined): CertificateIdentity | null {
  if (!encodedCert) return null;
  const cached = identityCache.get(encodedCert);
  if (cached !== undefined) return cached;

  let identity: CertificateIdentity | null = null;
  try {
    const x509 = new X509Certificate(base64ToBytes(encodedCert));
    identity = {
      commonName: commonName(x509.subjectName, x509.subject),
      organization: nameField(x509.subjectName, 'O'),
      subject: x509.subject,
    };
  } catch {
    // An unparsable certificate has no label to show. The detail page is where
    // the analyst finds out why, so this stays quiet.
    identity = null;
  }
  identityCache.set(encodedCert, identity);
  return identity;
}
