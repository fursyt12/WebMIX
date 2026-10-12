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

## The preview

The preview is the one part of the interface where the transport decides how
the product feels, so it does not share the control channel's "everything on
the main thread" rule. A frame passes through three threads, each doing the one
step it is suited to (`WebMixPreview.cpp`):

```
graphics thread   OBS has just rendered the program
                  -> draw the picture into a small texture kept between frames
                  -> start the read-back
worker thread     finish the read-back (this is the wait for the GPU)
                  -> skip the frame if the picture has not changed
                  -> JPEG-encode
main thread       write the part to every socket that has room for it
```

* **The program pane is the program.** `view=program` scales the texture OBS
  already rendered, so it costs one blit, shows transitions, and needs no new
  stream when the scene changes. Only the Studio Mode preview pane (and
  multiview tiles) render a scene a second time, as OBS's own preview does.
* **A frame is made only when somebody can take it.** A socket with bytes still
  queued skips the frame; when every client is in that state nothing is rendered
  or encoded at all. A slow reader therefore costs neither memory nor latency.
  (The first implementation wrote every frame to every socket regardless: over
  Wi-Fi the queue grew by megabytes a second until OBS ran out of memory, and
  what did arrive was seconds old.) The kernel's send buffer is capped for the
  same reason - what waits there cannot be skipped.
* **The encoder paces the renderer.** The graphics thread draws the next frame
  only when the worker is idle, so an encoder that cannot keep up lowers the
  frame rate instead of building a queue.
* **OBS's frame rate is the ceiling.** Frames come from a "main texture
  rendered" callback, not a timer, so there are no duplicates and no beat
  between two clocks.
* **Each part carries the boundary that ends it.** A browser showing the stream
  in an `<img>` paints a part once it has seen that boundary; leading with it
  instead held every frame back until the next one arrived.
* **Streams that ask for the same picture share it** - two tabs cost one
  render, one read-back and one encode.

`GET /api/status` reports the counters (`preview.encoded`, `sent`, `skipped`,
`still`, `busy`, `encodeMs`), which is the first place to look when the preview
feels slow: `skipped` is a client that cannot keep up, `busy` an encoder that
cannot, `still` a picture that is simply not changing.

On the page, a pane decodes only the newest frame it has, reopens a stream that
ends, errors or goes quiet (with backoff, and without involving the store), and
closes its streams while the tab is hidden.

## Lifetime

Two rules that are easy to break and expensive when broken:

* **A looked-up source is handed over, not copied.** `OBSSource` takes its own
  reference; a search that already holds one must give it up (`Adopt()` in
  `WebMixControl.cpp`). Leaving it behind makes the source immortal: removed
  inputs keep running, and at exit the audio inputs outlive libobs.
* **The server leaves when OBS says it is leaving.** It is a child of the
  application object, which is destroyed after libobs; everything that touches
  libobs is therefore stopped on `OBS_FRONTEND_EVENT_EXIT`, not in a destructor.

## Threading

The control channel runs on the Qt main thread - the embedded HTTP server lives
there, and so do the frontend callbacks and most libobs signals - so no request
handler may block. The exceptions are explicitly contained: the audio capture
callback accumulates levels under its own mutex, the meter table has a second
one because a source is destroyed on whichever thread drops its last reference,
the remux worker keeps its dedicated thread (`WebMixRemux`), and the preview
pipeline is described above.

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
