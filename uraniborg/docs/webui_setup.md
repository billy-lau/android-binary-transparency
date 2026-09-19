# How to set up and run Uraniborg Explorer

[Uraniborg Explorer](../webui/README.md) is the web UI for reading Hubble
observations. It is a single-page app that runs entirely in your browser: there
is no server, no database and no account.

Building and serving it does, however, need a **Node.js toolchain**, the same
way Hubble needs Android Studio. This page walks through everything from an
empty machine to a loaded observation, in order. If you already have Node 20+
installed, skip to [step 3](#step-3--get-the-code).

## Prerequisites

| What | Version | Needed for | Check with |
| :--- | :--- | :--- | :--- |
| **Node.js** | 20 or newer (an LTS release recommended) | required — builds and serves the app | `node --version` |
| **npm** | 9 or newer (ships with Node) | required — installs dependencies | `npm --version` |
| **A modern browser** | Chrome/Edge 100+, Firefox 100+, Safari 16+ | required — the app uses WebCrypto and the File/Directory APIs | — |
| **Network access to `registry.npmjs.org`** | — | required **once**, for `npm install` | `npm ping` |
| **Python 3.8+ and `openssl`** | — | optional — generating synthetic sample data | `python3 --version`, `openssl version` |
| **Google Chrome + Node 22.12+** | — | optional — the end-to-end smoke test | `google-chrome --version` |

> [!NOTE]
> Nothing is installed system-wide by this project. Everything lands in
> `uraniborg/webui/node_modules/`, which is git-ignored and can be deleted at
> any time.

## Step 1 — Install Node.js

Pick the row that matches your machine. If you are unsure, use **nvm**: it
installs Node into your home directory, needs no `sudo`, and lets you switch
versions later.

### macOS / Linux — nvm (recommended)

```bash
# Check https://github.com/nvm-sh/nvm for the current installer URL.
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# Restart the shell, or:
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"

nvm install --lts
nvm use --lts
```

### macOS — Homebrew

```bash
brew install node
```

### Debian / Ubuntu — apt

```bash
sudo apt-get install -y nodejs npm
```

> [!WARNING]
> Distro packages are often several major versions behind. If
> `node --version` reports anything below `v20`, use nvm (above) or
> [NodeSource](https://github.com/nodesource/distributions) instead — the build
> will fail on older runtimes.

### Fedora / RHEL

```bash
sudo dnf install -y nodejs npm
```

### Windows

```powershell
winget install OpenJS.NodeJS.LTS
```

or download the LTS installer from [nodejs.org](https://nodejs.org/en/download).
Under WSL, follow the Linux instructions inside the WSL shell instead.

## Step 2 — Verify the toolchain

Open a **new** terminal (so the updated `PATH` is picked up) and run:

```bash
node --version    # expect v20.0.0 or newer
npm --version     # expect 9.x or newer
```

If either says `command not found`, Node is not on your `PATH` yet: restart the
terminal, or re-run the `export NVM_DIR=...` line from step 1.

## Step 3 — Get the code

If you have not cloned this repository yet, do that first (`git clone <repo
URL>`), then:

```bash
cd android-binary-transparency/uraniborg/webui
```

Every command from here on is run from that `uraniborg/webui` directory.

## Step 4 — Install dependencies

```bash
npm install
```

This is the **only step that needs the network**. It downloads the build
toolchain and libraries into `node_modules/` (about 180 MB, 30–90 s on a first
run) and prints a summary like `added 265 packages in 41s`. Warnings about
optional or deprecated transitive packages are normal.

To install exactly the versions pinned in `package-lock.json` — what you want on
a review or CI machine — use `npm ci` instead.

<details>
<summary>Behind a corporate proxy?</summary>

```bash
npm config set proxy http://proxy.example.com:8080
npm config set https-proxy http://proxy.example.com:8080
```

</details>

## Step 5 — (Optional) Generate sample data

No device to hand? This writes two complete synthetic observations so you can
explore the UI, including the Compare view:

```bash
python3 scripts/generate_sample_data.py
```

It needs `openssl` on the `PATH` because it mints **real** self-signed X.509
certificates, so the certificate decoder and fingerprint check are exercised on
genuine DER. Output lands in `sample-data/pixel-target/` and
`sample-data/gsi-baseline/` (both git-ignored).

## Step 6 — Start the app

```bash
npm run dev
```

You should see:

```
  VITE v5.4.x  ready in 420 ms
  ➜  Local:   http://localhost:5173/
```

Open that URL. Stop the server with <kbd>Ctrl-C</kbd>.

If port 5173 is taken, pick another one: `npm run dev -- --port 5174`.

## Step 7 — Load an observation

On the landing page you have three options:

1. **Drag a results folder** onto the drop zone — the directory
   `automate_observation.py` wrote, e.g.
   `results/<device-serial>/<timestamp>/`.
2. **Choose folder** — the same thing via a file picker.
3. **Choose files** — pick individual `*.txt` files if your artifacts are
   scattered.

`packages.txt` is the only required file; everything else enriches the view.
Files are identified by their JSON shape, so renaming `.txt` to `.json` is fine.
Nothing is uploaded — parsing happens in the page, and the app ships a
`default-src 'none'` Content Security Policy so it *cannot* reach the network.

Once it loads you land on **Overview**. Good first moves:

- click any coloured **signer chip** to open that certificate, see its decoded
  X.509 and every package it signs;
- press <kbd>⌘K</kbd> / <kbd>Ctrl-K</kbd> and paste a package name or a raw
  SHA-256;
- load a second observation (a GSI/AOSP build at the same API level) and open
  **Compare** to see what the target adds over that baseline.

> [!TIP]
> The **Not in ABT log** and **Partially in ABT log** tiles, the *ABT log
> state* package filter and the
> **Integrity** view only report real verdicts if the folder also contains
> `packages_with_inclusion_proof_signal.txt`, which
> `inclusion_proof_check.py` (or `automate_observation.py
> --perform_inclusion_proof_check`) produces. Without it every package reads
> *not checked* rather than silently passing.

## Sharing a built copy (no Node on the other machine)

```bash
npm run build        # typechecks, then bundles into dist/
```

`dist/` is a self-contained static bundle. Serve it with anything:

```bash
npm run preview                              # http://localhost:4173
# ...or, with no Node at all on the target machine:
python3 -m http.server 8000 --directory dist
```

> [!WARNING]
> Do **not** open `dist/index.html` directly as a `file://` URL. The bundle
> loads as an ES module, and browsers block module and stylesheet loads from the
> opaque `file://` origin — you get a blank page and CORS errors in the console.
> Always serve it over `http://localhost`.

## Air-gapped or analysis-host use

Hubble observations are a full device inventory, so you may want to read them on
a machine with no egress:

1. Run `npm install` (or `npm ci`) **once** on a networked machine.
2. Either copy the whole `webui/` directory including `node_modules/`, or run
   `npm run build` and copy only `dist/` plus a static file server.

After that the app never touches the network: the CSP forbids it, and no
observation data is written to disk or to browser storage. Closing the tab
discards everything.

## Development tasks

```bash
npm run typecheck    # tsc --noEmit, strict
npm run test         # vitest: parsing, classification, indexing, diffing
npm run build        # typecheck + production bundle
```

The end-to-end smoke test walks every route in headless Chrome and asserts that
certificates actually decode and verify. It needs Google Chrome and **Node
22.12+** (a `puppeteer-core` requirement):

```bash
python3 scripts/generate_sample_data.py
VITE_SMOKE_HOOKS=1 npx vite build
node scripts/smoke.mjs .smoke
npm run build        # rebuild dist/ without the test hooks
```

> [!IMPORTANT]
> `VITE_SMOKE_HOOKS=1` bakes test-only hooks (such as
> `window.__loadObservation`) into `dist/`. Always finish with a plain
> `npm run build` before serving that directory or sharing it with anyone.

`puppeteer-core` deliberately ships no browser of its own, so the binary comes
from the host. The usual Linux and macOS install locations are probed
automatically; set `CHROME_PATH` to override that — for a Chromium build, or on
a platform not covered:

```bash
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  node scripts/smoke.mjs .smoke
```

## Troubleshooting

| Symptom | Cause and fix |
| :--- | :--- |
| `npm: command not found` | Node is not installed or not on `PATH`. Open a new terminal; re-check step 1. |
| `npm warn EBADENGINE ... required: { node: '>=20.0.0' }` | Node is too old. Install 20 LTS or newer with nvm. |
| `TypeError: crypto.hash is not a function` during build | Same cause: an unsupported Node version. |
| `EACCES: permission denied` during `npm install` | Do **not** re-run with `sudo`. Use nvm so Node lives in your home directory. |
| `ETIMEDOUT` / `ECONNREFUSED` during `npm install` | No route to `registry.npmjs.org`; set the proxy config from step 4. |
| `Port 5173 is in use` | `npm run dev -- --port 5174`. |
| Blank page, CORS errors in the console | You opened `dist/index.html` over `file://`. Serve it over HTTP instead. |
| Load diagnostic: *no core artifact found* | You pointed at the wrong directory level. Select the folder that directly contains `packages.txt`. |
| Load diagnostic: *record count disagrees with envelope* | Usually a truncated `adb pull`. Re-extract the observation. |
| Folder drag-and-drop does nothing | Some browsers restrict directory drops; use the **Choose folder** button, or **Choose files** and select the `*.txt` files. |
| `No Chrome or Chromium binary found ...` from the smoke test | No browser at the probed paths. Install Chrome, or point `CHROME_PATH` at an existing one. |
