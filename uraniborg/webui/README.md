# Uraniborg Explorer

A local, offline web UI for reading Hubble observations. It turns the raw JSON
in `packages.txt`, `certificates.txt` and friends into a navigable model of a
device: what is installed, who signed it, what it is allowed to do, and what
changed between builds.

> [!IMPORTANT]
> Everything runs in your browser. Observation files are parsed in-page, held in
> memory only, and are never uploaded or written to browser storage. The page
> ships a `default-src 'none'` Content Security Policy, so it cannot make
> network requests even if it wanted to.

## Requirements

| What | Version | Needed for |
| :--- | :--- | :--- |
| **Node.js** (ships `npm`) | 20 or newer | required — builds and serves the app |
| A modern browser | Chrome/Edge 100+, Firefox 100+, Safari 16+ | required — WebCrypto and File/Directory APIs |
| Network access to `registry.npmjs.org` | — | required **once**, for `npm install` |
| Python 3.8+ and `openssl` | — | optional — sample data generator |
| Google Chrome and Node 22.12+ | — | optional — end-to-end smoke test |

New to Node? Follow
[**How to set up and run Uraniborg Explorer**](../docs/webui_setup.md) — a
chronological walkthrough from an empty machine to a loaded observation,
including per-platform Node installation and a troubleshooting table.

## Quick start

```bash
node --version       # v20 or newer — see the setup guide if this fails
cd uraniborg/webui
npm install          # the only step that needs network access
npm run dev          # http://localhost:5173
```

Then drag a Hubble results directory onto the page (the one
`automate_observation.py` writes), or use **Choose folder**.

No device handy? Generate two synthetic observations first:

```bash
python3 scripts/generate_sample_data.py   # requires openssl
```

This writes `sample-data/pixel-target/` (an OEM-flavoured build) and
`sample-data/gsi-baseline/` (a trimmed AOSP-like baseline). Load both to try the
Compare view.

The target is emitted as a Hubble 2.2.0 capture and covers all four signing
states — a rotation lineage, a co-signed package, a package that rotated *away*
from the platform key (which Android's own `checkSignatures()` still calls
`MATCH`), and plain single signers. The baseline is deliberately emitted in the
pre-2.2.0 shape, without `signingInfo`, because real fleets compare captures
taken months apart and the degraded path should be reachable in the demo rather
than only in tests.

### Static build

```bash
npm run build        # typecheck + bundle into dist/
npm run preview      # serve dist/ at http://localhost:4173
```

`dist/` is a self-contained static bundle with relative asset paths and hash
routing, so it can be served from any origin or sub-path — including
`python3 -m http.server 8000 --directory dist` on a machine with no Node.

> [!WARNING]
> It must be served over HTTP, not opened as a `file://` URL: browsers block ES
> modules and stylesheets loaded from the opaque `file://` origin, so you would
> get a blank page and CORS errors in the console.

## What it reads

| File | Used for |
| :--- | :--- |
| `packages.txt` | **required** — packages, permissions, components, signer IDs |
| `certificates.txt` | signing certificates (base64 DER), decoded in-browser |
| `build.txt`, `hardware.txt` | device identity, API level, security patch level |
| `device_properties.txt` | base64 `getprop` dump |
| `binaries.txt`, `libraries.txt` | native attack surface reachable by an untrusted app |
| `preinstalled_packages.txt` | fallback when `packages.txt` is absent |
| `packages_with_inclusion_proof_signal.txt` | transparency-log results from `inclusion_proof_check.py` |

Artifacts are identified by their **envelope shape**, not their filename, so
renaming `.txt` to `.json` or loading loose files works. If the `total*` count in
an envelope disagrees with the number of parsed records — the signature of a
truncated `adb pull` — a load diagnostic is raised.

## Views

| View | Purpose |
| :--- | :--- |
| **Overview** | Device identity, provenance and permission-sensitivity breakdowns, top signers, most privileged packages |
| **Packages** | Faceted, virtualised browser over every package; all filters are URL state, so views are shareable |
| **Package detail** | Identity, signers, runtime flags, sensitivity-ordered permissions, per-component guard analysis, digests, raw JSON |
| **Signing certs** | Every signer ranked by reach and by the aggregate privilege of what it signs |
| **Certificate detail** | Decoded X.509, fingerprint verification, DER/PEM export, and every package the key signs |
| **Shared UIDs** | Privilege-aggregation groups, flagging privileged system UIDs and multi-signer anomalies |
| **Permissions** | Reverse index: which packages hold a permission, which requested it and were refused, who declares it |
| **Components** | Every activity/service/receiver/provider on the device, filterable down to exported-and-unguarded |
| **Integrity** | Android Binary Transparency status per package and per APK split, filterable by state |
| **Binaries & libs** | Native binaries and libraries with digests |
| **Device & build** | Build/hardware fields, load diagnostics, decoded `getprop` |
| **Compare** | Baseline → target diff, plus a count of the pre-installed surface the target adds |

