# Uraniborg helper server

A small local server that lets the web UI run
[`automate_observation.py`](../../scripts/python/automate_observation.py) on
this computer. It serves the built UI from `../dist`, and exposes a JSON API
under `/api` that starts one observation at a time and streams its progress.

It uses only the Python standard library and needs **Python 3.9+** on
**Linux or macOS** (the platforms the script supports), plus `adb` on `PATH`.

## Running it

```sh
cd uraniborg/webui
npm run build     # once, or after UI changes
npm run helper    # = python3 server/uraniborg_helper.py
```

The helper prints a URL like
`http://127.0.0.1:8765/#/?token=…`. The token is how the helper knows a
request comes from the page it served. It sits after `#`, so the browser
never sends it to any server, and it changes every time the helper starts.

Open that URL and choose **Observe a device**. On load the page moves the
token into the tab's session storage and removes it from the address bar, so
a reload keeps working but a new tab needs the URL again. To call the API
directly, use `curl` with the token in an `X-Uraniborg-Token` header (see
[API](#api)).

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port` | `8765` | Port on 127.0.0.1. `0` picks a free one. |
| `--dist` | `../dist` | The built UI. |
| `--script` | `../../scripts/python/automate_observation.py` | The script to run. |
| `--dev-origin` | none | Also accept requests proxied by the Vite dev server, e.g. `http://localhost:5173`. |
| `--tools-dir` | per-user cache | Where the verifier the helper builds is written (see [Security model](#security-model)). |
| `--open` | off | Open the URL in the default browser. |

### With the Vite dev server

```sh
npm run helper:dev   # helper with --dev-origin http://localhost:5173
npm run dev          # in another terminal
```

Open the "Dev server" URL the helper prints. Vite proxies `/api` to the
helper (see `vite.config.ts`).

## What a run does

The helper turns the form's options into an argv (see `options.py`), always
with an explicit `--output`, and runs:

```
python3 automate_observation.py <argv> --events -
```

from the script's own directory, in a new process group. It reads JSON Lines
events from stdout (the contract is in
[`docs/automate_observation.md`](../../docs/automate_observation.md)) and log
lines from stderr. Only events decide the outcome:

| Run state | When |
| --- | --- |
| `succeeded` | `run_finished` with `ok: true`. |
| `failed` | `run_finished` with `ok: false`, or no `run_finished` at all. |
| `cancelled` | The user cancelled. SIGTERM goes to the whole group, then SIGKILL after 10 s. |

Stopping the helper (Ctrl-C or SIGTERM) also stops the active run, because
the run's own process group doesn't receive the terminal's Ctrl-C.

Helper-side error reasons, in addition to the script's own:

| Reason | Meaning |
| --- | --- |
| `no_result` | The script exited without `run_finished` (for example, a crash). |
| `version_mismatch` | An event had a `v` other than 1; the run was killed. |
| `killed` | The run ignored SIGTERM and was killed with SIGKILL. |

## API

Every `/api` request needs the header `X-Uraniborg-Token: <token>`. The
stream alone also accepts `?token=`, because `EventSource` can't set headers.
POST bodies must be `application/json` and at most 64 KiB. Errors look like
`{"error": {"reason": "...", "message": "..."}}`.

| Method and path | Result |
| --- | --- |
| `GET /api/health` | Versions, script path, defaults, and `activeRun` if one is running. |
| `GET /api/devices` | `adb devices -l`, parsed. 503 if adb is missing, 502 if it fails, 504 on timeout. |
| `POST /api/validate` | `{ok, argv, errors, warnings}` for the given options. Starts nothing. |
| `GET /api/runs` | Runs in this helper session. |
| `POST /api/runs` | Starts a run: 201 `{id, warnings}`. 422 `invalid_options`, 409 `busy`, 503 `script_not_found`. |
| `GET /api/runs/:id` | Snapshot: state, argv, devices, pending prompt, and so on. |
| `GET /api/runs/:id/stream` | Server-sent events (see below). |
| `POST /api/runs/:id/input` | Presses Enter for a pending prompt that expects it. 409 `not_waiting_for_input` otherwise. |
| `POST /api/runs/:id/cancel` | 202, or 409 `not_running`. |
| `GET /api/runs/:id/results/:serial` | That device's result files as `{dir, files: [{name, text}], skipped}`. |
| `GET /api/fs/list?path=` | For the Browse dialog: `{path, parent?, home, selected?, missing?, entries: [{name, dir, exec?, link?}], truncated?}`. Lists the nearest existing directory: a file's own directory (named in `selected`), or the closest existing parent of a path that does not exist yet (the rest of that path in `missing`, e.g. `run1`). Blank means home. 400 `not_absolute`, 403 `permission_denied`. |
| `GET /api/verifier` | The inclusion proof verifier: source found, Go path and version, whether it is built, and the last build's state and output. |
| `POST /api/verifier/build` | Builds the verifier: 202 with the status above. 409 `busy`, 503 `go_not_found` or `source_not_found`. |

The stream sends `event: state` with a snapshot first, then numbered
`event`, `state` and `log` messages. Each message has an `id`, so a
reconnecting `EventSource` (or `?lastEventId=` on a fresh page) resumes where
it left off. A `: ping` comment arrives every 15 s. When the run is over and
everything has been sent, `event: end` tells the page to close the stream.

## Security model

The helper can run adb against your devices, so it only trusts the page it
served:

- It listens on 127.0.0.1 only.
- Every API call needs the random per-process token, compared in constant
  time. A custom header also forces a CORS preflight, and the helper refuses
  every preflight.
- `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (or the dev origin),
  which blocks DNS rebinding. `Origin`, when sent, must be the helper itself
  or `--dev-origin`.
- The request log never contains the token.
- Responses forbid framing (`X-Frame-Options`, `frame-ancestors`) and
  sniffing.
- Static files and result files must resolve inside `dist/` and the run's
  output directory, respectively. Result files come from a fixed list of
  names and are size-capped.
- Options are validated against an allow-list and passed as an argv list,
  never through a shell.
- The Browse dialog's listing returns names and kinds (directory,
  executable, link) of one directory at a time, never file contents. It can
  list any directory your user can, which is no more than a token holder
  could already reach by running the script.
- The verifier build is one fixed command (`go build -o <tools dir>/verifier
  ./cmd/verifier` in `verifier_tools/verify`); nothing from the request is
  passed to it. The binary goes to `--tools-dir` (default
  `~/Library/Caches/uraniborg-helper` on macOS,
  `${XDG_CACHE_HOME:-~/.cache}/uraniborg-helper` on Linux), outside the
  source tree.

## Tests

```sh
npm run test:server
# or, from this directory:
python3 -m unittest discover -s tests
```

The tests run `tests/fake_automate.py`, a stand-in for the real script that
follows the same event contract, with scenarios chosen by
`FAKE_AUTOMATE_SCENARIO` (`success`, `xiaomi`, `backup`, `early_exit`,
`crash`, `noise`, `bad_version`, `hang`, `stubborn`, `daemon`). No device is
needed. `test_options.py` also checks every fixture argv against the real
script's argument parser.
