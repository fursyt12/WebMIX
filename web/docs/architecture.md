# WebMIX architecture

## The idea

WebMIX is a frontend of OBS, not a client of a plugin.

The browser is the only user interface. The page is served by OBS itself and
speaks to a **native control service that lives inside the OBS process**, which
calls libobs and the frontend API directly. There is no protocol server in the
path, no second port, no password and no plugin to switch on: the browser
addresses the program.

```
┌──────────────────────────── browser ────────────────────────────┐
│  WebMIX SPA (web/)                                              │
│    ui/*            docks, dialogs, panels                       │
│    api.js          high level operations                        │
│    store.js        state mirror + event reducers                │
│    obs-direct.js ──┐                          ┌── obs-client.js  │
└────────────────────┼──────────────────────────┼─────────────────┘
         HTTP + SSE  │                          │  ws://host:4455
                     ▼                          ▼  (fallback only)
┌──────────────────────────── OBS process ────────────────────────┐
│  WebMixServer      QTcpServer: static files + /api/*            │
│    ├── /api/obs/*  HTTP request/response + SSE event stream     │
│    └── /api/*      preview, property schema, files, remux, …    │
│  WebMixControl     the control service (frontend/webmix)        │
│    ├── request table  requestType -> libobs / frontend API      │
│    └── event bridge   libobs signals -> subscribers             │
│  WebMixBridge      obs_properties_t serialization, hotkeys, …   │
│  libobs + OBSBasic the application itself                       │
└─────────────────────────────────────────────────────────────────┘
```

## Why obs-websocket is not the transport

The previous design served the page from OBS but drove the application through
the obs-websocket plugin: the browser opened `ws://…:4455` and everything -
state and control - went through a protocol whose only reason to exist is
*remote* access. That has three costs a frontend does not have to pay:

* **A dependency that can be absent.** The UI could not work unless a plugin
  was enabled, on a port, with credentials; `--web` had to rewrite the plugin's
  own config file before it loaded.
* **A vocabulary that is not the application.** Anything obs-websocket has no
  request for (scene order, transition instances, hotkey rebinding, the
  `obs_properties_t` schema, remuxing) needed a second, ad-hoc HTTP bridge.
* **A hop that buys nothing.** The plugin and the frontend live in the same
  process; the round trip through a socket and a JSON protocol existed only
  because of how the two were historically separated.

obs-websocket still ships, still works, and is still used here - as the
**fallback transport** for pages that are not served by OBS (the development
server, or a page pointed at another machine). It is a supported way to reach
OBS; it is simply no longer the way this frontend reaches it.

## The seam: vocabulary, not transport

`WebMixControl` (`frontend/webmix/WebMixControl.{hpp,cpp}`) is a request table
and an event bus:

```cpp
Response Request(const QString &requestType, const QJsonObject &requestData);
quint64  Subscribe(EventSink sink, int intents);
void     Emit(const QString &eventType, const QJsonObject &eventData, int intent);
```

Keeping the *vocabulary* (`GetSceneList`, `SceneItemTransformChanged`, …) and
changing only the *transport* is what made the migration tractable: `api.js`,
`store.js` and every panel were written against these names, so they did not
change at all. `ObsDirectClient` implements the same surface as `ObsClient`
(`connect`, `request`, `requestBatch`, `getVersion`, the same events and error
types), and `app.js` picks one:

```js
if (host.obsControl) client = new ObsDirectClient({ base: '' });
else                 client = new ObsClient({ host, port, password });
```

`obsControl` comes from `GET /api/status`, so the choice is made by asking the
host what it is, not by configuration.

The handlers themselves are split by area so no single file becomes a
gazetteer:

| File | Request types |
| --- | --- |
| `WebMixControl_General.cpp` | version, stats, hotkeys, dialogs, profiles, scene collections, video/stream/record settings |
| `WebMixControl_Scenes.cpp` | scenes, studio mode, groups, scene items |
| `WebMixControl_Inputs.cpp` | inputs, audio, sources, screenshots, filters |
| `WebMixControl_Outputs.cpp` | transitions, streaming, recording, replay buffer, virtual camera |
| `WebMixControlEvents.cpp` | the event bridge |