Press <kbd>⌘K</kbd> / <kbd>Ctrl-K</kbd> anywhere to search packages, signers,
permissions, components — or paste a raw SHA-256 to find whatever produced it.

### Provider guards

A ContentProvider is the only component with two independent permission gates,
so it is described as *who can perform each operation* rather than as a pair of
strings:

| Shown | Meaning |
| :--- | :--- |
| `read <permission>` | callers must hold that permission to query it |
| `write <permission>` | callers must hold that permission to insert, update or delete |
| **any app** | nothing is enforced and the provider is exported — any app on the device can do this |
| **not enforced** | nothing is enforced either, but the provider is not exported, so only the app's own UID can reach it |

The two gates are genuinely independent, so when they agree they collapse to a
single `read/write` line. A provider showing two lines is therefore one whose
read and write differ — the asymmetric case, readable only with a permission
but writable by anybody, which is the one worth stopping on.

> [!IMPORTANT]
> **any app** means nothing is enforced, not that nothing was recorded. Android
> folds a provider-wide `android:permission` into both
> `ProviderInfo.readPermission` and `ProviderInfo.writePermission` during
> manifest parsing, and Hubble reads those resolved fields, so a blank pair
> cannot be a blanket guard that went unobserved.

Two things qualify the verdict without overriding it, and are flagged with an
info icon rather than folded into the label: `<path-permission>` entries, which
replace the provider-wide guard for specific URI paths in either direction, and
`grantUriPermissions`, which lets the app hand a caller temporary access to one
URI regardless of the permissions above.

### Resizing

Package names, component class names and install paths have no useful upper
bound on length, so every default column width is wrong for someone. Drag any
column boundary in the header to resize it; the same handle also responds to:

| Gesture | Effect |
| :--- | :--- |
| Drag | Resize the column to the left of the boundary |
| Double-click | Reset that column to its default |
| <kbd>←</kbd> / <kbd>→</kbd> (handle focused) | Nudge by 16 px |
| <kbd>Enter</kbd> | Reset that column |
| **Reset column widths** (table footer) | Reset the whole table |

The navigation sidebar and the Permissions detail pane have the same grab
strips on their edges, and so does the **Split** column of the APK/split digest
list on a package's Integrity tab — split names such as
`config.en_GB`/`config.arm64_v8a` routinely overflow a sensible default. Widths
are remembered per table and per panel in `localStorage` under
`uraniborg-explorer/prefs/v1`; nothing about the observed device is stored
there, only pixel counts.

## Certificate navigation

Signer hashes appear as coloured chips throughout the app (the colour is derived
from the hash, so the same key is recognisable at a glance). Clicking any chip
opens the certificate page, which shows:

- the decoded X.509 subject, issuer, serial, validity window, signature
  algorithm and key size;
- whether the certificate is the **platform signing certificate** (the first
  certificate recorded for the `android` framework package), and what that
  implies;
- an **independent integrity check** — the DER bytes are re-hashed locally with
  WebCrypto and compared against the SHA-256 that Hubble computed on-device, so
  a certificate altered in transit is detected;
- DER / PEM download plus the matching `openssl` command; and
- every package on the device that **records** that key among its signers, with
  aggregate privilege.

From there, **Filter packages** pivots to the package list scoped to that
signer.

The signer index carries a **Subject** column so a key is recognisable without
opening it, and the full 64-hex digest is rendered into the hash cell and
clipped by the column rather than cut to a fixed length — widening the column
reveals more of the hash, and truncation stays on the right because digests are
compared from their prefix. Both the subject and the hash are searchable.

> [!CAUTION]
> A certificate subject is a self-asserted label, not a verified identity.
> Android app-signing certificates are self-signed, so the CN and O are whatever
> the signer typed, and two unrelated keys can both claim `O=Google LLC`. Use it
> to recognise a key you already know; use the hash to decide anything.

Roles in that table are coloured by what the key can do now: **PLATFORM** and
**platform (retired)** carry platform trust, **app signer** is an ordinary key
that can ship an update today, **retired key** can sign nothing on this device,
and **missing DER** means the bytes were never in `certificates.txt`.

