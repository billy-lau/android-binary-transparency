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
 * Headless smoke test.
 *
 * Boots the production build over a tiny static server, loads the generated
 * sample observations through the real file-input code path, walks every route,
 * asserts there are no console errors, and writes screenshots.
 *
 * Usage: node scripts/smoke.mjs [outputDir]
 */

import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'dist');
const sampleRoot = path.join(root, 'sample-data');
const outDir = path.resolve(process.argv[2] ?? path.join(root, '.smoke'));

// Resolved rather than assumed: puppeteer-core ships no browser of its own, so
// the binary has to come from the host. CHROME_PATH wins when set, which is
// also the escape hatch for a Chromium or a non-standard install.
const CHROME =
  process.env.CHROME_PATH ??
  [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/opt/google/chrome/chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].find(existsSync) ??
  null;

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
};

async function serve() {
  const server = createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const filePath = path.join(dist, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(dist)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

const ROUTES = [
  ['overview', '#/overview'],
  ['packages', '#/packages'],
  ['packages-filtered', '#/packages?platform=1'],
  ['package-detail', '#/packages/com.example.oem.assistant'],
  ['package-permissions', '#/packages/com.example.oem.assistant?tab=permissions'],
  ['package-components', '#/packages/com.example.oem.assistant?tab=components'],
  ['package-integrity', '#/packages/com.google.android.gms?tab=integrity'],
  ['package-transparency', '#/packages/com.google.android.gms?tab=transparency'],
  ['package-transparency-unchecked', '#/packages/com.android.settings?tab=transparency'],
  ['certificates', '#/certificates'],
  ['shared-uids', '#/shared-uids'],
  ['permissions', '#/permissions'],
  ['components', '#/components?unguarded=1'],
  ['integrity', '#/integrity'],
  ['binaries', '#/binaries'],
  ['device', '#/device'],
  ['compare', '#/compare'],
];

async function loadObservation(page, dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.txt'));
  const payload = await Promise.all(
    files.map(async (name) => ({ name, text: await readFile(path.join(dir, name), 'utf8') })),
  );
  // Drive the same store API the UI uses, with real file contents.
  await page.evaluate((inputs) => {
    // @ts-ignore - exposed for smoke testing only
    window.__loadObservation(inputs);
  }, payload);
}

async function main() {
  if (!CHROME)
    throw new Error(
      'No Chrome or Chromium binary found in the usual locations. Set CHROME_PATH to one, e.g.\n' +
        "  CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/smoke.mjs",
    );
  await mkdir(outDir, { recursive: true });
  const { server, port } = await serve();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

    await page.goto(`http://127.0.0.1:${port}/#/load`, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: path.join(outDir, '00-load.png') });

    await loadObservation(page, path.join(sampleRoot, 'gsi-baseline'));
    await loadObservation(page, path.join(sampleRoot, 'pixel-target'));

    for (const [name, hash] of ROUTES) {
      await page.goto(`http://127.0.0.1:${port}/${hash}`, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 250));
      const text = await page.evaluate(() => document.body.innerText);
      if (/No observation loaded|Something went wrong/i.test(text)) {
        errors.push(`${name}: rendered an empty/error state`);
      }
      await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: false });
    }

    // Deep-link a signing certificate page by picking the platform cert.
    const platformHash = await page.evaluate(() => window.__platformCertHash());
    await page.goto(`http://127.0.0.1:${port}/#/certificates/${platformHash}`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 400));
    const certText = await page.evaluate(() => document.body.innerText);
    if (!/Android Platform/.test(certText)) {
      errors.push('certificate-detail: X.509 subject was not decoded');
    }
    if (!/matches the digest Hubble recorded/.test(certText)) {
      errors.push('certificate-detail: SHA-256 fingerprint verification did not pass');
    }
    await page.screenshot({ path: path.join(outDir, 'certificate-detail.png') });

    // Preload delta tab.
    await page.goto(`http://127.0.0.1:${port}/#/compare`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /Preload delta/.test(b.textContent ?? ''),
      );
      btn?.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: path.join(outDir, 'compare-delta.png') });

    // The transparency drill-down exists so an analyst can see the evidence.
    // Assert the reconstructed log payload and the raw record are really there,
    // otherwise the tab is just another badge.
    await page.goto(
      `http://127.0.0.1:${port}/#/packages/com.google.android.gms?tab=transparency`,
      { waitUntil: 'networkidle0' },
    );
    await new Promise((r) => setTimeout(r, 300));
    const proofText = await page.evaluate(() => document.body.innerText);
    if (!/SHA256\(APK\)/.test(proofText)) {
      errors.push('package-transparency: the reconstructed log payload was not rendered');
    }
    if (!/inclusion_proof_verified/.test(proofText)) {
      errors.push('package-transparency: the raw inclusion-proof record was not rendered');
    }

    // A `?tab=` the app does not recognise must say so. Silently falling back to
    // the overview would make a stale or mistyped link look like it worked, and
    // rendering nothing at all would look like a crash.
    await page.goto(`http://127.0.0.1:${port}/#/packages/com.example.oem.assistant?tab=nope`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 250));
    const unknownTab = await page.evaluate(() => document.body.innerText);
    if (!/No tab called/.test(unknownTab)) {
      errors.push('unknown-tab: an unrecognised ?tab= did not report itself');
    }
    if (!/bzzt/.test(unknownTab)) {
      errors.push('unknown-tab: the broken-robot state did not render');
    }
    await page.screenshot({ path: path.join(outDir, 'unknown-tab.png'), fullPage: false });

    // Sorting has to be clearable: unsorted is the order Hubble recorded, which
    // is PackageManager's own enumeration order rather than an arbitrary one.
    await page.goto(`http://127.0.0.1:${port}/#/packages`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    const firstRow = () =>
      page.evaluate(() => {
        const rows = document.querySelectorAll('[role="row"]');
        // rows[0] is the header row; the first data row follows it.
        return rows.length > 1 ? rows[1].innerText.split('\n')[0] : null;
      });
    const clickFirstSortable = () =>
      page.evaluate(() => {
        document.querySelector('[role="columnheader"] button')?.click();
      });

    const recordedOrder = await firstRow();
    await clickFirstSortable();
    await new Promise((r) => setTimeout(r, 150));
    const ascending = await firstRow();
    await clickFirstSortable();
    await new Promise((r) => setTimeout(r, 150));
    await clickFirstSortable();
    await new Promise((r) => setTimeout(r, 150));
    const cleared = await firstRow();

    if (recordedOrder === null) {
      errors.push('packages-sort: could not read a data row');
    } else if (ascending === recordedOrder) {
      errors.push('packages-sort: sorting did not change the first row, so the check is vacuous');
    } else if (cleared !== recordedOrder) {
      errors.push(
        `packages-sort: a third click did not restore the recorded order (${cleared} != ${recordedOrder})`,
      );
    }

    // Switching to the Libraries tab has to actually switch. It once issued two
    // URL updates from the same stale params, so the second silently undid the
    // first and the click did nothing.
    await page.goto(`http://127.0.0.1:${port}/#/binaries?q=sh`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /^Libraries/.test(b.textContent?.trim() ?? ''),
      );
      btn?.click();
    });
    await new Promise((r) => setTimeout(r, 250));
    const libsState = await page.evaluate(() => ({ hash: location.hash, text: document.body.innerText }));
    if (!/tab=libs/.test(libsState.hash) || !/libssl\.so/.test(libsState.text)) {
      errors.push(`binaries: clicking the Libraries tab did not switch to it (${libsState.hash})`);
    } else if (/[?&]q=/.test(libsState.hash)) {
      errors.push('binaries: switching tabs did not clear the previous filter');
    }

    // "Not in" and "partially in" the transparency log are different claims.
    // The sample GMS package has one split in the log and one that is not, so
    // it must be counted as partial - never as absent from the log.
    await page.goto(`http://127.0.0.1:${port}/#/overview`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    const overviewText = await page.evaluate(() => document.body.innerText);
    if (!/Partially in ABT log/i.test(overviewText)) {
      errors.push('overview: there is no separate "Partially in ABT log" tile');
    }
    // The tile counts packages, so it must land on the package list.
    const unguardedHref = await page.evaluate(() => {
      const tile = [...document.querySelectorAll('a')].find((a) => /Unguarded exports/i.test(a.textContent ?? ''));
      return tile?.getAttribute('href') ?? null;
    });
    if (unguardedHref !== '#/packages?unguarded=1') {
      errors.push(`overview: "Unguarded exports" tile links to ${unguardedHref}, expected #/packages?unguarded=1`);
    }

    // `/device#diagnostics` is a route fragment under the hash router, so the
    // page has to scroll to the section itself.
    await page.goto(`http://127.0.0.1:${port}/#/device#diagnostics`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    const diagScroll = await page.evaluate(() => {
      const section = document.getElementById('diagnostics');
      const scroller = section?.closest('.overflow-y-auto');
      if (!section || !scroller) return null;
      const offset = section.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const atBottom = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
      return { offset, atBottom, scrollTop: scroller.scrollTop };
    });
    if (!diagScroll) {
      errors.push('device: no #diagnostics section inside a scroll container');
    } else if (Math.abs(diagScroll.offset) > 4 && !diagScroll.atBottom) {
      errors.push(`device: /device#diagnostics did not scroll to the section (offset ${diagScroll.offset}px)`);
    }
    await page.goto(`http://127.0.0.1:${port}/#/packages?proof=partial`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    const partialText = await page.evaluate(() => document.body.innerText);
    if (!/com\.google\.android\.gms/.test(partialText)) {
      errors.push('packages: ?proof=partial did not list the partially published package');
    }
    await page.goto(`http://127.0.0.1:${port}/#/packages?proof=failed`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 250));
    const failedText = await page.evaluate(() => document.body.innerText);
    if (/com\.google\.android\.gms/.test(failedText)) {
      errors.push('packages: a partially published package was listed as not in the log');
    }

    // The split-name column on the Integrity tab. Split names like
    // `config.arm64_v8a` overflow any fixed width, so the boundary has to be a
    // real drag handle and not just a tooltip.
    await page.goto(`http://127.0.0.1:${port}/#/packages/com.google.android.gms?tab=integrity`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 300));
    const splitHandleSelector = '[aria-label="Resize Split column"]';
    const splitNameWidth = () =>
      page.evaluate(
        (sel) => document.querySelector(sel)?.parentElement?.getBoundingClientRect().width ?? 0,
        splitHandleSelector,
      );
    const splitHandle = await page.$(splitHandleSelector);
    const splitBox = splitHandle && (await splitHandle.boundingBox());
    if (!splitBox) {
      errors.push('package-integrity: the split-name column has no resize handle');
    } else {
      const splitWidthBefore = await splitNameWidth();
      const splitY = splitBox.y + splitBox.height / 2;
      await page.mouse.move(splitBox.x + splitBox.width / 2, splitY);
      await page.mouse.down();
      await page.mouse.move(splitBox.x + splitBox.width / 2 + 120, splitY, { steps: 10 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 200));
      const splitWidthAfter = await splitNameWidth();
      if (splitWidthAfter < splitWidthBefore + 80) {
        errors.push(
          `package-integrity: dragging the split-name boundary did not resize it (${splitWidthBefore} -> ${splitWidthAfter})`,
        );
      }
    }
    await page.screenshot({ path: path.join(outDir, 'package-integrity-resized.png') });

    // Two packages in the sample data record exactly two certificates each, and
    // they mean opposite things. The whole point of consuming signingInfo is
    // that these two pages must not read the same, so assert both.
    await page.goto(`http://127.0.0.1:${port}/#/packages/com.example.oem.assistant`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 300));
    const rotatedText = await page.evaluate(() => document.body.innerText);
    if (!/Key rotated\./i.test(rotatedText)) {
      errors.push('package-detail: a rotation lineage was not resolved as one');
    }
    if (!/RETIRED/.test(rotatedText)) {
      errors.push('package-detail: the retired lineage ancestor was not marked');
    }
    await page.screenshot({ path: path.join(outDir, 'package-key-rotation.png') });

    await page.goto(`http://127.0.0.1:${port}/#/packages/com.nebula.appstore`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 300));
    const coSignedText = await page.evaluate(() => document.body.innerText);
    if (!/Co-signed by 2 certificates\./i.test(coSignedText)) {
      errors.push('package-detail: a co-signed package was not resolved as one');
    }
    if (/RETIRED/.test(coSignedText)) {
      errors.push('package-detail: a co-signer was wrongly rendered as a retired key');
    }
    await page.screenshot({ path: path.join(outDir, 'package-multi-signer.png') });

    // The package that rotated away from the platform key. Android's own
    // checkSignatures() still answers MATCH for it, so this is the one case
    // where the UI must visibly disagree with the recorded verdict.
    await page.goto(`http://127.0.0.1:${port}/#/packages/com.example.oem.launcher`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 300));
    const rotatedAwayText = await page.evaluate(() => document.body.innerText);
    if (!/checkSignatures\(\) vs android: MATCH/.test(rotatedAwayText)) {
      errors.push('package-detail: the recorded checkSignatures verdict was not shown');
    }
    if (/platform-signed/i.test(rotatedAwayText)) {
      errors.push(
        'package-detail: a package that rotated away from the platform key was still badged platform-signed',
      );
    }
    await page.screenshot({ path: path.join(outDir, 'package-rotated-away.png') });

    // The signer table must render the whole hash and let the cell clip it,
    // otherwise widening the resizable column just reveals whitespace. Also
    // check the two roles that used to share the default grey are now
    // distinguishable, and that the subject peek decoded.
    await page.goto(`http://127.0.0.1:${port}/#/certificates`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 400));
    const certTable = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('[role="row"] .mono')];
      const hashes = cells.map((c) => c.textContent?.trim() ?? '').filter((t) => /^[0-9a-f]{8,}/i.test(t));
      const badgeColor = (label) => {
        const el = [...document.querySelectorAll('span')].find(
          (s) => s.textContent?.trim().toLowerCase() === label,
        );
        return el ? getComputedStyle(el).color : null;
      };
      return {
        hashes,
        appSigner: badgeColor('app signer'),
        retiredKey: badgeColor('retired key'),
        text: document.body.textContent ?? '',
      };
    });
    if (!certTable.hashes.length) {
      errors.push('certificates: no signer hashes were rendered');
    } else if (!certTable.hashes.some((h) => h.length === 64)) {
      errors.push(
        `certificates: the hash column is still statically truncated (longest was ${Math.max(
          ...certTable.hashes.map((h) => h.length),
        )} chars)`,
      );
    }
    if (!certTable.appSigner || !certTable.retiredKey) {
      errors.push('certificates: expected both an "app signer" and a "retired key" role badge');
    } else if (certTable.appSigner === certTable.retiredKey) {
      errors.push(
        `certificates: "app signer" and "retired key" still render the same colour (${certTable.appSigner})`,
      );
    }
    // The generator's platform certificate carries this CN, and the O below it
    // comes from a different RDN, so finding both proves the DN was parsed
    // rather than printed raw.
    if (!/Android Platform/.test(certTable.text)) {
      errors.push('certificates: no certificate subject CN was decoded into the table');
    }
    if (!/Example Mobility Corp/.test(certTable.text)) {
      errors.push('certificates: the subject organisation was not shown');
    }
    // The carrier signer's O contains a comma, which a DN string encodes as
    // "O=Orbit Telecom\, Inc.". Splitting that string on commas yields the
    // truncated "Orbit Telecom\", so requiring the whole value proves the
    // attribute was read structurally.
    if (!/Orbit Telecom, Inc\./.test(certTable.text)) {
      errors.push(
        `certificates: an organisation containing a comma was not rendered intact${
          /Orbit Telecom\\/.test(certTable.text) ? ' (it was cut at the escaped comma)' : ''
        }`,
      );
    }
    await page.screenshot({ path: path.join(outDir, 'certificates.png') });

    // Provider guards must read as who can reach each operation. The old
    // "R:none / W:none" said nothing about that, and said it in a way that
    // looked like missing data, so both the abbreviation and the bare "none"
    // are regressions worth failing on.
    await page.goto(
      `http://127.0.0.1:${port}/#/packages/com.example.oem.assistant?tab=components`,
      { waitUntil: 'networkidle0' },
    );
    await new Promise((r) => setTimeout(r, 300));
    const providerText = await page.evaluate(() => {
      const card = [...document.querySelectorAll('section')].find((s) =>
        /^providers \(/i.test(s.querySelector('h2')?.textContent ?? ''),
      );
      return card?.textContent ?? '';
    });
    if (!providerText) {
      errors.push('package-components: no providers card was rendered');
    } else {
      if (/\bR:|\bW:/.test(providerText)) {
        errors.push('package-components: providers still use the unexplained R:/W: abbreviation');
      }
      // CacheProvider guards both operations the same way, so it collapses;
      // DataProvider does not, so it must still print the two separately.
      if (!/read\/write/.test(providerText)) {
        errors.push('package-components: a uniform provider did not collapse to read/write');
      }
      if (!/read\s*com\.example\.oem\.permission\.READ_ASSISTANT_DATA/.test(providerText)) {
        errors.push('package-components: the asymmetric provider did not show its read permission');
      }
      // DataProvider is readable only with a permission but writable by anyone.
      if (!/any app/.test(providerText)) {
        errors.push('package-components: an unguarded exported provider did not say who can reach it');
      }
      // CacheProvider is equally unguarded but not exported, so it must not
      // borrow the same alarm.
      if (!/not enforced/.test(providerText)) {
        errors.push('package-components: an unexported unguarded provider was not distinguished');
      }
      if (!/android:permission/.test(providerText)) {
        errors.push('package-components: the provider legend is missing');
      }
      await page.screenshot({ path: path.join(outDir, 'package-provider-guards.png') });
    }

    // Column resizing: drag the first boundary on the components table and
    // check the column actually grew and the width was remembered. A silently
    // dead drag handle is the obvious failure mode here.
    await page.goto(`http://127.0.0.1:${port}/#/components`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    const headerWidth = () =>
      page.evaluate(() => document.querySelector('[role="columnheader"]')?.getBoundingClientRect().width ?? 0);
    const widthBefore = await headerWidth();
    const handle = await page.$('[role="columnheader"] [role="separator"]');
    const box = handle && (await handle.boundingBox());
    if (!box) {
      errors.push('components: no column resize handle was rendered');
    } else {
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 140, y, { steps: 10 });
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 200));
      const widthAfter = await headerWidth();
      if (widthAfter < widthBefore + 100) {
        errors.push(`components: dragging the column boundary did not resize it (${widthBefore} -> ${widthAfter})`);
      }
      const prefs = await page.evaluate(() => localStorage.getItem('uraniborg-explorer/prefs/v1'));
      if (!prefs || !JSON.parse(prefs)?.columnWidths?.components) {
        errors.push('components: the resized column width was not persisted');
      }
      await page.screenshot({ path: path.join(outDir, 'components-resized.png') });
    }

    // The permissions detail pane gets the same treatment; opening it must also
    // reveal a splitter rather than a hard-coded 380px column.
    await page.goto(`http://127.0.0.1:${port}/#/permissions`, { waitUntil: 'networkidle0' });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => document.querySelector('[role="row"][tabindex="0"]')?.click());
    await new Promise((r) => setTimeout(r, 300));
    const splitters = await page.$$eval('[aria-label="Resize permission details panel"]', (els) => els.length);
    if (splitters !== 1) {
      errors.push(`permissions: expected one detail-pane splitter, found ${splitters}`);
    }
    await page.screenshot({ path: path.join(outDir, 'permissions-detail.png') });

    // Sensitivity tiers are a published judgement, not something Hubble
    // measured, so every view that shows them must say where they came from.
    const citesPaper = (text) => /Preloaded App Risks Scoring Metrics.*Table 2/.test(text);
    for (const [label, route] of [
      ['overview', '/#/overview'],
      ['permissions', '/#/permissions'],
      ['package-permissions', '/#/packages/com.example.oem.assistant?tab=permissions'],
    ]) {
      await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'networkidle0' });
      await new Promise((r) => setTimeout(r, 300));
      const attribution = await page.evaluate(() => ({
        text: document.body.innerText,
        badgeTitles: [...document.querySelectorAll('span[title^="Sensitivity tier"]')].map(
          (s) => s.getAttribute('title') ?? '',
        ),
      }));
      if (!citesPaper(attribution.text)) {
        errors.push(`${label}: sensitivity tiers are shown without citing the paper`);
      }
      if (!attribution.badgeTitles.length) {
        errors.push(`${label}: expected at least one sensitivity badge to check`);
      } else if (!attribution.badgeTitles.every(citesPaper)) {
        errors.push(`${label}: a sensitivity badge tooltip does not cite the paper`);
      }
    }

    // Picking up inclusion-proof results after the fact. The baseline is loaded
    // without a proof artifact, which is the normal state of affairs while the
    // much slower proof run is still going, so it is the right fixture for the
    // empty state and the button that fills it in. Done last, because it
    // switches the active observation.
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) =>
        /AOSP on ARM64/.test(b.textContent ?? ''),
      );
      btn?.click();
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.goto(`http://127.0.0.1:${port}/#/packages/android?tab=transparency`, {
      waitUntil: 'networkidle0',
    });
    await new Promise((r) => setTimeout(r, 300));
    const emptyProofText = await page.evaluate(() => document.body.innerText);
    if (!/No inclusion-proof artifact was loaded/.test(emptyProofText)) {
      errors.push('package-transparency: the baseline should have no proof data to show');
    }
    await page.screenshot({ path: path.join(outDir, 'package-transparency-empty.png') });

    const proofInput = await page.$('input[type="file"]');
    if (!proofInput) {
      errors.push('package-transparency: no way to load proof results after the fact');
    } else {
      await proofInput.uploadFile(
        path.join(sampleRoot, 'pixel-target', 'packages_with_inclusion_proof_signal.txt'),
      );
      await new Promise((r) => setTimeout(r, 500));
      const mergedText = await page.evaluate(() => document.body.innerText);
      if (/No inclusion-proof artifact was loaded/.test(mergedText)) {
        errors.push('package-transparency: merging the proof artifact did not refresh the tab');
      }
      if (!/SHA256\(APK\)/.test(mergedText)) {
        errors.push('package-transparency: the merged observation did not render a lookup payload');
      }
      // A merge is not a reload: the observation must keep its identity, so the
      // switcher still lists exactly the two that were loaded and the baseline
      // is still the one selected.
      if (!/AOSP on ARM64/.test(mergedText) || !/Example P7/.test(mergedText)) {
        errors.push('package-transparency: merging replaced an observation instead of updating it');
      }
      await page.screenshot({ path: path.join(outDir, 'package-transparency-merged.png') });
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (errors.length) {
    console.error('SMOKE FAILURES:');
    for (const e of errors) console.error(' -', e);
    process.exit(1);
  }
  console.log(`Smoke test passed. Screenshots in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
