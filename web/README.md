# WebMIX — the OBS Studio UI in a browser

WebMIX is a web frontend for OBS Studio. It reproduces the OBS desktop UI
(docks, menus, dialogs, theme) in the browser and drives a running OBS over
**obs-websocket 5.x**, so scenes, sources, audio, transitions, outputs and
settings can all be operated from any browser on the network.

```
browser (WebMIX SPA) ──ws://host:4455──▶ OBS Studio + obs-websocket
        ▲
        └── served by: node server.mjs   (or any static file host)
```

The frontend is dependency-free ES modules — no build step, no bundler, no CDN.
`obs.css` is generated from OBS's own `frontend/data/themes/Yami.obt` theme, so
the colours, control heights, scrollbars and fader curves are OBS's, not an
approximation.

## Quick start — web-only mode (recommended)

OBS runs **without any native window** and serves the frontend itself, so the
browser is the only interface:

```bash
obs --web                     # http://127.0.0.1:4460/
obs --web --web-host 0.0.0.0  # reachable from the LAN
obs --web --web-port 8080     # different port
```

What `--web` does:

* never shows the OBS window and creates **no tray icon**;
* starts the built-in web server (QTcpServer-based) that serves this directory;
* **enables obs-websocket automatically** before it loads, so there is nothing
  to configure;
* suppresses the startup dialogs that would otherwise block an invisible
  process (missing files, plugin-load failures, unclean shutdown);
* exits instead of prompting when another instance is already running.

The page auto-connects: it reads `/obs-config.json` from the embedded server,
which reports the obs-websocket port and password from OBS's own config.

To make it permanent without a command-line flag, put this in `global.ini`:

```ini
[General]
WebMode=true
WebPort=4456
WebHost=127.0.0.1
```

### Embedded control endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Identifies the host (`webmix: true`), version, web root, whether shutdown is available. |
| `GET /obs-config.json` | obs-websocket port/password/enabled, read from OBS's config. |
| `POST /api/shutdown` | Shuts OBS down. This is what **File > Exit** calls, so OBS can be stopped from the browser. |
| `GET /api/preview.mjpg` | Live preview: JPEG frames as `multipart/x-mixed-replace` (`source`, `width`, `height`, `fps`, `quality`). |
| `GET /api/preview.jpg` | A single preview frame. |
| `GET /api/properties/source\|filter\|transition` | The real `obs_properties_t` schema (labels, types, ranges, list items, groups, visibility) plus current values. |
| `POST /api/properties/press` | Invokes a button property. |
| `POST /api/scenes/move` | Reorders scenes (no obs-websocket request exists). Indices are display order, `0` = top. |
| `POST /api/transitions/add\|rename\|remove` | Creates, renames and removes transition instances; built-in Cut/Fade stay protected. |
| `GET /api/hotkeys` | Every hotkey with the bindings OBS itself reports (formatted by OBS). |
| `POST /api/hotkeys/bind\|clear` | Rebinds a hotkey in OBS and persists it to the active profile. |
| `GET /api/files/list` | Lists a directory OBS uses (`kind=recordings\|logs\|crashes\|config\|profile`, optional `path=` for a subdirectory). |
| `GET /api/files/download` | Streams a file from one of those directories as an attachment. |
| `GET /api/files/text` | Reads the tail of a text file, for the inline log viewer. |
| everything else | Static files from this directory; unknown paths fall back to `index.html`. |

Requests containing `..` (including percent-encoded) are rejected with 403, and
the resolved path must stay inside the web root.

## Quick start — external server

Useful for development, or to serve the UI from a different machine:

```bash
# 1. Enable OBS's WebSocket server (it ships with OBS but is off by default).
cd web
node tools/enable-websocket.mjs          # add --password <pw> to set a password

# 2. Serve the UI
npm start                                # http://127.0.0.1:8080/
#    --host 0.0.0.0 exposes it to the LAN, --port <n> changes the port

# 3. Open the page and connect (it is prefilled from /obs-config.json).
#    Tip: ?host=…&port=…&password=…&autoconnect=1 overrides everything.
```

Query parameters beat both the remembered values and the host's config, which
makes it possible to point one copy of the UI at a different OBS.

## Running OBS unattended (autostart in the background)

WebMIX is designed to be started by the system and controlled entirely from a
browser. Two upstream dialogs are removed because they would block an invisible
process:

* **The "OBS did not shut down properly" / Safe Mode dialog is disabled.**
  After a power loss or reboot, OBS no longer stops on a modal prompt; it logs
  the unclean shutdown and continues with a normal launch
  (`frontend/OBSApp.cpp`, `checkForUncleanShutdown()`).
  To get the original prompt back, set in `global.ini`:

  ```ini
  [General]
  WarnOnUncleanShutdown=true
  ```