### Multiple signing certificates

A package can list more than one entry in `certIds`, and the flat list does not
say which of two opposite things it means. Hubble 2.2.0 records the fields that
settle it, so the UI resolves every package into one of four states and labels
it explicitly rather than hedging:

| State | What `certIds` holds | Who can ship an update |
| :--- | :--- | :--- |
| **Single signer** | the current signer | that key |
| **Key rotation lineage** | the whole v3 lineage, oldest → newest | the newest key alone |
| **Co-signed** | the concurrent signer set, unordered | all of them together |
| **Undetermined** | unresolvable from this observation | unknown |

The two two-entry cases look identical on disk, which is why the resolution is
read from `signingInfo` (`hasMultipleSigners`, `hasPastSigningCertificates`,
`apkContentsSigners`, `signingCertificateLineage`) and never inferred from
`certIds`. A package resolves to **Undetermined** for one of three reasons, and
the UI distinguishes them because they have different remedies:

- *Pre-2.2.0 capture* — no `signingInfo` at all. Re-run Hubble.
- *Unobservable* — collected on API &lt; 28, where `PackageManager` exposes no
  v3 lineage API. Rotation is not known to be absent, it is not visible.
  Co-signing is still reported affirmatively there, because the signer count
  itself is observable on every API level.
- *No certificates* — a `signingInfo` block with no usable digests.

Everything downstream is derived from that resolution rather than from the raw
list: certificate pages separate the packages a key **still signs** from the
ones it is only a **retired ancestor** of; shared-UID groups are only flagged
when the members' signing histories share nothing, because Android joins a
shared UID against the whole lineage; and **Compare** splits a *key rotated*
(the earlier lineage extended by a newer key) from a *signer changed*
(re-signed), which are respectively routine and worth chasing.

Platform matching is **directional**, matching `hubble_parser.py`: a package's
*current* signers are tested against the `android` package's *full* lineage.
The platform side may use its whole history, so rotating the platform key does
not orphan system packages that have not been re-signed; the package side may
not, or a package that rotated away from the platform key would keep the
privileges forever. The recorded `platformSignatureMatch` is Android's own
`checkSignatures()` verdict and is displayed but never acted on — when the
current signers differ it falls back to comparing each side's *oldest*
ancestor, so it reports `MATCH` for exactly that rotated-away package.

Two things are out of reach even in principle from an observation: the lineage
**capability flags** (`PERMISSION`, `SHARED_USER_ID`, `ROLLBACK`, `AUTH`) are
not reachable from any public API and so cannot be recorded, meaning platform
trust may be over-approximated for a package still signed with a retired
platform certificate; and the proof of rotation lives in the APK signing block,
so the lineage can only be taken on the authority of the device that verified it
at install time.

