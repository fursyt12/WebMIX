# WebMIX — the OBS Studio UI in a browser

WebMIX is a web frontend for OBS Studio. It reproduces the OBS desktop UI
(docks, menus, dialogs, theme) in the browser and drives OBS **directly**: the
page calls a native control service that lives inside the OBS process and runs
libobs on its behalf. Scenes, sources, audio, transitions, outputs, filters,
properties and settings are all operated from the browser, with no plugin to
enable, no port to open and no protocol server in the way.

```
browser (WebMIX SPA)
   │  POST /api/obs/request    request / response      ─┐
   │  GET  /api/obs/events     Server-Sent Events       ├─▶ OBS process
   │  /api/*                   preview, files, remux…  ─┘   (frontend/webmix,
   │                                                          in-process libobs)
   └── served by: OBS itself (the default launch), or node server.mjs while developing

obs-websocket is still supported as an alternative transport: a page that is
not served by OBS - the development server, or one pointed at another machine -
connects to ws://host:4455 instead, with the same UI and the same state
reducers. See docs/architecture.md for why the native channel is the default.
```

The frontend is dependency-free ES modules — no build step, no bundler, no CDN.
`obs.css` is generated from OBS's own `frontend/data/themes/Yami.obt` theme, so
the colours, control heights, scrollbars and fader curves are OBS's, not an
approximation.

## Quick start — web-only mode (the default)

OBS runs **without any native window** and serves the frontend itself, so the
browser is the only interface. This is what a plain launch does — including
double-clicking `obs64.exe` on Windows, which passes no arguments at all:

```bash
obs                           # asks once, then http://127.0.0.1:4456/
obs --web-host 0.0.0.0        # reachable from the LAN (skips the question)
obs --web-port 8080           # different port (skips the question)
obs --web-choose              # ask again even if the answer was remembered
obs --no-browser              # autostart: serve, but do not open a browser
obs --no-web                  # the classic OBS window instead
```

On a normal launch OBS asks which **address and port** to serve on, listing the
addresses this machine actually has, and then opens the page in the default
browser. Tick *Remember this choice* and later launches start straight away
without asking. `--web-host` / `--web-port` also skip the question, `--web-choose`
brings it back, and the remembered answer lives in `global.ini` as
`WebAskOnStartup`, `WebHost` and `WebPort`.

`--web` is still accepted, so existing shortcuts and scripts keep working, but
it no longer changes anything. What web mode does:

* never shows the OBS window and creates **no tray icon**;
* starts the built-in web server (QTcpServer-based) that serves this directory
  and carries the native control channel the page talks to;
* opens the page in the default browser on start, unless `--no-browser` was
  given or `[General] WebOpenBrowser=false` is set in `global.ini`;
* also enables obs-websocket for *other* clients, which the web interface does
  not use itself (set `[General] WebSocketAutoEnable=false` to leave the plugin
  exactly as configured);
* suppresses the startup dialogs that would otherwise block an invisible
  process (missing files, plugin-load failures, unclean shutdown);
* exits instead of prompting when another instance is already running.

