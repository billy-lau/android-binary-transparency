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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FORM,
  commandLine,
  formToOptions,
  normalize,
  buildArgv,
  shellQuote,
  validateClient,
  type ObserveForm,
} from './options';

interface Case {
  name: string;
  options: unknown;
  argv?: string[];
  errors?: string[];
}

// The same fixture test_options.py runs against server/options.py.
const fixture = JSON.parse(
  readFileSync(new URL('../../../server/tests/option_cases.json', import.meta.url), 'utf8'),
) as { defaultOutput: string; cases: Case[] };

describe('options: shared fixture with server/options.py', () => {
  it('has cases', () => {
    expect(fixture.cases.length).toBeGreaterThan(20);
  });

  for (const c of fixture.cases) {
    it(c.name, () => {
      const { options, errors } = normalize(c.options, fixture.defaultOutput);
      if (c.errors) {
        expect(Object.keys(errors).sort()).toEqual([...c.errors].sort());
      } else {
        expect(errors).toEqual({});
        expect(buildArgv(options!)).toEqual(c.argv);
      }
    });
  }
});

describe('options: browser-only behaviour', () => {
  it('accepts ~ by default, like the helper, which expands it', () => {
    expect(validateClient({ output: '~/out' }, '/d').errors).toEqual({});
  });

  it('refuses ~ without the helper, since nothing can expand it', () => {
    const { errors } = validateClient({ output: '~/out' }, '', { tildeOk: false });
    expect(Object.keys(errors)).toEqual(['output']);
  });

  it('leaves --output out when there is no default and none was given', () => {
    expect(validateClient({}, '').argv).toEqual([]);
  });
});

describe('formToOptions', () => {
  const form = (patch: Partial<ObserveForm>): ObserveForm => ({ ...DEFAULT_FORM, ...patch });
  const argv = (patch: Partial<ObserveForm>) => validateClient(formToOptions(form(patch)), '/d').argv;

  it('defaults to a rebuild with the default output', () => {
    expect(argv({})).toEqual(['--output=/d']);
  });

  it('drops the APK path when rebuilding', () => {
    expect(argv({ hubbleMode: 'rebuild', hubblePath: 'not/checked' })).toEqual(['--output=/d']);
  });

  it('drops everything under a disabled inclusion proof check', () => {
    expect(argv({ proofEnabled: false, verifierPath: 'relative', prefetchTimeout: 'x' })).toEqual([
      '--output=/d',
    ]);
  });

  it('drops pre-fetch tuning when pre-fetching is off, but keeps the cache dir', () => {
    expect(
      argv({
        proofEnabled: true,
        verifierPath: '/v',
        noPrefetch: true,
        cacheDir: '/c',
        prefetchConcurrency: '999',
      }),
    ).toEqual(['--output=/d', '--perform_inclusion_proof_check', '--verifier_path=/v', '--no_prefetch', '--cache_dir=/c']);
  });

  it('turns whole numbers into numbers and reports anything else', () => {
    expect(argv({ proofEnabled: true, verifierPath: '/v', prefetchConcurrency: ' 4 ' })).toContain(
      '--cache_prefetch_concurrency=4',
    );
    const bad = validateClient(
      formToOptions(form({ proofEnabled: true, verifierPath: '/v', prefetchTimeout: '1.5' })),
      '/d',
    );
    expect(Object.keys(bad.errors)).toEqual(['inclusionProof.prefetchTimeout']);
  });

  it('makes the verifier required once the check is on', () => {
    const { errors } = validateClient(formToOptions(form({ proofEnabled: true })), '/d');
    expect(Object.keys(errors)).toEqual(['inclusionProof.verifierPath']);
  });
});

describe('command line', () => {
  it('leaves plain arguments alone and quotes the rest', () => {
    expect(shellQuote('--output=/data/out')).toBe('--output=/data/out');
    expect(shellQuote('--output=/my files')).toBe("'--output=/my files'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('builds a pasteable command', () => {
    expect(commandLine('automate_observation.py', ['--serial=A1', '--output=/a b'])).toBe(
      "python3 automate_observation.py --serial=A1 '--output=/a b'",
    );
  });
});