* **The "already running" prompt** does not appear in web mode; the second
  instance logs and exits (`frontend/obs-main.cpp`).

Suggested autostart command line (Windows shortcut / Linux `.desktop`
`Exec=`):

```
obs --web --web-port 4460
```

`--web` already implies `--disable-missing-files-check`. Add
`--startrecording` / `--startstreaming` / `--startvirtualcam` /
`--startreplaybuffer` to start outputs immediately.

## Tests

```bash
npm test              # 76 unit/integration tests (protocol client, store, fader, MJPEG parser, UI structure)
npm run test:browser  # headless-Chromium end-to-end check of the mock-backed UI (52 assertions)
npm run test:live     # against a real `obs --web` instance (29 assertions, incl. GPU pixels)
```

`npm run test:browser` boots the mock obs-websocket server, loads the real UI in
headless Chromium over the DevTools protocol, and asserts that the docks, scene
list, source list, mixer strips, transitions, controls, status bar, menu bar and
Studio Mode all rendered — and that the page produced **no** console errors or
uncaught exceptions. It writes screenshots to `/tmp/webmix-smoke*.png`.

The mock server (`test/helpers/mock-obs.mjs`) speaks the real protocol
(including the SHA-256 challenge/auth handshake), so the client is exercised
against a faithful peer rather than stubs.

## Layout

```
web/
  index.html            window shell
  assets/obs.css        OBS Yami theme (design tokens + widget chrome)
  assets/layout.css     web-only window structure (workspace, splitters, strips)
  assets/fonts/         Open Sans, copied from frontend/forms/fonts/
  protocol.json         vendored obs-websocket 5.7.4 protocol definition
  server.mjs            dependency-free static server + /obs-config.json
  src/
    protocol.js         GENERATED (247 requests/events/enums) — tools/gen-protocol.mjs
    hash.js             SHA-256 + base64 (no crypto.subtle: works over plain http)
    obs-client.js       obs-websocket v5 client (auth, requests, batches, events, reconnect)
    store.js            state mirror + OBS event reducers, topic-based re-render
    api.js              high-level OBS operations
    fader.js            OBS log fader curve + meter scale (ported from libobs)
    dom.js              tiny DOM/reconcile helpers
    ui/                 menu, docks, panels, preview, dialogs, icons
  tools/
    gen-protocol.mjs    regenerate src/protocol.js from protocol.json
    enable-websocket.mjs
    browser-smoke.mjs
  docs/
    ui-spec.md          extracted OBS window/menu/dialog structure
    theme-spec.md       extracted theme tokens and per-widget rules
```

## What is implemented

Everything below operates the **live** OBS instance:

* **Main window** — the full OBS layout: menu bar (File / Edit / View / Docks /
  Profile / Scene Collection / Tools / Help with the real items and shortcuts),
  source toolbar, Scenes, Sources, Preview, Scene Transitions, Controls,
  Audio Mixer, status bar; draggable splitters; dock show/hide/reset; layout
  persisted in `localStorage`.
* **Scenes** — list and grid modes, switch program/preview, add, remove,
  rename (F2/inline), filters, screenshots, context menu, live/preview badges.
* **Sources** — per-item visibility and lock toggles, add (type picker +
  existing source), remove (from scene / delete), rename, duplicate,
  reorder, properties, filters, interact (opens the URL for browser sources),
  screenshots, full context menu.
* **Audio Mixer** — one strip per audio source, mute, monitoring cycle,
  OBS-exact log fader, dB readout, peak/magnitude meter with OBS's
  -20 dB / -9 dB warning and error colours, vertical/horizontal layouts,
  options menu, advanced audio properties.
* **Audio** — the full Advanced Audio Properties table: volume (dB), mute,
  monitoring, balance, sync offset, six track checkboxes.
* **Scene Transitions** — transition selection, duration, T-Bar, studio
  transition trigger, studio-mode UI, plus creating, renaming and removing
  transition instances through the bridge.
* **Scenes (ordering)** — Move Up/Down and Move to Top/Bottom reorder the real
  OBS list. Note that obs-websocket returns scenes **bottom-first** while the
  desktop list and WebMIX are top-first, so the protocol order is flipped once
  on the way in (`toDisplayOrder()` in `src/store.js`).
* **Controls** — Start/Stop Streaming, Start/Pause/Stop Recording, Replay
  Buffer + Save Replay, Virtual Camera, Studio Mode, Settings.
* **Outputs & status** — live stream/record timers, dropped frames, bitrate,
  network state, CPU, FPS, replay-buffer and virtual-camera state.