They are all wired into `WebMixControlInternal.hpp`, which is the only contract
they share.

## The transport

| Endpoint | Meaning |
| --- | --- |
| `POST /api/obs/request` | `{requestType, requestData}` → `{requestType, requestStatus, responseData}` |
| `POST /api/obs/batch` | `{requests:[…]}` → `{results:[…]}`, one round trip (used by the audio refresh) |
| `GET /api/obs/requests` | the request types this build implements |
| `GET /api/obs/events` | Server-Sent Events: one `data:` frame per OBS event |

Two decisions worth recording:

* **A refused request is an HTTP success.** The outcome lives in
  `requestStatus`, exactly as it did on the protocol the UI was written
  against, so a caller has one error path (`ObsRequestError`) instead of two.
* **The event stream is read with `fetch()`, not `EventSource`.** The stream has
  to be abortable on disconnect and reconnected with WebMIX's own backoff, and
  `EventSource` offers neither. Reading the body stream also keeps the whole
  reconnect policy in one place.

Backpressure matters because `InputVolumeMeters` fires ~60 times a second per
input: when a socket has more than 512 KB queued, meter and per-frame-transform
frames are dropped rather than queued. They are time-sensitive values, so the
newest one is worth more than the backlog.

## Events

`WebMixControlEvents.cpp` connects the same libobs signals obs-websocket's
`EventHandler` tree connects, and emits the same payload shapes:

* `obs_frontend_add_event_callback` for scene changes, studio mode, outputs,
  profiles, scene collections, screenshots and exit;
* the core signal handler for source create/destroy/rename;
* per-source signals for input audio state, media playback, scene items,
  filters and transitions.

Two deliberate improvements over the reference implementation:

* Scene signals do not always carry the scene in their calldata (`reorder`
  carries nothing, `item_transform` carries only the item). The scene is taken
  from the signal's own context first and from the calldata as a fallback, so
  `SceneItemListReindexed` and `SceneItemTransformChanged` actually fire.
* Volume meters are accumulated here and published on a 16 ms timer instead of
  being tied to a protocol's per-client subscription bookkeeping. The audio
  callback runs on an audio thread and touches only its own meter under a
  mutex; everything else is main-thread.

## Colour, order and other wire details

The wire format is not neutral, and two conventions bite:

* **Scene order.** libobs enumerates scenes bottom-first; obs-websocket returns
  them reversed, and `store.js` reverses them again to get display order. The
  native service keeps the same wire format rather than "fixing" it, because
  the fallback transport has to agree.
* **Colours.** OBS stores `0xAABBGGRR` (red in the low byte), the opposite of
  CSS; `properties.js` does the swap.
* **Bounds type.** `dialogs.js` selects on the `OBS_BOUNDS_*` *names*, while
  obs-websocket sends the numeric enum. The native service sends the names
  (see `BoundsTypeName`), and reads either form back.

## Threading

Every entry point runs on the Qt main thread - the embedded HTTP server lives
there, and so do the frontend callbacks and almost all libobs signals - so no
locking is needed and no request handler may block. The two exceptions are
explicitly contained: the audio capture callback accumulates levels under its
own mutex, and the remux worker keeps its existing dedicated thread
(`WebMixRemux`).

## Where things live

```
frontend/webmix/
  WebMixServer.{hpp,cpp}          HTTP + SSE transport, static files, /api/*
  WebMixControl.{hpp,cpp}         request dispatch, lookups, serializers
  WebMixControlInternal.hpp       the seam between dispatch and the groups
  WebMixControl_*.cpp             request handlers, by area
  WebMixControlEvents.cpp         libobs signals -> events
  WebMixBridge.{hpp,cpp}          obs_properties_t schema, hotkeys, operations
  WebMixPreview.*                 preview frames and multiview composition
  WebMixRemux.*                   the remux queue
  WebMixFiles.cpp                 confined directory access
  OBSBasic_WebMix.cpp             the narrow OBSBasic seam for scenes/transitions
web/
  src/obs-direct.js               the native client (HTTP + SSE)
  src/obs-client.js               the obs-websocket client (fallback)
  src/api.js, store.js, ui/*      transport-agnostic application
```