The page connects itself: `/api/status` tells it that the host runs the native
control service, so it starts driving OBS straight away. It only reads
`/obs-config.json` (obs-websocket's port and password) when it has to fall back
to the websocket transport.

The port, host and browser behaviour can be set in `global.ini` instead of on
the command line:

```ini
[General]
WebPort=4456
WebHost=127.0.0.1
WebOpenBrowser=true
```

`--no-web` (alias `--native`) is the only way back to the classic window; the
old `WebMode` key is ignored, so an existing `global.ini` cannot silently keep
an upgraded install on the native UI.

### Embedded control endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Identifies the host (`webmix: true`), version, web root, whether shutdown is available, and whether the native control channel is present (`obsControl: true`). |
| `POST /api/obs/request` | **The control channel.** `{requestType, requestData}` in, `{requestType, requestStatus, responseData}` out. A refused request is still an HTTP 200; the outcome is in `requestStatus`. |
| `POST /api/obs/batch` | The same, for a list of requests in one round trip (`{requests:[…]}` → `{results:[…]}`). The UI uses it for the per-input audio refresh. |
| `GET /api/obs/requests` | Every request type this build implements. |
| `GET /api/obs/events` | The **event stream**: Server-Sent Events, one `data:` frame per OBS event (`{eventType, eventIntent, eventData}`). Optional `?intents=<bitmask>`. |
| `GET /obs-config.json` | obs-websocket port/password/enabled, read from OBS's config. |
| `POST /api/shutdown` | Shuts OBS down. This is what **File > Exit** calls, so OBS can be stopped from the browser. Refused with 409 while a remux is running unless `force=1` is passed. |
| `GET /api/preview.mjpg` | Live preview: JPEG frames as `multipart/x-mixed-replace` (`source`, `width`, `height`, `fps`, `quality`). |
| `GET /api/preview.jpg` | A single preview frame. |
| `GET /api/preview/multiview.mjpg\|.jpg` | Every scene composed into one grid (like OBS's Multiview), optionally pinned with `scenes=a,b,c`. |
| `GET /api/properties/source\|filter\|transition` | The real `obs_properties_t` schema (labels, types, ranges, list items, groups, visibility) plus current values. |
| `POST /api/properties/press` | Invokes a button property. |
| `POST /api/scenes/move` | Reorders scenes (no obs-websocket request exists). Indices are display order, `0` = top. |
| `POST /api/transitions/add\|rename\|remove` | Creates, renames and removes transition instances; built-in Cut/Fade stay protected. |
| `GET /api/hotkeys` | Every hotkey with the bindings OBS itself reports (formatted by OBS). |
| `POST /api/hotkeys/bind\|clear` | Rebinds a hotkey in OBS and persists it to the active profile. |
| `GET /api/encoders` | The Simple-output encoder, format and quality choices OBS offers, with its own localised labels and which ones this machine supports. |
| `GET /api/files/list` | Lists a directory OBS uses (`kind=recordings\|logs\|crashes\|config\|profile`, optional `path=` for a subdirectory). |
| `GET /api/files/download` | Streams a file from one of those directories as an attachment. |
| `GET /api/files/text` | Reads the tail of a text file, for the inline log viewer. |
| `GET /api/remux` | The remux queue: entries (source, target, state), the progress of the running one, and whether anything can be cleared. |
| `POST /api/remux/add\|start\|stop\|clear\|clearall` | Queue a recording (relative to the recordings directory, `format=mp4\|mov\|mkv`), run the queue through libobs' remuxer, stop it, or drop entries. Adding over an existing target is refused with 409 unless `overwrite=1`. |
| everything else | Static files from this directory; unknown paths fall back to `index.html`. |

Requests containing `..` (including percent-encoded) are rejected with 403, and
the resolved path must stay inside the web root.

## Quick start — external server

Useful for development, or to serve the UI from a different machine. Leave OBS
in its default web mode and this server **forwards every `/api/*` path to it**
(`--bridge <url>`, default `http://127.0.0.1:4456`) - including the SSE event
stream, which is piped rather than buffered. The externally served page then
gets the identical feature set, native control included, because it is talking
to the same service.

Without a bridge the page falls back to obs-websocket (start it in OBS under
Tools > WebSocket Server Settings, or leave web mode's auto-enable on) and the
preview falls back to `GetSourceScreenshot` polling.

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
makes it possible to point one copy of the UI at a different OBS (over
obs-websocket). `?host=&port=` also *disables* the native channel, so a page
served by OBS can still be pointed at another instance.

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
obs --web-port 4460 --no-browser
```

Web mode already implies `--disable-missing-files-check`, and `--no-browser`
keeps an autostart entry from opening a browser window on every login. Add
`--startrecording` / `--startstreaming` / `--startvirtualcam` /
`--startreplaybuffer` to start outputs immediately.

## Tests

```bash
npm test                      # unit/integration tests (both transports, store, fader, MJPEG parser, UI structure)
npm run test:browser          # headless-Chromium end-to-end check of the mock-backed UI
npm run test:live             # against a real networked OBS instance over obs-websocket (GPU pixels, remux)
npm run test:native           # against a real networked OBS instance over the native channel
npm run test:native:browser   # real Chromium + real OBS: the UI drives OBS with no websocket at all
```

`npm run test:browser` boots the mock obs-websocket server, loads the real UI in
headless Chromium over the DevTools protocol, and asserts that the docks, scene
list, source list, mixer strips, transitions, controls, status bar, menu bar and
Studio Mode all rendered — and that the page produced **no** console errors or
uncaught exceptions. It writes screenshots to `/tmp/webmix-smoke*.png`.

`test:native` is the one that matters most. Against a live OBS it checks that
every request type the UI calls is implemented, that the read requests return
the shapes the panels render, that writes come back as events on the stream, and
that audio meters actually flow. `test:native:browser` then loads the real UI in
Chromium against that same OBS and fails if the page constructs even one
`WebSocket` — which is the whole point of the architecture.

The mock server (`test/helpers/mock-obs.mjs`) speaks the real protocol
(including the SHA-256 challenge/auth handshake), and
`test/helpers/native-obs.mjs` implements the four `/api/obs/*` endpoints, so
each client is exercised against a faithful peer rather than stubs.

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
    obs-direct.js       NATIVE client: HTTP requests + SSE events, no websocket
    obs-client.js       obs-websocket v5 client — the fallback transport
    store.js            state mirror + OBS event reducers, topic-based re-render
    api.js              high-level OBS operations (transport-agnostic)
    fader.js            OBS log fader curve + meter scale (ported from libobs)
    dom.js              tiny DOM/reconcile helpers
    ui/                 menu, docks, panels, preview, dialogs, icons
  tools/
    gen-protocol.mjs    regenerate src/protocol.js from protocol.json
    enable-websocket.mjs
    browser-smoke.mjs
  docs/
    architecture.md     how the native control channel works and why
    ui-spec.md          extracted OBS window/menu/dialog structure
    theme-spec.md       extracted theme tokens and per-widget rules
```

The native channel is implemented in `frontend/webmix/`:

```
WebMixServer.{hpp,cpp}       QTcpServer: static files + /api/* + the SSE stream
WebMixControl.{hpp,cpp}      the control service: dispatch, lookups, serializers
WebMixControlInternal.hpp    the seam the handler groups implement against
WebMixControl_General.cpp    version, stats, hotkeys, profiles, video/output settings
WebMixControl_Scenes.cpp     scenes, studio mode, groups, scene items
WebMixControl_Inputs.cpp     inputs, audio, sources, screenshots, filters
WebMixControl_Outputs.cpp    transitions, stream, record, replay buffer, virtual cam
WebMixControlEvents.cpp      the event bridge: libobs signals -> SSE frames
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
  The stream runs at **60 fps** and each frame is encoded at the size the pane
  actually shows rather than at the canvas size, so the browser decodes and
  uploads a fraction of the pixels - that difference is what makes the preview
  feel like the native window instead of a slideshow. Frames are encoded at
  quality 92, which is where the encoder switches to **4:4:4** chroma: below it
  colour is stored at a quarter of the resolution and coloured text and UI edges
  smear visibly. The encoder is libjpeg called directly (`WebMixPreview.cpp`)
  rather than `QImage::save`, because Qt turns on Huffman optimisation - about
  three times the encode time for a few percent of size, and encode time is what
  decides whether a large pane can still hold 60 fps. A `ResizeObserver` follows
  splitter drags, and the preview's context menu reports the frame rate actually
  painted (e.g. `Preview: 59.8 fps (stream, 800×450)`).
* **Select, move and scale in the preview** — click a source to select it, drag
  to move, drag a handle to resize; the selection frame is drawn from OBS's own
  scene-item transform. While dragging, an edge or a centre that comes within
  8 px of a canvas edge or the canvas centre **sticks** to it and a guide line
  shows which line it caught. Hold **Alt** to place it exactly where the pointer
  is. The geometry is pure and lives in `src/scene-geometry.js`, so it is unit
  tested without a browser.
* **Properties and Filters** — rendered from the real OBS property schema via
  the WebMIX bridge, so the dialogs show the same localised labels, sliders,
  ranges, list/radio choices, colour pickers, font pickers, groups and
  conditional visibility as the desktop UI, with live apply.
* **Dialogs** — Transform (fully faithful: position, rotation, scale, bounds,
  crop, alignment grid), Stats, Advanced Audio, Properties, Filters,
  Settings (Stream / Output / Video / Audio / Advanced / Hotkeys), About.
  The Output page covers OBS's Simple mode: stream and recording encoders (the
  same option set and localised names the desktop offers, filtered to what this
  machine supports), video/audio bitrate, recording path, container, quality and
  the replay buffer - all read and written through the active profile.
* **Stats dock** — View > Docks > Stats, rendering the same figures as the
  Stats dialog (both are generated from one `statsRows()` source).
* **Multiview** — View > Multiview opens a full-screen grid of every scene.
  OBS composes the tiles server-side (program outlined, aspect-fitted, like the
  desktop multiview) and the page streams them on the GPU with HTML labels and a
  PROGRAM badge layered on top.
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
local control surface that is reachable from the browser, and requiring a
credential the browser has no way to obtain would only add a step, not a
boundary. It binds to `127.0.0.1` by default. `/obs-config.json` still hands out
the obs-websocket password, because the fallback transport has to connect
somehow - but the native channel the page normally uses needs no secret at all.

Binding it beyond loopback (`--web-host 0.0.0.0`, or `WebHost` in
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
| **WebGPU** | OBS serves the UI (the default) and the browser exposes `navigator.gpu` | JPEG frames stream over `/api/preview.mjpg` at 60 fps and at the pane's size; `createImageBitmap` decodes them and a WGSL shader draws an aspect-fitted quad. Zoom/scaling are GPU transforms. |
| **Native stream** | OBS serves the UI but the browser has no WebGPU (Firefox on Linux, for instance) | The same `/api/preview.mjpg` endpoint goes straight into an `<img>`. Browsers have decoded multipart JPEG themselves for decades, so there is **no JavaScript per frame at all** - this is what makes such a browser preview as smooth as the native window instead of a 15 fps slideshow. |
| Screenshots | A page served by a plain static host, with no bridge to OBS | `GetSourceScreenshot` polling, painted into an `<img>`. Slow by nature; the panel's context menu names the active backend. |

A browser without WebGPU would otherwise fall back to screenshot polling, which
is a round trip per frame - that is the "slideshow" case, and the native stream
backend exists to remove it. If a browser cannot show a multipart JPEG in an
`<img>` either, the panel notices within three seconds and falls back to
polling rather than showing a frozen frame.

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

### Colour order

OBS stores colours as `0xAABBGGRR` — **red in the low byte** (`vec4_from_rgba()`
in `libobs/graphics/vec4.h` memcpy's the integer straight into an R,G,B,A byte
array). That is the opposite of the CSS convention, so `colorIntToHex()` /
`hexToColorInt()` in `src/properties.js` do the swap; getting it wrong shows red
and blue exchanged in every colour picker, and the live check pins it by reading
a red source's colour back out of OBS.

## Known gaps (and why)

These are limits of the *vocabulary*, not of the transport: the native control
service implements exactly the request types the UI uses, and the rows below are
things no transport exposes today. Each one reports a clear message in the UI
instead of failing silently.

Several rows that used to be here - scene ordering, transition management,
property schemas, hotkey rebinding, remuxing, file access, exiting OBS - needed
a side channel precisely because obs-websocket had no request for them. They are
now ordinary `/api/*` endpoints of the same in-process service, so they work
whenever the page is served by OBS, which is the normal case.

| Area | Gap |
| --- | --- |
| Preview video | Solved in `--web` mode by the embedded MJPEG endpoint + WebGPU, and for the external server by forwarding `/api/*` to the bridge. Only a plain static host with no bridge falls back to `GetSourceScreenshot` polling. |
| Scene order | No obs-websocket request exists, so it runs through the bridge (`POST /api/scenes/move`). Unavailable when the UI is served externally. |
| Transition management | Same: bridge-only (`/api/transitions/*`). |
| Properties / filter settings | Solved when OBS serves the UI (`/api/properties/*` serialises `obs_properties_t`). With an external server the fallback key-based form is used. |
| Hotkey bindings | The bridge rebinds them in OBS and persists them (`/api/hotkeys/bind`). Separately, the browser can capture a shortcut and send `TriggerHotkeyByName` - which is what works while OBS is headless, since a window-less OBS never receives key presses. |
| Custom browser docks | Implemented, but a real browser enforces `X-Frame-Options` / CSP `frame-ancestors`, which OBS's embedded browser ignores. Sites that refuse framing (many do) cannot be docked outside OBS; the dock reports it. |
| Scene collections / profiles | List/switch/create/remove work, but duplicate/rename/import/export do not. |
| Undo/redo, source group/ungroup, copy/paste duplicate | Not exposed. |
| "Hide in Mixer", mixer pin/lock | Not exposed. |
| Recordings / logs / config folders | Solved via `/api/files/*` (list, download, view). File > Remux Recordings is solved too: the queue and its worker run inside OBS (`/api/remux`), so a recording can be converted to MP4 from the browser. Uploading a log to obsproject.com, the Plugin Manager and the Auto-Configuration Wizard are still desktop-only. |
| Always On Top, OS folders, tray | Apply to the desktop window, not the browser. |
| Exit OBS | obs-websocket has no shutdown request, but the embedded server adds `POST /api/shutdown`, so File > Exit works when OBS serves the UI (the default). With an external server there is still no way. |

The browser frontend is now served by OBS itself in its default web mode
(`frontend/webmix/WebMixServer.cpp`, a QTcpServer-based static server plus the
control endpoints), so an installed OBS needs nothing else. `node server.mjs`
remains as the development/remote option.

## Packaged releases

GitHub releases carry ready-made packages built by
`.github/workflows/release.yml` (Windows zip, Debian/Ubuntu `.deb`, Arch Linux
package plus a pacman repository). They include the Browser source (CEF) but no
Lua/Python script hosts, and they install the same layout as a source build:
`/usr/bin/obs` with a `/usr/bin/webmix` symlink, the plugins under
`/usr/lib/obs-plugins` and this directory under `/usr/share/obs-studio/web`, so
the WebGPU preview and every bridge endpoint work straight after installing.

```bash
webmix                    # http://127.0.0.1:4456/
```

See `packaging/README.md` for how to build each package yourself; Arch users can
add the repository once and then just use pacman:

```bash
curl -LO https://github.com/fursyt12/WebMIX/releases/latest/download/add-repo.sh
chmod +x add-repo.sh && ./add-repo.sh --install
```

## Building the OBS fork (Linux)

Current Arch packages are missing or too new for several of this checkout's
dependencies. They can all be built into a local prefix without root:

| Dependency | Why | Note |
| --- | --- | --- |
| **extra-cmake-modules** (ECM) | `cmake/linux/ecmconfig.cmake` requires it | `pacman -S extra-cmake-modules`, or point `ECM_DIR` at a stub whose `ECM_MODULE_PATH` is Qt6's `3rdparty/extra-cmake-modules/find-modules` - this checkout calls no `ecm_*` function and only needs `FindX11_XCB.cmake` from it |
| **nlohmann/json** | the frontend's plugin manager and updater | header-only, but it has to be the *full* `include/nlohmann/` tree; the single-include `json.hpp` alone is not enough because `GoLiveAPI_CensoredJson.hpp` includes `nlohmann/json_fwd.hpp` |
| **libjpeg** (dev) | the WebMIX preview encoder calls libjpeg directly instead of going through Qt | build-time only: Qt already needs libjpeg at runtime, so nothing new is shipped |
| `extra-cmake-modules` (ECM) | `cmake/linux/ecmconfig.cmake` requires it | `pacman -S extra-cmake-modules`, or install from source |
| `libwebsockets` | obs-websocket's server backend | `pacman -S libwebsockets`, or build from source |
| **MbedTLS 3.x** | `plugins/obs-outputs` requires `3...<4`; Arch ships 4.2.0 | build `v3.6.2` from source with `-DCMAKE_POSITION_INDEPENDENT_CODE=ON` (a static, non-PIC build links `obs-outputs.so` with *"relocation … can not be used when making a shared object"*); on GCC 16 it also needs `-Wno-unterminated-string-initialization` |
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