* **Preview / Program** — rendered on the **GPU with WebGPU**: OBS streams JPEG
  frames over one HTTP connection (`/api/preview.mjpg`) and they are decoded and
  drawn as an aspect-fitted quad by a WGSL shader (zoom and
  scale-to-window/canvas/output are GPU transforms). Studio Mode's dual
  Preview/Program panes, lock, click-to-switch and the screenshot menu work the
  same way. See "Preview backends" below.
* **Properties and Filters** — rendered from the real OBS property schema via
  the WebMIX bridge, so the dialogs show the same localised labels, sliders,
  ranges, list/radio choices, colour pickers, font pickers, groups and
  conditional visibility as the desktop UI, with live apply.
* **Dialogs** — Transform (fully faithful: position, rotation, scale, bounds,
  crop, alignment grid), Stats, Advanced Audio, Properties, Filters,
  Settings (Stream / Output / Video / Audio / Advanced / Hotkeys), About.
* **Stats dock** — View > Docks > Stats, rendering the same figures as the
  Stats dialog (both are generated from one `statsRows()` source).
* **Custom Browser Docks** — Docks > Custom Browser Docks... manages name/URL
  pairs, each rendered as a dock in a right-hand column and toggleable from the
  Docks menu, like OBS.
* **Browser hotkeys** — OBS owns the real hotkey bindings and obs-websocket
  cannot change them, so Settings > Hotkeys lets you capture a key combination
  in the browser; pressing it sends `TriggerHotkeyByName`. Bindings live in
  `localStorage` and are shown next to each hotkey.
* **Profiles & scene collections** — switch, create, remove; profile/collection
  lists live in their menus, like OBS.
* **Files** — Show Recordings, Show Log Files, View Current Log, Show Settings
  Folder and Show Profile Folder open a browser with navigation and downloads
  instead of a file manager on the OBS machine, which is what makes recordings
  retrievable from a headless box.

## Security

The embedded server is deliberately **unauthenticated**: it exists to serve a
local control surface, and it has to hand the browser the obs-websocket password
(`/obs-config.json`) so the UI can connect without asking. It binds to
`127.0.0.1` by default.

Binding it beyond loopback (`--web --web-host 0.0.0.0`, or `WebHost` in
`global.ini`) therefore exposes both control of OBS and read access to its
config, log and recording directories to anyone who can reach the port. OBS logs
a warning when that happens. On an untrusted network, put an authenticating
reverse proxy in front of it.

File access is confined to the directories OBS itself uses; every request is
validated (no `..`, no absolute paths, canonical path must stay inside the root,
so symlinks cannot escape) and all such attempts are refused with 404.

## Preview backends