> [!NOTE]
> The classification deliberately mirrors
> `scripts/python/hubble_parser.py::classify_package_signing()` case for case,
> including its refusals — the same artifact must not read two ways depending on
> which tool you opened it with. The web implementation is
> [`src/lib/signing.ts`](src/lib/signing.ts) and is the only place `certIds` is
> interpreted. See
> [Determining Package Signing Certificate Lineage vs. Co-Signing](../docs/hubble_results.md#determining-package-signing-certificate-lineage-vs-co-signing).

## Permission sensitivity tiers

Permissions are tagged with the tiers from Table 2 (*Permission Mapping to
Category and Weight*) of
[*Uraniborg's Preloaded App Risks Scoring Metrics (2020-08) v1.0*](../docs),
transcribed verbatim into [`src/lib/sensitivity.ts`](src/lib/sensitivity.ts).
The tier is used for sorting, filtering and colour only.

| Tier | Rows in Table 2 |
| :--- | :--- |
| ASTRONOMICAL | 1 |
| CRITICAL | 11 |
| HIGH | 21 |
| MEDIUM | 16 |
| LOW | 7 |

The paper also lists a sixth tier, **NONE** (weight 0): `ACCESS_NETWORK_STATE`,
`RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`, `FLASHLIGHT` and `VIBRATE`. These are
**not** tagged or counted as sensitive, since the paper judged them to carry no
risk and nearly every package holds one.

These tiers are a published judgement rather than anything Hubble observed, so
the UI cites the paper wherever they appear: in every tier badge's tooltip, and in a
footnote on Overview, Permissions and each package's Permissions tab. Nothing
upstream supplies the tiers — `hubble_parser.py` has no equivalent table — so
`sensitivity.ts` is the only copy, and unit tests pin it to the paper's row
counts.

> [!NOTE]
> This UI does **not** compute a risk score, and deliberately drops the paper's
> numeric weights and composite DPAR metric: they are baseline-relative, age as
> the permission model evolves, and invite false precision. Every number shown
> is a directly observed count. **Compare** answers the question DPAR was
> reaching for — what pre-installed surface does this build add over a
> GSI/AOSP baseline? — as plain counts with the package list attached.

## Android Binary Transparency

Load `packages_with_inclusion_proof_signal.txt` and every APK split is resolved
against the transparency log. Because a package can have several splits and each
is looked up independently, the result is deliberately **not** a boolean:

| State | Meaning |
| :--- | :--- |
| **in log** | every split was found |
| **partially in log** | at least one split was found, but not all. Shown in red when another split was looked up and *not found* — the anomaly the log exists to expose — and in amber when the rest merely have no result (an incomplete check, typically an APK that changed between runs) |
| **not in log** | no split was found; expected for OEM and third-party preloads, notable for first-party ones |
| **not checked** | the loaded run said nothing about this package |

The state surfaces on the **Overview** as two tiles, *Not in ABT log* and
*Partially in ABT log*; as a flag and an *ABT log state* filter in **Packages**;
in the package page header and its **Integrity** tab (per split); across the
**Integrity** view; and as a change in **Compare** when both observations were
checked. The `?proof=failed|partial|verified|unchecked` URL parameter means the
same thing on **Packages** and **Integrity**.

To interrogate a single package, the package page has a **Transparency log**
tab, reachable from the *Investigate* button on the Integrity tab or by clicking
any row in the Integrity view. It shows:

- the verdict, the version code that was queried and which artifact supplied it;
- **the exact leaf that was looked up for each split** —
  `<digest>\nSHA256(APK)\n<package>\n<versionCode>\n`, reconstructed from
  `inclusion_proof_check.py` and copyable, so the lookup can be replayed with
  the verifier by hand. Note that the version code is part of the identity: a
  version bump alone changes the leaf;
- a **reconciliation** against `packages.txt` — differing version codes, base
  digests, or splits present in only one of the two artifacts. This is normally
  what explains a split with *no result*: the APK was replaced between the
  Hubble run and the proof run;
- the **raw record** from `packages_with_inclusion_proof_signal.txt`, with copy
  and download.

If the proof run had not finished when the observation was loaded, none of the
above is lost work: wherever the missing artifact is called out — the package
**Transparency log** tab, the **Integrity** tab, and the device-wide
**Integrity** view — there is a **Load proof results** button that folds
`packages_with_inclusion_proof_signal.txt` into the observation already in
memory. The observation keeps its identity, so the active selection, the
compare baseline and the switcher order all survive; only the proof data is
added. It is a file picker rather than a *reload* button because the page never
has filesystem access — it cannot go and re-read the directory on its own.

> [!WARNING]
> Absence from the log is not by itself evidence of tampering — it usually just
> means the vendor does not publish to it. The digest is what to pivot on.

## Provenance classification

Packages are classified per
[`docs/hubble_results.md`](../docs/hubble_results.md). Note the APEX subtlety
that is easy to get wrong: a pristine factory compressed APEX is decompressed at
boot into `/data/apex/...`, so the classifier keys on the `.decompressed.apex`
suffix rather than the directory. Updated system apps are flagged in the
Integrity view because their recorded hash describes the `/data/app` update, not
the factory binary.

## Development

```bash
npm run typecheck
npm run test                 # vitest: parsing, classification, indexing, diffing
npm run build

# End-to-end smoke test: walks every route in headless Chrome against the
# sample data and writes screenshots. Needs Google Chrome and Node 22.12+.
# The browser is found automatically on Linux and macOS; set CHROME_PATH to
# point at it anywhere else, or to use a Chromium build.
python3 scripts/generate_sample_data.py
VITE_SMOKE_HOOKS=1 npx vite build
node scripts/smoke.mjs .smoke
npm run build                # replace the hook-enabled dist/ before serving or sharing it
```

Troubleshooting for all of the above lives in the
[setup guide](../docs/webui_setup.md#troubleshooting).

### Stack

React 18 + TypeScript + Vite, Tailwind CSS, React Router (hash mode), Zustand
for state, TanStack Virtual for large tables, `@peculiar/x509` for certificate
decoding, and `lucide-react` for icons. No backend, no telemetry.