| Backend | When | How |
| --- | --- | --- |
| **WebGPU** | OBS serves the UI (`--web`) and the browser exposes `navigator.gpu` | JPEG frames stream over `/api/preview.mjpg`; `createImageBitmap` decodes them and a WGSL shader draws an aspect-fitted quad. Zoom/scaling are GPU transforms. |
| Screenshots | External static server, or no WebGPU | `GetSourceScreenshot` over obs-websocket, painted into an `<img>` (see the panel's context menu for the active backend). |

Two implementation details worth knowing:

* The canvas is **re-configured whenever its backing size changes** — resizing a
  WebGPU canvas invalidates the swap chain, and without re-configuring every
  draw is silently discarded.
* Some WebGPU implementations (software/headless) accept
  `copyExternalImageToTexture` but upload nothing, which looks like a black
  preview. The renderer probes that path once at start-up with a known colour and
  falls back to `writeTexture` with raw RGBA when the result is wrong; the active
  path is reported by `WebGpuPreview.selfTest()` and in the preview context menu.

`WebGpuPreview.selfTest({source})` runs the whole pipeline (fetch → decode →
upload → render → GPU readback) in one call and returns the dominant colours. It
is what the live check asserts on, because headless compositors do not reliably
include WebGPU canvas contents in screenshots.

## Known gaps (and why)

obs-websocket exposes a large but finite API. The following cannot be done over
the protocol today; they need either the OBS desktop UI or a WebMIX-side
extension. Each one reports a clear message in the UI instead of failing
silently.

| Area | Gap |
| --- | --- |
| Preview video | Solved in `--web` mode by the embedded MJPEG endpoint + WebGPU. Served externally (plain static server) it still falls back to `GetSourceScreenshot` polling. |
| Scene order | No obs-websocket request exists, so it runs through the bridge (`POST /api/scenes/move`). Unavailable when the UI is served externally. |
| Transition management | Same: bridge-only (`/api/transitions/*`). |
| Properties / filter settings | Solved when OBS serves the UI (`/api/properties/*` serialises `obs_properties_t`). With an external server the fallback key-based form is used. |
| Hotkey bindings | The bridge rebinds them in OBS and persists them (`/api/hotkeys/bind`). Separately, the browser can capture a shortcut and send `TriggerHotkeyByName` - which is what works while OBS is headless, since a window-less OBS never receives key presses. |
| Custom browser docks | Implemented, but a real browser enforces `X-Frame-Options` / CSP `frame-ancestors`, which OBS's embedded browser ignores. Sites that refuse framing (many do) cannot be docked outside OBS; the dock reports it. |
| Scene collections / profiles | List/switch/create/remove work, but duplicate/rename/import/export do not. |
| Undo/redo, source group/ungroup, copy/paste duplicate | Not exposed. |
| "Hide in Mixer", mixer pin/lock | Not exposed. |
| Recordings / logs / config folders | Solved via `/api/files/*` (list, download, view). Remux Recordings, uploading a log to obsproject.com, the Plugin Manager and the Auto-Configuration Wizard are still desktop-only. |
| Always On Top, OS folders, tray | Apply to the desktop window, not the browser. |
| Exit OBS | obs-websocket has no shutdown request, but the embedded server adds `POST /api/shutdown`, so File > Exit works when OBS serves the UI (`--web`). With an external server there is still no way. |

The browser frontend is now served by OBS itself in `--web` mode
(`frontend/webmix/WebMixServer.cpp`, a QTcpServer-based static server plus the
control endpoints), so an installed OBS needs nothing else. `node server.mjs`
remains as the development/remote option.

## Building the OBS fork (Linux)

Current Arch packages are missing or too new for several of this checkout's
dependencies. They can all be built into a local prefix without root:

| Dependency | Why | Note |
| --- | --- | --- |
| `extra-cmake-modules` (ECM) | `cmake/linux/ecmconfig.cmake` requires it | `pacman -S extra-cmake-modules`, or install from source |
| `libwebsockets` | obs-websocket's server backend | `pacman -S libwebsockets`, or build from source |
| **MbedTLS 3.x** | `plugins/obs-outputs` requires `3...<4`; Arch ships 4.2.0 | build `v3.6.2` from source; on GCC 16 it needs `-Wno-unterminated-string-initialization` |
| `nlohmann_json` >= 3.11 | obs-websocket | header-only; install from source |
| `websocketpp` >= 0.8 | obs-websocket | header-only; copy `websocketpp/` into the prefix's `include/` |
| standalone `asio` **1.30.2** | obs-websocket | header-only, but must be **pinned**: asio master removed `expires_from_now()`, which websocketpp 0.8.2 still calls |
| `qrcodegencpp` | obs-websocket | Arch: `qrcodegencpp-cmake` |

Then:

```bash
git submodule update --init plugins/obs-websocket plugins/obs-browser

cmake -S . -B build -G Ninja \
  -DOBS_VERSION_OVERRIDE=33.0.0 \
  -DENABLE_SCRIPTING=OFF \
  -DENABLE_BROWSER=OFF \
  -DCMAKE_PREFIX_PATH="/path/to/lws-prefix;/path/to/other-prefix"
cmake --build build -j"$(nproc)" --target obs-studio
```

Four traps worth knowing:

* **`OBS_VERSION_OVERRIDE` is mandatory here.** `cmake/common/versionconfig.cmake`
  runs `git describe --tags`; this fork carries no tags, so it produces
  `2a4dfeb55-modified` and configure aborts with `VERSION ... format invalid`.
* **`ENABLE_BROWSER=OFF` still requires the `plugins/obs-browser` submodule** to be
  checked out — `plugins/CMakeLists.txt` raises a fatal error if the directory is
  empty, independently of the option.
* **`ENABLE_SCRIPTING=OFF` avoids needing `swig`.**
* **`-DENABLE_WEBSOCKET=OFF`** skips obs-websocket entirely (and with it
  nlohmann_json, websocketpp, asio and qrcodegencpp). Useful for compiling
  frontend changes quickly — but WebMIX itself needs the plugin at runtime.

To check a single frontend change without building the whole project:

```bash
ninja -C build frontend/CMakeFiles/obs-studio.dir/OBSApp.cpp.o
```

## Development

* `node tools/gen-protocol.mjs` regenerates `src/protocol.js` after replacing
  `protocol.json` (keep the version matched to the obs-websocket the fork
  builds — currently 5.7.4).
* `web/docs/ui-spec.md` and `web/docs/theme-spec.md` are the extracted source of
  truth for layout and styling; update them when OBS's `.ui`/theme change.

## License

GPL-2.0-or-later, matching OBS Studio. The bundled Open Sans fonts are copied
from `frontend/forms/fonts/` and keep their original license.
