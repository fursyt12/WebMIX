# OBS Studio Desktop UI — Structural Specification

Reconnaissance reference for reproducing the **OBS Studio desktop UI 1:1 as a web application**.

Extracted from the OBS Studio source checkout at `/home/huckskee/git/WebMIX`
(commit `2a4dfeb55`, "frontend: Fix source icon state appearing inverted").

This document is deliberately a *structural* spec: it records the widget tree, object
names, widget classes, layout geometry/margins/stretch, dock placement, menu order,
icons, shortcuts, and the exact English text behind every translation key. It does not
describe OBS internals (encoder settings, source list behaviour, etc.) except where the
UI depends on them.

---

## 0. Sources, scope, and label-resolution conventions

### 0.1 Files read

| Path | Lines | Role |
| --- | --- | --- |
| `frontend/forms/OBSBasic.ui` | 2294 | Main window (QMainWindow: menubar, central widget, docks, statusbar, actions) |
| `frontend/forms/OBSBasicControls.ui` | 356 | "Controls" dock content (`OBSBasicControls` QWidget) |
| `frontend/forms/StatusBarWidget.ui` | 451 | Status bar internal widget (`StatusBarWidget` QWidget) |
| `frontend/forms/OBSBasicFilters.ui` | 669 | Filters dialog |
| `frontend/forms/OBSBasicProperties.ui` | 179 | Properties dialog |
| `frontend/forms/OBSBasicTransform.ui` | 962 | Scene Item Transform dialog |
| `frontend/forms/OBSBasicSourceSelect.ui` | 663 | Add Source dialog |
| `frontend/forms/OBSAdvAudio.ui` | 349 | Advanced Audio Properties dialog |
| `frontend/forms/source-toolbar/browser-source-toolbar.ui` | — | Browser source toolbar |
| `frontend/forms/source-toolbar/color-source-toolbar.ui` | — | Colour source toolbar |
| `frontend/forms/source-toolbar/device-select-toolbar.ui` | — | Shared device/combo toolbar (audio/display/window/device/app-capture) |
| `frontend/forms/source-toolbar/game-capture-toolbar.ui` | — | Game capture toolbar |
| `frontend/forms/source-toolbar/image-source-toolbar.ui` | — | Image source toolbar |
| `frontend/forms/source-toolbar/media-controls.ui` | — | Media playback controls |
| `frontend/forms/source-toolbar/text-source-toolbar.ui` | — | Text source toolbar |
| `frontend/widgets/OBSBasic.hpp` | 1705 | Class shape, dock members, enums |
| `frontend/widgets/OBSBasic.cpp` | 2103 | Dock creation/placement, shortcuts, action groups |
| `frontend/widgets/OBSBasic_MainControls.cpp` | 713 | Menu action handlers, stats/remux/about |
| `frontend/widgets/OBSBasic_Docks.cpp` | 260 | Default dock layout, lock/side/reset |
| `frontend/widgets/OBSBasic_SceneCollections.cpp` | 1705 | Scene Collection menu population |
| `frontend/widgets/OBSBasic_Profiles.cpp` | 1113 | Profile menu population |
| `frontend/widgets/OBSBasic_Transitions.cpp` | 1569 | Transition dock behaviour |
| `frontend/widgets/OBSBasic_ContextToolbar.cpp` | 305 | Source Toolbar (context bar) construction |
| `frontend/widgets/OBSBasicControls.cpp` | 285 | Controls dock runtime state |
| `frontend/widgets/OBSBasicStatusBar.cpp` | 620 | Status bar runtime behaviour |
| `frontend/widgets/AudioMixer.cpp` | 1123 | Audio Mixer dock internals |
| `frontend/components/VolumeControl.cpp` | — | Mixer channel strip |
| `frontend/utility/OBSTranslator.cpp` | 36 | How `.ui` strings are translated |
| `frontend/data/locale/en-US.ini` | 1729 | English text for every lookup key |

### 0.2 How labels resolve (read this before using the tables)

`.ui` `<string>` elements are **lookup keys**, not literal labels. At runtime
`OBSTranslator::translate()` (`frontend/utility/OBSTranslator.cpp:26`) takes the source
text, **strips all spaces**, and looks it up in the merged locale tables; if the lookup
fails it returns the original text unchanged.

Consequences that matter for reproduction:

* `Basic.MainMenu.File` → **`&File`**; `Basic.Main.Scenes` → **`Scenes`**.
* A literal-looking string that also happens to be a key is still resolved, e.g.
  `Mixer` (dock title) → **`Audio Mixer`**, `Rename` → **`Rename...`**,
  `Duplicate` → **`Duplicate...`**, `New` → **`New...`**, `RestoreDefaults` → **`Defaults`**.
* Ampersands in locale values are Qt mnemonic markers (`&File`, `Show &Recordings`).
  The web UI should render them as access keys or strip them, never show `&`.
* `%1`, `%2` are positional substitutions (Qt `QString::arg`).
* `frontend/data/locale/en-US.ini` is the canonical English table; §7 is generated from it.

### 0.3 Object names / classes

* Object names are the Qt `name=` / `objectName()` values and are the stable identifiers
  used by the C++ (`ui-><name>`). Use the same names in the web DOM/tree.
* Handlers named `OBSBasic::on_<objectName>_<signal>()` are **auto-connected by Qt name
  convention**; where a connection is manual it is called out explicitly.

---

## 1. Main window layout tree

### 1.1 `OBSBasic` — `QMainWindow`

| Property | Value |
| --- | --- |
| object name / class | `OBSBasic` / `QMainWindow` |
| default geometry | 1280 × 960 at (0,0) |
| minimum size | 0 × 0 |
| window title | `.MainWindow` → **`OBS Studio`** is set at runtime by `UpdateTitleBar()`; the `.ui` value is a placeholder |
| window icon | `:/res/images/obs.png` (resource `obs.qrc`) |
| style sheet | empty (`notr="true"`) |
| `dockOptions` | `AllowNestedDocks \| AllowTabbedDocks` |
| status bar | `statusbar` (`OBSBasicStatusBar`, a `QStatusBar` subclass) |
| menu bar | `menubar` (`QMenuBar`, height 22) |
| dock widgets | 4 in the `.ui` (`scenesDock`, `sourcesDock`, `mixerDock`, `transitionsDock`) + 2 created in C++ (`controlsDock`, `statsDock`) |

The `.ui` declares no `QSplitter` at the main-window level. Splitting is achieved with
`QMainWindow` dock nesting; the only splitters in the app are inside dialogs (§6).

### 1.2 Central widget hierarchy

```
OBSBasic [QMainWindow]
└─ centralwidget [QWidget]
   └─ verticalLayout [QVBoxLayout]  spacing=0, margins L4 T0 R4 B0
      ├─ canvasEditor [QWidget]
      │  └─ previewLayout [QHBoxLayout]  spacing=2, margins 1/1/1/1
      │     ├─ previewDisabledWidget [QFrame]                 (shown while preview disabled)
      │     │  └─ verticalLayout_7 [QVBoxLayout] spacing=0, margins 1/1/1/1
      │     │     ├─ verticalSpacer_2 [spacer] Vertical 20×40
      │     │     ├─ label [QLabel]  text=Basic.Main.PreviewDisabled → "Preview is currently disabled", AlignCenter
      │     │     ├─ horizontalLayout [QHBoxLayout]
      │     │     │  ├─ horizontalSpacer_2 [spacer] 40×20
      │     │     │  ├─ enablePreviewButton [QPushButton] text=Basic.Main.PreviewConextMenu.Enable → "Enable Preview"
      │     │     │  └─ horizontalSpacer_3 [spacer] 40×20
      │     │     └─ verticalSpacer_3 [spacer] Vertical 20×40
      │     └─ previewContainer [QWidget]
      │        └─ previewTextLayout [QVBoxLayout] spacing=0, margins 0
      │           ├─ previewLabel [QLabel] text=StudioMode.PreviewSceneName → "Preview: %1"
      │           │     alignment=Leading|Left|VCenter ; class="label-preview-title"
      │           └─ gridLayout [QGridLayout] spacing=0
      │              ├─ preview [OBSBasicPreview]                       @r1 c0 rowspan1 colspan2
      │              │     min 32×32, focusPolicy=ClickFocus,
      │              │     contextMenuPolicy=CustomContextMenu, +action actionRemoveSource
      │              ├─ previewYScrollBar [QScrollBar] Vertical          @r1 c2
      │              ├─ previewXContainer [QWidget]                      @r2 c1
      │              │  └─ horizontalLayout_7 [QHBoxLayout] spacing=0, margins 0
      │              │     ├─ previewZoomOutButton [QPushButton]
      │              │     │     20×16 fixed, icon=:/res/images/minus.svg (8×8),
      │              │     │     toolTip/accessibleName=Basic.MainMenu.Edit.Scale.ZoomOut,
      │              │     │     text="", class=icon-minus, toolButton=true
      │              │     ├─ previewScalePercent [OBSPreviewScalingLabel] text="100%", AlignCenter
      │              │     ├─ previewZoomInButton [QPushButton]
      │              │     │     20×16 fixed, icon=:/res/images/plus.svg (8×8),
      │              │     │     toolTip/accessibleName=Basic.MainMenu.Edit.Scale.ZoomIn,
      │              │     │     text="", class=icon-plus, toolButton=true
      │              │     ├─ previewScalingMode [OBSPreviewScalingComboBox]
      │              │     │     items: Basic.MainMenu.Edit.Scale.Window ("Scale to Window"),
      │              │     │            Basic.MainMenu.Edit.Scale.Canvas ("Canvas (%1x%2)")
      │              │     ├─ horizontalSpacer_5 [spacer] Horizontal, Fixed 4×0
      │              │     └─ previewXScrollBar [QScrollBar] Horizontal, min=-200 max=200 step=10
      │              └─ (grid has no explicit column stretch)
      └─ contextContainer [QFrame]                                       (Source Toolbar row, §4)
         └─ horizontalLayout9 [QHBoxLayout] spacing=6, margins 6/4/6/4
            ├─ contextSubContainer [QFrame]
            │  └─ horizontalLayout_5 [QHBoxLayout] spacing=6, margins 0
            │     ├─ contextSourceIcon [QLabel]        22×22 fixed, text=""
            │     ├─ contextSourceLabel [QLabel]       160×22 fixed, text="TextLabel" (runtime = source name)
            │     ├─ contextSourceIconSpacer [QLabel]  22×22 fixed, text=""
            │     ├─ line_3 [Line] Vertical
            │     ├─ sourcePropertiesButton [QPushButton] min 0×22, icon=:/settings/images/settings/general.svg,
            │     │     text=Properties, toolTip=SourceProperties
            │     ├─ sourceFiltersButton [QPushButton]    min 0×22, icon=:/res/images/filter.svg,
            │     │     text=Filters, toolTip=SourceFilters
            │     ├─ sourceInteractButton [QPushButton]   min 0×22, icon=:/res/images/interact.svg,
            │     │     text=Interact, toolTip=Interact, class="icon-touch"
            │     └─ line [Line] Vertical
            └─ emptySpace [QFrame] min 0×22
               └─ horizontalLayout_6 [QHBoxLayout] spacing=0, margins 0   ← per-source toolbar host
```

Notes:
* `previewDisabledWidget` and `previewContainer` are two alternatives inside
  `previewLayout`; only one is visible at a time (`EnablePreviewDisplay`).
* `previewLayout` direction is flipped to `BottomToTop` when the `StudioPortraitLayout`
  config is on (`OBSBasic::ResetUI`).
* `contextContainer` is toggled by **View → Source Toolbar** (`ui->toggleContextBar`).

### 1.3 Docks (`.ui` definitions)

All four `.ui` docks are `OBSDock` (`QDockWidget` subclass, `frontend/docks/OBSDock.hpp`)
with `features = DockWidgetClosable | DockWidgetFloatable | DockWidgetMovable`.
In the `.ui` every dock carries `<attribute name="dockWidgetArea"><number>8</number>`
(i.e. `Qt::BottomDockWidgetArea`); the real default arrangement is applied in C++ (§1.4).

| objectName | class | windowTitle key | English title | `.ui` area | content widget | content objectName |
| --- | --- | --- | --- | --- | --- | --- |
| `scenesDock` | OBSDock | `Basic.Main.Scenes` | **Scenes** | Bottom (8) | SceneTree dock panel | `dockWidgetContents_2` |
| `sourcesDock` | OBSDock | `Basic.Main.Sources` | **Sources** | Bottom (8) | SourceTree dock panel | `dockWidgetContents_6` |
| `mixerDock` | OBSDock | `Mixer` (literal) | **Audio Mixer** (lookup!) | Bottom (8) | `AudioMixer` created in C++ | `dockWidgetContents_7` |
| `transitionsDock` | OBSDock | `Basic.SceneTransitions` | **Scene Transitions** | Bottom (8) | Transition panel | `dockWidgetContents_5` |
| `controlsDock` | OBSDock (C++ only) | `Basic.Main.Controls` | **Controls** | Bottom (C++) | `OBSBasicControls` | (widget itself) |
| `statsDock` | OBSDock (C++ only) | `Basic.Stats` | **Stats** | Bottom (C++), hidden+floating | `OBSBasicStats` | (widget itself) |

`mixerDock` also sets `contextMenuPolicy=CustomContextMenu`.

### 1.4 Default dock arrangement and sizes (from C++)

Constructor (`OBSBasic.cpp`):

1. `setDockCornersVertical(true)` is called first.
2. `addDockWidget(Qt::LeftDockWidgetArea, ui->scenesDock)`
3. `splitDockWidget(ui->scenesDock, ui->sourcesDock, Qt::Vertical)` — Sources sits **below** Scenes.
4. `resizeDocks({scenesDock, sourcesDock}, {sideDockWidth, sideDockWidth}, Qt::Horizontal)`
   where `sideDockWidth = min(windowWidth * 30 / 100, 320)`.
5. `addDockWidget(Qt::BottomDockWidgetArea, controlsDock)`
6. `startingDockLayout = saveState()`
7. `statsDock`: created, features Closable|Movable|Floatable, added Bottom,
   `setVisible(false)`, `setFloating(true)`, `resize(700, 200)` and moved near window centre.

**View → Docks → Reset Docks** (`OBSBasic_Docks.cpp::on_resetDocks_triggered`) restores
the saved layout and then applies the canonical default sizes:

| Setting | Value |
| --- | --- |
| `sideDocks` checked | `true` (full-height docks) |
| Scenes/Sources width | `min(windowWidth * 30 / 100, 280)` |
| Bottom dock row height | `windowHeight * 225 / 1000` (22.5 %) for all of mixer/transitions/controls |
| Mixer width | `windowWidth * 45 / 100` |
| Transitions width | `windowWidth * 14 / 100` |
| Controls width | `windowWidth * 16 / 100` |
| Visible on reset | scenes, sources, mixer, transitions, controls = true; stats = hidden, floating |
| If custom browser docks exist | a confirmation dialog `ResetUIWarning.Title` / `.Text` is shown first (unless forced) |

**Dock corners** (`setDockCornersVertical`):

* `true` (Full-Height Docks on): TopLeft/BottomLeft → `LeftDockWidgetArea`, TopRight/BottomRight → `RightDockWidgetArea`.
* `false`: top corners → `TopDockWidgetArea`, bottom corners → `BottomDockWidgetArea`.

**Lock Docks** (`on_lockDocks_toggled`): when locked, docks get `NoDockWidgetFeatures`;
when unlocked, all docks get `Closable|Movable|Floatable` **except** the five main docks,
which get Movable|Floatable only (not closable). `statsDock` keeps Closable.

Dock visibility is exposed through the **View → Docks** menu via
`dock->toggleViewAction()` (see §3.4).

### 1.5 Menu bar and status bar

* `menubar` (`QMenuBar`) with eight top-level menus, in this exact order:
  **File, Edit, View, Docks, Profile, Scene Collection, Tools, Help** (§3).
* `statusbar` (`OBSBasicStatusBar`) at the bottom of the main window. Its content widget
  is `StatusBarWidget` added with `addPermanentWidget(statusWidget, 1)` (§5).

---

## 2. Dock / panel inventory

### 2.1 `scenesDock` — "Scenes"

```
scenesDock [OBSDock]
└─ dockWidgetContents_2 [QWidget]
   └─ verticalLayout_6 [QVBoxLayout] spacing=0, margins 1/0/1/1
      └─ scenesFrame [QFrame]
         └─ verticalLayout_12 [QVBoxLayout] spacing=0, margins 0
            ├─ scenes [SceneTree]  (QListWidget subclass)
            │     contextMenuPolicy=CustomContextMenu, frameShape=NoFrame,
            │     frameShadow=Plain, spacing=0, +action actionRemoveScene
            ├─ scenesToolbar [QToolBar] iconSize=16×16
            │     actions, in order:
            │       1. actionAddScene        icon :/res/images/plus.svg   text=Add   toolTip=AddScene
            │       2. actionRemoveScene     icon :/res/images/minus.svg  text=Remove toolTip=RemoveScene
            │       3. separator
            │       4. actionSceneFilters    icon :/res/images/filter.svg text=SceneFilters toolTip=SceneFilters
            │       5. separator
            │       6. actionSceneUp         icon :/res/images/up.svg     text=MoveUp   toolTip=MoveSceneUp
            │       7. actionSceneDown       icon :/res/images/down.svg   text=MoveDown toolTip=MoveSceneDown
            └─ scenesFixedSizeHSpacer [spacer] Horizontal, Fixed 150×0
```

Extra scene actions created in C++: `renameScene` (QAction, text `Rename` → "Rename...",
shortcut F2 on Windows/Linux, Return on macOS, `WidgetWithChildrenShortcut`, added to the
dock; triggers `EditSceneName`).

### 2.2 `sourcesDock` — "Sources"

```
sourcesDock [OBSDock]
└─ dockWidgetContents_6 [QWidget]
   └─ verticalLayout_5 [QVBoxLayout] spacing=0, margins 1/0/1/1
      └─ sourcesFrame [QFrame]
         └─ verticalLayout_17 [QVBoxLayout] spacing=0, margins 0
            ├─ sources [SourceTree]  (QListView subclass)
            │     contextMenuPolicy=CustomContextMenu, frameShape=NoFrame,
            │     selectionMode=ExtendedSelection, spacing=0, +action actionRemoveSource
            ├─ sourcesToolbar [QToolBar] iconSize=16×16
            │     actions, in order:
            │       1. actionAddSource         icon :/res/images/plus.svg    text=Add        toolTip=AddSource
            │       2. actionRemoveSource      icon :/res/images/minus.svg   text=Remove     toolTip=RemoveSource
            │       3. separator
            │       4. actionSourceProperties  icon :/settings/.../general.svg text=Properties toolTip=SourceProperties (enabled=true)
            │       5. separator
            │       6. actionSourceUp          icon :/res/images/up.svg      text=MoveUp     toolTip=MoveSourceUp (enabled=true)
            │       7. actionSourceDown        icon :/res/images/down.svg    text=MoveDown   toolTip=MoveSourceDown (enabled=true)
            └─ sourcesFixedSizeHSpacer [spacer] Horizontal, Fixed 150×0
```

Extra source action created in C++: `renameSource` (text `Rename` → "Rename...", F2 /
Return, `WidgetWithChildrenShortcut`, triggers `EditSceneItemName`).

`actionRemoveSource` / `actionRemoveScene` default shortcut in the `.ui` is `Del`;
on macOS the code adds `Backspace` as well.

Dock toolbars are shown/hidden together by **View → Dock Toolbars**
(`toggleListboxToolbars`, checked by default).

### 2.3 `mixerDock` — "Audio Mixer"

The dock's `dockWidgetContents_7` only holds an empty `verticalLayout_4`
(spacing=0, margins 1/0/1/1). The real content is an `AudioMixer` (`QFrame`) assigned in
`OBSBasic.cpp:1085`; the dock's context menu is delegated to
`AudioMixer::showMixerContextMenu`.

`AudioMixer` widget tree (built in `frontend/widgets/AudioMixer.cpp`):

```
AudioMixer [QFrame]
└─ mainLayout [QVBoxLayout] margins 0, spacing 0
   ├─ stackedMixerArea [QStackedWidget] objectName="stackedMixerArea"
   │     index 0 → hMixerScrollArea [QScrollArea] objectName="hMixerScrollArea"
   │                 widget = hVolumeWidgets [QWidget] objectName="hVolumeWidgets"
   │                          layout hVolumeControlLayout [QVBoxLayout], AlignTop
   │     index 1 → vMixerScrollArea [QScrollArea] objectName="vMixerScrollArea"
   │                 widget = vVolumeWidgets [QWidget] objectName="vVolumeWidgets"
   │                          layout vVolumeControlLayout [QHBoxLayout], AlignLeft
   └─ mixerToolbar [QToolBar] iconSize=16×16, floatable=false
        order:
          1. toggleHiddenButton [QPushButton] checkable, text=Basic.AudioMixer.HiddenTotal ("%1 hidden"),
                toolTip = Basic.AudioMixer.HideHidden / ShowHidden, classes "toolbar-button toggle-hidden"
          2. separator
          3. spacer [QWidget] MinimumExpanding
          4. separator
          5. layoutButton [QAction] objectName="actionMixerToolbarToggleLayout", text="",
                icon=:/res/images/layout-vertical.svg (or layout-horizontal.svg),
                toolTip=Basic.AudioMixer.Layout.Vertical / .Horizontal
          6. separator
          7. advAudio [QAction] objectName="actionMixerToolbarAdvAudio", text/toolTip=Basic.AdvAudio,
                icon=:/settings/images/settings/advanced.svg, class "icon-cogs"
          8. separator
          9. optionsButton [QPushButton] text=Basic.AudioMixer.Options, classes "toolbar-button text-bold",
                menu = mixerMenu
```

Mixer **Options** menu (`createMixerContextMenu`), in order:

| Order | Item | Type |
| --- | --- | --- |
| 1 | `UnhideAll` → "Unhide All" | QAction |
| 2 | separator | |
| 3 | `Basic.AudioMixer.ShowHidden` → "Show hidden sources" | MenuCheckBox (checkable) |
| 4 | `Basic.AudioMixer.ShowInactive` → "Show inactive sources" | MenuCheckBox |
| 5 | `Basic.AudioMixer.KeepHiddenRight` / `KeepHiddenBottom` → "Keep hidden sources to the right / at the bottom" | MenuCheckBox |
| 6 | `Basic.AudioMixer.KeepInactiveRight` / `KeepInactiveBottom` | MenuCheckBox |
| 7 | separator | |
| 8 | `Basic.AudioMixer.Layout.Vertical` / `Horizontal` | QAction |
| 9 | separator | |
| 10 | `Basic.AdvAudio` → "Advanced Audio Properties" | QAction |

Each mixer channel is a `VolumeControl` containing: `categoryLabel` (QLabel,
objectName not set; text from `Basic.AudioMixer.Category.*`), `muteButton` (QPushButton,
icons unassigned/muted/unmuted, tooltip `Mute`/`Unmute`, accessibleName `VolControl.Mute`),
`monitorButton` (QPushButton, icons headphones/headphones-off, tooltips
`Basic.AudioMixer.Monitoring.Enable`/`.Disable`), `volumeLabel` (QLabel,
objectName="volLabel"), a volume slider, and a meter frame (`meterFrame`,
objectName="volMeterFrame"). Right-click menu on a strip:
`LockVolume` ("Lock Volume"), `Basic.AudioMixer.Pin`/`Unpin`, `Basic.AudioMixer.Hide`/`Unhide`,
`UnhideAll`, `Rename` ("Rename..."), `Copy.Filters`, `Paste.Filters`, `Filters`, `Properties`.

### 2.4 `transitionsDock` — "Scene Transitions"

```
transitionsDock [OBSDock]
└─ dockWidgetContents_5 [QWidget]
   └─ verticalLayout_3 [QVBoxLayout] spacing=0, margins 1/0/1/1
      └─ transitionsFrame [QFrame]
         └─ verticalLayout_8 [QVBoxLayout] spacing=0, margins 0
            ├─ transitions [QComboBox] min 120×0   (items = transition names, populated at runtime;
            │                                        accessibleName="Transition")
            ├─ horizontalLayout_3 [QHBoxLayout] spacing=4
            │  ├─ transitionDurationLabel [QLabel] text=Basic.TransitionDuration → "Duration"
            │  └─ transitionDuration [QSpinBox] suffix="ms", min=50, max=20000, step=50, value=300,
            │        accessibleName=Basic.TransitionDuration
            ├─ horizontalLayout_4 [QHBoxLayout] spacing=4
            │  ├─ horizontalSpacer [spacer] Horizontal, Expanding 40×20
            │  ├─ transitionAdd [QPushButton]  text="", icon=:/res/images/plus.svg,
            │  │     toolTip/accessibleName=Basic.AddTransition ("Add Configurable Transition"),
            │  │     class "btn-tool icon-plus"
            │  ├─ transitionRemove [QPushButton] text="", icon=:/res/images/minus.svg,
            │  │     toolTip/accessibleName=Basic.RemoveTransition, class "btn-tool icon-trash"
            │  └─ transitionProps [QPushButton] text="", icon=:/settings/images/settings/general.svg,
            │        toolTip/accessibleName=Basic.TransitionProperties, class "btn-tool icon-dots-vert"
            └─ verticalSpacer [spacer] Vertical 20×40
```

Runtime behaviour:
* `transitionAdd` (`on_transitionAdd_clicked`) opens a menu listing every configurable
  transition type (display names from `obs_source_get_display_name`).
* `transitionProps` (`on_transitionProps_clicked`) opens a 2-item menu:
  `Rename` → "Rename...", `Properties` → "Properties".
* `transitionDurationLabel` + `transitionDuration` are hidden for non-configurable/fixed
  transitions (`ui->transitionDurationLabel->setVisible(!fixed)`).
* The combo box `transitions` is the app-wide "current transition" selector and is mirrored
  by the Quick Transitions dock/toolbar in Studio Mode.

### 2.5 `controlsDock` — "Controls" (`OBSBasicControls.ui`)

`controlsDock` is created in C++ (`OBSBasicControls *controls = new OBSBasicControls(this)`,
`controlsDock->setWidget(controls)`), objectName `controlsDock`, title
`Basic.Main.Controls` → "Controls", default area Bottom.

```
OBSBasicControls [QWidget]
└─ verticalLayout_9 [QVBoxLayout] spacing=0, margins 1/0/1/1
   └─ controlsFrame [QFrame]
      └─ buttonsVLayout [QVBoxLayout] spacing=0, margins 0
         ├─ horizontalLayout_7 [QHBoxLayout]
         │  ├─ streamButton   [QPushButton] min 150×0, text=Basic.Main.StartStreaming → "Start Streaming"
         │  └─ broadcastButton[QPushButton] min 150×0, text=Basic.Main.StartBroadcast → "Go Live"
         ├─ recordingLayout [QHBoxLayout] spacing=2, margins 0
         │  ├─ recordButton      [QPushButton] text=Basic.Main.StartRecording → "Start Recording"
         │  └─ pauseRecordButton [QPushButton] text="", toolTip/accessibleName=Basic.Main.PauseRecording,
         │        icon=:/res/images/media-pause.svg, class=icon-media-pause
         ├─ replayBufferLayout [QHBoxLayout] spacing=2, margins 0
         │  ├─ replayBufferButton [QPushButton] text=Basic.Main.StartReplayBuffer → "Start Replay Buffer"
         │  └─ saveReplayButton   [QPushButton] text="", toolTip/accessibleName=Basic.Main.SaveReplay,
         │        icon=:/res/images/save.svg, class=icon-save
         ├─ virtualCamLayout [QHBoxLayout] spacing=2, margins 0
         │  ├─ virtualCamButton       [QPushButton] text=Basic.Main.StartVirtualCam → "Start Virtual Camera"
         │  └─ virtualCamConfigButton [QPushButton] text="", toolTip/accessibleName=Basic.Main.VirtualCamConfig,
         │        icon=:/settings/images/settings/general.svg, class=icon-gear
         ├─ modeSwitch     [QPushButton] min 150×0, text=Basic.TogglePreviewProgramMode → "Studio Mode"
         ├─ settingsButton [QPushButton] min 150×0, text=Settings → "Settings"
         └─ expVSpacer [spacer] Vertical 0×0
```

Initial visibility (set in `OBSBasicControls.cpp`): `broadcastButton`, `pauseRecordButton`,
`replayBufferButton`, `saveReplayButton`, `virtualCamButton`, `virtualCamConfigButton`
are **hidden** until their feature is enabled. Button text/state changes at runtime:

| Object | Runtime texts (key → English) |
| --- | --- |
| `streamButton` | `Basic.Main.PreparingStream` "Preparing...", `Basic.Main.Connecting` "Connecting...", `Basic.Main.StopStreaming` "Stop Streaming", `Basic.Main.StoppingStreaming` "Stopping Stream..." |
| stream button menu | `Basic.Main.StartStreaming`, `Basic.Main.StopStreaming`, `Basic.Main.ForceStopStreaming` "Stop Streaming (discard delay)" (shown only when a stream delay is active) |
| `broadcastButton` | `Basic.Main.SetupBroadcast` "Manage Broadcast", `Basic.Main.StopBroadcast` "End Broadcast", `Basic.Main.AutoStopEnabled` "(Auto Stop)" |
| `recordButton` | `Basic.Main.StopRecording` "Stop Recording", `Basic.Main.StoppingRecording` "Stopping Recording..." |
| `pauseRecordButton` | tooltip toggles `Basic.Main.PauseRecording` "Pause Recording" ↔ `Basic.Main.UnpauseRecording` "Unpause Recording" |
| `replayBufferButton` | `Basic.Main.StopReplayBuffer` "Stop Replay Buffer", `Basic.Main.StoppingReplayBuffer` "Stopping Replay Buffer..." |
| `virtualCamButton` | `Basic.Main.StopVirtualCam` "Stop Virtual Camera" |

### 2.6 `statsDock` — "Stats"

Created in C++ (`OBSBasic.cpp:253`), objectName `statsDock`, title `Basic.Stats` →
"Stats", features Closable|Movable|Floatable, default area Bottom but
`setVisible(false)`, `setFloating(true)`, `resize(700, 200)`, moved to window centre.
Its widget is an `OBSBasicStats` (stats grid). It is also reachable as a separate dialog
via **View → Stats** (`ui->stats` → `on_stats_triggered`).

---

## 3. Menu bar tree

Notation: `objectName` — **English label** (lookup key, if any) · shortcut · handler.
Separators are shown as `---`. Auto-connected handler names follow
`OBSBasic::on_<objectName>_triggered()` unless stated otherwise.

### 3.1 `menu_File` — **&File** (key `Basic.MainMenu.File`)

| # | objectName | English | Shortcut | Handler |
| --- | --- | --- | --- | --- |
| 1 | `actionShow_Recordings` | Show &Recordings | — | `on_actionShow_Recordings_triggered` |
| 2 | `actionRemux` | Re&mux Recordings | — | `on_actionRemux_triggered` |
| 3 | — separator — | | | |
| 4 | `action_Settings` | &Settings | — | `on_action_Settings_triggered` |
| 5 | `actionShowSettingsFolder` | Show Settings Folder | — | `on_actionShowSettingsFolder_triggered` |
| 6 | `actionShowProfileFolder` | Show Profile Folder | — | `on_actionShowProfileFolder_triggered` |
| 7 | — separator — | | | |
| 8 | `actionE_xit` | E&xit | **Ctrl+Q** (Linux, set in code); `.ui` connection `triggered() → OBSBasic.close()` | `close()` |

### 3.2 `menuBasic_MainMenu_Edit` — **&Edit** (key `Basic.MainMenu.Edit`)

| # | objectName | English | Shortcut | Handler |
| --- | --- | --- | --- | --- |
| 1 | `actionMainUndo` | Undo | **Ctrl+Z** (code, ApplicationShortcut) | `on_actionMainUndo_triggered` |
| 2 | `actionMainRedo` | Redo | **Ctrl+Shift+Z**, **Ctrl+Y** (code) | `on_actionMainRedo_triggered` |
| 3 | — separator — | | | |
| 4 | `actionCopySource` | Copy | Ctrl+C | `on_actionCopySource_triggered` |
| 5 | `actionPasteRef` | Paste (Reference) | Ctrl+V | `on_actionPasteRef_triggered` |
| 6 | `actionPasteDup` | Paste (Duplicate) | — | `on_actionPasteDup_triggered` |
| 7 | — separator — | | | |
| 8 | `actionCopyFilters` | Copy Filters | — | `on_actionCopyFilters_triggered` |
| 9 | `actionPasteFilters` | Paste Filters | — | `on_actionPasteFilters_triggered` |
| 10 | — separator — | | | |
| 11 | `transformMenu` | &Transform (`Basic.MainMenu.Edit.Transform`) | submenu | |
| 12 | `orderMenu` | &Order (`Basic.MainMenu.Edit.Order`) | submenu | |
| 13 | `scalingMenu` | Preview &Scaling (`Basic.MainMenu.Edit.Scale`) | submenu; `aboutToShow` → `on_scalingMenu_aboutToShow` | |
| 14 | `actionLockPreview` | &Lock Preview (checkable) | — | `on_actionLockPreview_triggered` |
| 15 | — separator — | | | |
| 16 | `actionAdvAudioProperties` | &Advanced Audio Properties | — | `on_actionAdvAudioProperties_triggered` |
| 17 | — separator — | | | |

`transformMenu` — **&Transform**:

| # | objectName | English | Shortcut |
| --- | --- | --- | --- |
| 1 | `actionEditTransform` | &Edit Transform | Ctrl+E |
| 2 | `actionCopyTransform` | Copy Transform | Ctrl+Shift+C |
| 3 | `actionPasteTransform` | Paste Transform | Ctrl+Shift+V |
| 4 | `actionResetTransform` | &Reset Transform | Ctrl+R |
| 5 | — separator — | | |
| 6 | `actionRotate90CW` | Rotate 90 degrees CW | — |
| 7 | `actionRotate90CCW` | Rotate 90 degrees CCW | — |
| 8 | `actionRotate180` | Rotate 180 degrees | — |
| 9 | — separator — | | |
| 10 | `actionFlipHorizontal` | Flip &Horizontal | — |
| 11 | `actionFlipVertical` | Flip &Vertical | — |
| 12 | — separator — | | |
| 13 | `actionFitToScreen` | &Fit to screen | Ctrl+F |
| 14 | `actionStretchToScreen` | &Stretch to screen | Ctrl+S |
| 15 | `actionCenterToScreen` | &Center to screen | Ctrl+D |
| 16 | `actionVerticalCenter` | Center Vertically | — |
| 17 | `actionHorizontalCenter` | Center Horizontally | — |

`orderMenu` — **&Order**:

| # | objectName | English | Shortcut |
| --- | --- | --- | --- |
| 1 | `actionMoveUp` | Move &Up | Ctrl+Up |
| 2 | `actionMoveDown` | Move &Down | Ctrl+Down |
| 3 | — separator — | | |
| 4 | `actionMoveToTop` | Move to &Top | Ctrl+Home |
| 5 | `actionMoveToBottom` | Move to &Bottom | Ctrl+End |

`scalingMenu` — **Preview &Scaling**:

| # | objectName | English | Default | Handler |
| --- | --- | --- | --- | --- |
| 1 | `actionScaleWindow` (checkable) | Scale to Window | — | manual → `setPreviewScalingWindow` |
| 2 | `actionScaleCanvas` (checkable) | Canvas (%1x%2) | — | manual → `setPreviewScalingCanvas` |
| 3 | `actionScaleOutput` (checkable) | Output (%1x%2) | — | manual → `setPreviewScalingOutput` |
| 4 | — separator — | | | |
| 5 | `actionPreviewZoomIn` | Zoom In | disabled | manual → preview `increaseScalingLevel` |
| 6 | `actionPreviewZoomOut` | Zoom Out | disabled | manual → preview `decreaseScalingLevel` |
| 7 | `actionPreviewResetZoom` | Reset Zoom | disabled | manual → preview `resetScalingLevel` |

### 3.3 `viewMenu` — **&View** (key `Basic.MainMenu.View`)

| # | objectName | English | Default | Handler |
| --- | --- | --- | --- | --- |
| 1 | `resetUI` | &Reset UI | — | `on_resetUI_triggered` |
| 2 | `actionFullscreenInterface` | Fullscreen Interface | F11 | `on_actionFullscreenInterface_triggered` |
| 3 | — separator — | | | |
| 4 | `sceneListModeMenu` | Scene List Mode | submenu | |
| 5 | `toggleListboxToolbars` | Dock Toolbars | checkable, checked | `on_toggleListboxToolbars_toggled` |
| 6 | `toggleContextBar` | Source Toolbar | checkable, checked | `on_toggleContextBar_toggled` |
| 7 | `toggleSourceIcons` | Source &Icons | checkable, checked | `on_toggleSourceIcons_toggled` |
| 8 | `toggleStatusBar` | &Status Bar | checkable, checked | `on_toggleStatusBar_toggled` |
| 9 | — separator — | | | |
| 10 | `stats` | Stats | — | `on_stats_triggered` |
| 11 | — separator — | | | |
| 12 | `multiviewProjectorMenu` | Open Multiview | submenu, populated at runtime (`clear()`, monitor list, separator, `Projector.Window` "New window") | `on_multiviewProjectorMenu_aboutToShow`-style fill in `OBSBasic_Projectors.cpp:88` |
| 13 | — separator — | | | |
| 14 | `actionAlwaysOnTop` | &Always On Top | checkable | `on_actionAlwaysOnTop_triggered` |

`sceneListModeMenu` — **Scene List Mode** (QActionGroup, exclusive):

| # | objectName | English | Default |
| --- | --- | --- | --- |
| 1 | `actionSceneListMode` (checkable) | List | checked when `gridMode=false` |
| 2 | `actionSceneGridMode` (checkable) | Grid | checked when `gridMode=true` |

### 3.4 `menuDocks` — **&Docks** (key `Basic.MainMenu.Docks`)

| # | objectName | English | Default | Handler |
| --- | --- | --- | --- | --- |
| 1 | `lockDocks` | &Lock Docks | checkable, checked | `on_lockDocks_toggled` |
| 2 | `sideDocks` | &Full-Height Docks | checkable, checked | `on_sideDocks_toggled` |
| 3 | `resetDocks` | &Reset Docks | — | `on_resetDocks_triggered` |
| 4 | — separator — | | | |
| 5+ | *(runtime)* `Basic.MainMenu.Docks.CustomBrowserDocks` → **&Custom Browser Docks** + separator (only when browser/CEF is available, inserted before the first dock toggle) | | | `ManageExtraBrowserDocks` |
| | *(runtime)* one `toggleViewAction()` per dock, in creation order: scenes, sources, mixer, transitions, controls, stats, then any extra/custom docks | | | |

### 3.5 `profileMenu` — **&Profile** (key `Basic.MainMenu.Profile`)

| # | objectName | English | Handler |
| --- | --- | --- | --- |
| 1 | `actionNewProfile` | New... | `on_actionNewProfile_triggered` |
| 2 | `actionDupProfile` | Duplicate... | `on_actionDupProfile_triggered` |
| 3 | `actionRenameProfile` | Rename... | `on_actionRenameProfile_triggered` |
| 4 | `actionRemoveProfile` | Remove | `on_actionRemoveProfile_triggered` |
| 5 | `actionImportProfile` | Import... | `on_actionImportProfile_triggered` |
| 6 | `actionExportProfile` | Export... | `on_actionExportProfile_triggered` |
| 7 | — separator — | | |
| 8+ | *(runtime)* one checkable `QAction` per profile, label = profile name, current one checked; appended by `RefreshProfiles()` | `ChangeProfile` |

`actionRemoveProfile` is enabled only when >1 profile exists.

### 3.6 `sceneCollectionMenu` — **&Scene Collection** (key `Basic.MainMenu.SceneCollection`)

| # | objectName | English | Handler |
| --- | --- | --- | --- |
| 1 | `actionNewSceneCollection` | New... | `on_actionNewSceneCollection_triggered` |
| 2 | `actionDupSceneCollection` | Duplicate... | `on_actionDupSceneCollection_triggered` |
| 3 | `actionRenameSceneCollection` | Rename... | `on_actionRenameSceneCollection_triggered` |
| 4 | `actionRemoveSceneCollection` | Remove | `on_actionRemoveSceneCollection_triggered` |
| 5 | `actionImportSceneCollection` | Import... | `on_actionImportSceneCollection_triggered` |
| 6 | `actionExportSceneCollection` | Export... | `on_actionExportSceneCollection_triggered` |
| 7 | — separator — | | |
| 8 | `actionShowMissingFiles` | Check for Missing Files | `on_actionShowMissingFiles_triggered` |
| 9 | `actionRemigrateSceneCollection` | Set Base Resolution **or** Reset Base Resolution (see below) | `on_actionRemigrateSceneCollection_triggered` |
| 10 | — separator — | | |
| 11+ | *(runtime)* one checkable `QAction` per scene collection, label = collection name, current one checked; appended by `RefreshSceneCollections()` | `ChangeSceneCollection` |

`actionRemigrateSceneCollection` text is swapped at runtime by
`updateRemigrationMenuItem()`: absolute-coordinate mode → `Basic.MainMenu.SceneCollection.Migrate`
("Set Base Resolution", enabled); otherwise
`Basic.MainMenu.SceneCollection.Remigrate` ("Reset Base Resolution", disabled).
`actionRemoveSceneCollection` is enabled only when >1 collection exists.

### 3.7 `menuTools` — **&Tools** (key `Basic.MainMenu.Tools`)

| # | objectName | English | Handler |
| --- | --- | --- | --- |
| 1 | `autoConfigure` | Auto-Configuration Wizard | `on_autoConfigure_triggered` |
| 2 | `idianPlayground` | Idian Playground (hidden unless `ENABLE_IDIAN_PLAYGROUND`) | `on_idianPlayground_triggered` |
| 3 | `actionOpenPluginManager` | Plugin Manager | `on_actionOpenPluginManager_triggered` |
| 4 | — separator — | | |

(A second, unused action `autoConfigure2` exists in the `.ui` with the same text.)

### 3.8 `menuBasic_MainMenu_Help` — **&Help** (key `Basic.MainMenu.Help`)

| # | objectName | English | Handler |
| --- | --- | --- | --- |
| 1 | `actionHelpPortal` | Help &Portal | `on_actionHelpPortal_triggered` |
| 2 | `actionWebsite` | Visit &Website | `on_actionWebsite_triggered` |
| 3 | `actionDiscord` | Join &Discord Server | `on_actionDiscord_triggered` |
| 4 | — separator — | | |
| 5 | `menuLogFiles` | &Log Files (`Basic.MainMenu.Help.Logs`) — submenu | |
| 6 | `menuCrashLogs` | Crash &Reports (`Basic.MainMenu.Help.CrashLogs`) — submenu | |
| 7 | — separator — | | |
| 8 | `actionRepair` | Check File Integrity | `on_actionRepair_triggered` |
| 9 | `actionCheckForUpdates` | Check For Updates | `on_actionCheckForUpdates_triggered` |
| 10 | `actionRestartSafe` | Restart in Safe Mode / Restart in Normal Mode | `on_actionRestartSafe_triggered` |
| 11 | `actionShowMacPermissions` | Review App Permissions... (macOS only) | `on_actionShowMacPermissions_triggered` |
| 12 | — separator — | | |
| 13 | `actionShowWhatsNew` | What's New | `on_actionShowWhatsNew_triggered` |
| 14 | `actionReleaseNotes` | Release Notes (`.ui` visible=false; set visible in ctor) | `on_actionReleaseNotes_triggered` |
| 15 | `actionShowAbout` | &About | `on_actionShowAbout_triggered` |
| 16 | — separator — | | |

`menuLogFiles` — **&Log Files**:

| # | objectName | English | Handler |
| --- | --- | --- | --- |
| 1 | `actionShowLogs` | &Show Log Files | `on_actionShowLogs_triggered` |
| 2 | `actionUploadCurrentLog` | Upload &Current Log File | `on_actionUploadCurrentLog_triggered` |
| 3 | `actionUploadLastLog` | Upload &Previous Log File | `on_actionUploadLastLog_triggered` |
| 4 | `actionViewCurrentLog` | &View Current Log | `on_actionViewCurrentLog_triggered` |

`menuCrashLogs` — **Crash &Reports**:

| # | objectName | English | Handler |
| --- | --- | --- | --- |
| 1 | `actionShowCrashLogs` | &Show Crash Reports | `on_actionShowCrashLogs_triggered` |
| 2 | `actionUploadLastCrashLog` | Upload &Previous Crash Report | `on_actionUploadLastCrashLog_triggered` |

**Platform-conditional menu items** (deleted at runtime in `OBSBasic.cpp:1199-1222`):

| Platform | Deleted from the UI |
| --- | --- |
| Linux / other non-Windows, non-macOS | `actionRepair`, `actionCheckForUpdates`, `menuCrashLogs` (+ `actionShowCrashLogs`, `actionUploadLastCrashLog`), `actionShowMacPermissions` |
| Windows | `actionShowMacPermissions` (`actionRepair`/`actionCheckForUpdates` remain; both are disabled when the updater is disabled) |
| macOS | `actionRepair`, `actionFullscreenInterface` (replaced by the native macOS fullscreen item) |

`actionShowMacPermissions` ("Review App Permissions...") therefore appears **only on macOS**.

### 3.9 Shortcut master list (desktop, non-macOS unless noted)

| Shortcut | Action | Source |
| --- | --- | --- |
| Ctrl+Q | Exit | code (Linux) |
| Ctrl+Z | Undo | code |
| Ctrl+Shift+Z, Ctrl+Y | Redo | code |
| Ctrl+C | Copy source | `.ui` |
| Ctrl+V | Paste (Reference) | `.ui` |
| Ctrl+E | Edit Transform | `.ui` |
| Ctrl+Shift+C / Ctrl+Shift+V | Copy / Paste Transform | `.ui` |
| Ctrl+R | Reset Transform | `.ui` |
| Ctrl+F / Ctrl+S / Ctrl+D | Fit / Stretch / Center to screen | `.ui` |
| Ctrl+Up / Ctrl+Down | Move Up / Down | `.ui` |
| Ctrl+Home / Ctrl+End | Move to Top / Bottom | `.ui` |
| F11 | Fullscreen Interface | `.ui` |
| Del (macOS: + Backspace) | Remove scene/source | `.ui` + code |
| F2 (macOS: Return) | Rename scene/source | code |
| Space / R / Left / Right | Media play-pause / restart / seek (source toolbar, widget-scoped) | `MediaControls.cpp` |
| P / S / N | Media previous / stop / next (`.ui`, `WidgetWithChildrenShortcut`) | `.ui` |

### 3.10 Context menus (built in code, not part of the menu bar)

| Target | Items (in order) |
| --- | --- |
| Preview (`on_preview_customContextMenuRequested`) | `Basic.Main.PreviewConextMenu.Enable` "Enable Preview" (when disabled); `Projector.Window` "New window" submenu of projectors/monitors; `ui->actionLockPreview` "&Lock Preview"; "Screenshot..." submenu: `Screenshot.Preview`, `Screenshot.Source`, `Screenshot.Scene`, `Screenshot.StudioProgram`; `ResizeOutputSizeOfSource`; group/ungroup; copy/paste source & filters; remove; rename; interact; filters; properties |
| Sources list (`sources` tree) | `AddSource` "Add Source", `Basic.Main.GroupItems` "Group Selected Items", `Basic.Main.Ungroup` "Ungroup", copy/paste, `ResizeOutputSizeOfSource`, `HideMixer` "Hide in Mixer", remove, rename, `Interact`, `Filters`, `Properties`, projector submenu, screenshots, `ShowInMultiview` |
| Scenes list (`scenes` tree) | `AddScene` "Add Scene", `Duplicate` "Duplicate...", copy/paste filters, `Rename`, `Remove`, Order submenu (`Basic.MainMenu.Edit.Order.*`), projector submenu, `Screenshot.Scene`, `Filters`, `ShowInMultiview`, Grid/List toggle |
| Mixer dock | see §2.3 (AudioMixer Options menu) |
| Mixer strip (`VolumeControl`) | Lock Volume, Pin/Unpin, Hide/Unhide, Unhide All, Rename..., Copy Filters, Paste Filters, Filters, Properties |

---

## 4. Source Toolbar (the per-source button row)

There are two distinct "toolbars" in OBS. §4.1–§4.9 document the **Source Toolbar**
(also called the *context bar*), the row between the preview and the docks that shows
controls for the **currently selected source**. §4.10 documents the dock **list toolbars**.

### 4.1 Static segment — `contextContainer` (in `OBSBasic.ui`)

Visible when **View → Source Toolbar** is checked. Items 1–8 live inside
`contextSubContainer`/`horizontalLayout_5`; item 9 (`emptySpace`) is its **sibling**
inside `horizontalLayout9`. Left-to-right:

| Order | objectName | Class | Content | Notes |
| --- | --- | --- | --- | --- |
| 1 | `contextSourceIcon` | QLabel 22×22 | source-type icon pixmap 16×16 | hidden when no source |
| 2 | `contextSourceLabel` | QLabel 160×22 | selected source name | "TextLabel" placeholder; `ContextBar.NoSelectedSource` "No source selected" when none |
| 3 | `contextSourceIconSpacer` | QLabel 22×22 | spacer that keeps layout stable | shown when no source, hidden otherwise |
| 4 | `line_3` | Line (vertical) | separator | |
| 5 | `sourcePropertiesButton` | QPushButton | tooltip `SourceProperties` "Open Source Properties"; text "Properties" (blank in Reduced/Minimized sizes) | disabled when source not configurable |
| 6 | `sourceFiltersButton` | QPushButton | tooltip `SourceFilters` "Open Source Filters"; text "Filters" | disabled when no source |
| 7 | `sourceInteractButton` | QPushButton | tooltip `Interact`; text "Interact"; icon `:/res/images/interact.svg` | only visible when source has `OBS_SOURCE_INTERACTION` |
| 8 | `line` | Line (vertical) | separator | |
| 9 | `emptySpace` | QFrame | host for the per-source-type toolbar (below) | exactly one child at a time |

Responsive sizing (`UpdateContextBarVisibility`): width ≥ 740 → **Normal** (icons + text);
600–739 → **Reduced** (icons only, per-source toolbar still shown); < 600 → **Minimized**
(icons only, per-source toolbar removed).

### 4.2 Per-source toolbar selection (`createContextBarWidget`)

| Source id(s) | Toolbar widget | `.ui` |
| --- | --- | --- |
| any with `OBS_SOURCE_CONTROLLABLE_MEDIA`, except network `ffmpeg_source` | `MediaControls` | `media-controls.ui` |
| `browser_source` | `BrowserToolbar` | `browser-source-toolbar.ui` |
| `wasapi_input_capture`, `wasapi_output_capture`, `coreaudio_input_capture`, `coreaudio_output_capture`, `pulse_input_capture`, `pulse_output_capture`, `alsa_input_capture` | `AudioCaptureToolbar` | `device-select-toolbar.ui` |
| `wasapi_process_output_capture` | `ApplicationAudioCaptureToolbar` | `device-select-toolbar.ui` |
| `window_capture`, `xcomposite_input` | `WindowCaptureToolbar` | `device-select-toolbar.ui` |
| `monitor_capture`, `display_capture`, `xshm_input` | `DisplayCaptureToolbar` | `device-select-toolbar.ui` |
| `dshow_input` | `DeviceCaptureToolbar` | `device-select-toolbar.ui` |
| `game_capture` | `GameCaptureToolbar` | `game-capture-toolbar.ui` |
| `image_source` | `ImageSourceToolbar` | `image-source-toolbar.ui` |
| `color_source` | `ColorSourceToolbar` | `color-source-toolbar.ui` |
| `text_ft2_source`, `text_gdiplus` | `TextSourceToolbar` | `text-source-toolbar.ui` |
| anything else | none | |

### 4.3 `BrowserSourceToolbar` (`browser-source-toolbar.ui`)

| Order | objectName | Class | Properties |
| --- | --- | --- | --- |
| 1 | `refresh` | QPushButton | min 0×22, icon `:/res/images/refresh.svg`, text `RefreshBrowser` → "Refresh", flat=true, class "icon-refresh" |
| 2 | `line` | Line | vertical separator |
| 3 | `horizontalSpacer` | spacer | Horizontal 40×20 |

Root `QWidget` min 0×22, windowTitle "Form"; `horizontalLayout` margins 0.

### 4.4 `ColorSourceToolbar` (`color-source-toolbar.ui`)

| Order | objectName | Class | Properties |
| --- | --- | --- | --- |
| 1 | `color` | QLabel | min 80×22, text "color here" (runtime = hex colour), AlignCenter |
| 2 | `choose` | QPushButton | min 0×22, text `Basic.PropertiesWindow.SelectColor` → "Select color" |
| 3 | `horizontalSpacer` | spacer | Horizontal 40×20 |

### 4.5 `DeviceSelectToolbar` (`device-select-toolbar.ui`) — shared by 5 toolbars

| Order | objectName | Class | Properties |
| --- | --- | --- | --- |
| 1 | `deviceLabel` | QLabel | min 0×22, text "Device" (runtime: per-source label from the module) |
| 2 | `device` | QComboBox | min 0×22, max 600×∞ |
| 3 | `activateButton` | QPushButton | min 0×22, text "Activate" (`notr="true"`, runtime toggles to the deactivate string) |
| 4 | `horizontalSpacer` | spacer | Horizontal, Expanding 0×20 |

Derived toolbars reuse these names and override `deviceLabel` text in C++:
`AudioCaptureToolbar`, `ApplicationAudioCaptureToolbar`, `DisplayCaptureToolbar`,
`WindowCaptureToolbar`, `DeviceCaptureToolbar` (and `ComboSelectToolbar`).

### 4.6 `GameCaptureToolbar` (`game-capture-toolbar.ui`)

| Order | objectName | Class | Properties |
| --- | --- | --- | --- |
| 1 | `modeLabel` | QLabel | min 0×22, text "Mode" (runtime from module locale "Mode") |
| 2 | `mode` | QComboBox | min 120×22, max 400×∞ |
| 3 | `windowLabel` | QLabel | min 0×22, text "Window" (runtime "WindowCapture.Window") |
| 4 | `window` | QComboBox | min 120×22, max 600×∞ |
| 5 | `empty` | spacer | Horizontal 0×20 |

`windowLabel`/`window` are hidden unless the selected mode is a window mode.

### 4.7 `ImageSourceToolbar` (`image-source-toolbar.ui`)

| Order | objectName | Class | Properties |
| --- | --- | --- | --- |
| 1 | `pathLabel` | QLabel | min 0×22, text "Image File" (runtime module "File") |
| 2 | `path` | QLineEdit | min 100×22, max 400×∞, readOnly=true |
| 3 | `browse` | QPushButton | min 0×22, text `Browse` → "Browse" |
| 4 | `horizontalSpacer` | spacer | Horizontal 0×20 |

### 4.8 `TextSourceToolbar` (`text-source-toolbar.ui`)

| Order | objectName | Class | Properties |
| --- | --- | --- | --- |
| 1 | `selectFont` | QPushButton | min 0×22, text `Basic.PropertiesWindow.SelectFont` → "Select font" |
| 2 | `selectColor` | QPushButton | min 0×22, text `Basic.PropertiesWindow.SelectColor` → "Select color" |
| 3 | `emptySpace` | QFrame | shown when the source is multi-line |
| 4 | `text` | QLineEdit | min 0×22, shown when single-line |

### 4.9 `MediaControls` (`media-controls.ui`)

| Order | objectName | Class | Properties |
| --- | --- | --- | --- |
| 1 | `playPauseButton` | QPushButton | 22×22, icon `:/res/images/media/media_restart.svg` 20×20, flat=true, class "icon-media-play"; tooltip switches between `ContextBar.MediaControls.RestartMedia` / `.PlayMedia` / `.PauseMedia`; shortcuts Space / R |
| 2 | `previousButton` | QPushButton | 22×22, icon `.../media_previous.svg`, flat, class "icon-media-prev", tooltip `ContextBar.MediaControls.PlaylistPrevious`, shortcut P |
| 3 | `stopButton` | QPushButton | 22×22, icon `.../media_stop.svg`, flat, class "icon-media-stop", tooltip `ContextBar.MediaControls.StopMedia`, shortcut S |
| 4 | `nextButton` | QPushButton | 22×22, icon `.../media_next.svg`, flat, class "icon-media-next", tooltip `ContextBar.MediaControls.PlaylistNext`, shortcut N |
| 5 | `slider` | AbsoluteSlider | min 0×22, Horizontal, max=1024; accessibleName `ContextBar.MediaControls.BlindSeek` "Media Seek Widget"; hidden for slideshows |
| 6 | `timerLabel` | QLabel | min 0×22, text `--:--:--` |
| 7 | `label` | QLabel | min 0×22, text "/" |
| 8 | `durationLabel` | ClickableLabel | min 0×22, text `--:--:--` |
| 9 | `emptySpaceAgain` | QFrame | shown for image slideshows |

`previousButton`/`nextButton` are hidden when the media has no playlist; `slider` is
hidden for slideshows (the timer then shows slide index / total).

### 4.10 Dock list toolbars

* **Scenes toolbar** (`scenesToolbar`, §2.1): Add, Remove, |, Scene Filters, |, Move Up, Move Down.
* **Sources toolbar** (`sourcesToolbar`, §2.2): Add, Remove, |, Properties, |, Move Up, Move Down.
* Both are `QToolBar` with `iconSize=16×16`; their actions carry the styling classes
  `icon-plus`, `icon-trash`, `icon-gear`, `icon-filter`, `icon-up`, `icon-down`
  which are copied onto the toolbar buttons by `copyActionsDynamicProperties()`.
* Both toolbars are hidden at once by **View → Dock Toolbars**.

### 4.11 Mixer toolbar

See §2.3 — order is: hidden-count toggle, separator, expanding spacer, separator, layout
toggle, separator, advanced-audio, separator, Options button.

---

## 5. Status bar

`OBSBasicStatusBar` (QStatusBar subclass) adds a single permanent widget
`StatusBarWidget, stretch=1`; `setMinimumHeight(statusWidget->height())`.
`StatusBarWidget.ui`: root `min 0×34`, windowTitle "Form", `horizontalLayout`
spacing=0, margins L0 T0 R6 B0. Order left → right:

| # | Frame | objectName | Class | Default text | Shows |
| --- | --- | --- | --- | --- | --- |
| 1 | `messageFrame` (styleSheet `border: none;`, NoFrame) | `message` | QLabel | `Message` | transient status/error messages (`showMessage`, auto-cleared by `messageTimer`), e.g. `HighResourceUsage`, `Basic.StatusBar.Reconnecting`, `Basic.StatusBar.ReconnectSuccessful` |
| 2 | `delayFrame` (hidden initially) | `delayInfo` | QLabel | `DelayInfo` | stream-delay countdown: `Basic.StatusBar.Delay` "Delay (%1 sec)", `.DelayStartingIn`, `.DelayStoppingIn`, `.DelayStartingStoppingIn` |
| 3 | `issuesFrame` (hidden initially) | `droppedFrames` | QLabel | `DroppedFrames` → "Dropped Frames %1 (%2%)" | dropped output frames and percentage |
| 4 | `networkFrame` (spacing=6) | `statusIcon` | QLabel | (no text) | 16×16 network congestion icon: `network-inactive.svg`, `network-excellent.svg`, `network-good.svg`, `network-mediocre.svg`, `network-bad.svg`, `network-disconnected.svg` |
| | | `kbps` | QLabel | `0 kbps`, AlignRight | current upstream bitrate, updated every 2 s; hidden unless streaming |
| 5 | `streamFrame` | `streamIcon` | QLabel | (no text) | `streaming-active.svg` / `streaming-inactive.svg` |
| | | `streamTime` | QLabel | `00:00:00`, disabled when not streaming | elapsed stream time HH:MM:SS |
| 6 | `recordFrame` | `recordIcon` | QLabel | (no text) | `recording-active.svg` / `recording-inactive.svg` / `recording-pause.svg` / `recording-pause-inactive.svg` (blinks while paused) |
| | | `recordTime` | QLabel | `00:00:00`, disabled when not recording | elapsed recording time HH:MM:SS, appended `" (PAUSED)"` when paused |
| 7 | `cpuFrame` | `cpuUsage` | QLabel | `CPU: 0.0%`, AlignCenter | `CPU: %.1f%%`, updated every 3 s |
| 8 | `fpsFrame` | `fpsCurrent` | QLabel | `0.00 / 0.00 FPS`, AlignCenter | `"%.2f / %.2f FPS"` (active / target) |

Icon paths resolve to `theme:Dark/...` in the dark theme, otherwise `:/res/images/...`
(`UpdateIcons`). `delayFrame` and `issuesFrame` are hidden until streaming starts;
`kbps` is hidden until streaming starts. The whole status bar is hidden by
**View → Status Bar** (`toggleStatusBar`).

---

## 6. Dialogs

### 6.1 Filters dialog — `OBSBasicFilters.ui`

Window: `OBSBasicFilters [QDialog]`, title `Basic.Filters` → "Filters",
`sizeGripEnabled=true`.

```
OBSBasicFilters [QDialog]
└─ verticalLayout [QVBoxLayout]
   └─ horizontalLayout [QHBoxLayout] stretch=1,10
      ├─ verticalLayout_2 [QVBoxLayout]                     (left column, width ~255)
      │  ├─ asyncWidget [QFrame] min 255×0
      │  │  └─ verticalLayout_3 [QVBoxLayout] margins 0
      │  │     ├─ asyncLabel [QLabel] text=Basic.Filters.AsyncFilters → "Audio/Video Filters"
      │  │     ├─ asyncFilters [FocusList] (QListWidget) contextMenuPolicy=CustomContextMenu, spacing=1
      │  │     └─ widget [QFrame]
      │  │        └─ horizontalLayout_4 [QHBoxLayout] spacing=4, margins 0
      │  │           ├─ addAsyncFilter      [QPushButton] 22×22 flat, icon plus.svg,  accessibleName=Add
      │  │           ├─ removeAsyncFilter   [QPushButton] 22×22 flat, icon minus.svg, accessibleName=Remove, class "btn-tool icon-trash"
      │  │           ├─ moveAsyncFilterUp   [QPushButton] 22×22 flat, icon up.svg,    accessibleName=MoveUp, class "btn-tool icon-up"
      │  │           ├─ moveAsyncFilterDown [QPushButton] 22×22 flat, icon down.svg,  accessibleName=MoveDown, class "btn-tool icon-down"
      │  │           └─ asyncToolbarSpacer [spacer] Expanding 20×0
      │  ├─ separatorLine [Line] Horizontal
      │  └─ effectWidget [QFrame] min 255×0
      │     └─ verticalLayout_4 [QVBoxLayout] margins 0
      │        ├─ label_2 [QLabel] text=Basic.Filters.EffectFilters → "Effect Filters"
      │        ├─ effectFilters [FocusList] (QListWidget) contextMenuPolicy=CustomContextMenu, spacing=1
      │        └─ widget_2 [QFrame]
      │           └─ horizontalLayout_6 [QHBoxLayout] spacing=4, margins 0
      │              ├─ addEffectFilter      [QPushButton] 22×22 flat, plus.svg,  accessibleName=Add, class "btn-tool icon-plus"
      │              ├─ removeEffectFilter   [QPushButton] 22×22 flat, minus.svg, accessibleName=Remove, class "btn-tool icon-trash"
      │              ├─ moveEffectFilterUp   [QPushButton] 22×22 flat, up.svg,    accessibleName=MoveUp, class "btn-tool icon-up"
      │              ├─ moveEffectFilterDown [QPushButton] 22×22 flat, down.svg,  accessibleName=MoveDown, class "btn-tool icon-down"
      │              └─ effectToolbarSpacer  [spacer] Expanding 20×0
      └─ rightContainerLayout [QFrame] min 200×0, NoFrame
         └─ verticalLayout_6 [QVBoxLayout] margins 0
            ├─ rightLayout [QSplitter] Vertical, min 0×400
            │  ├─ previewFrame [QFrame] NoFrame
            │  │  └─ verticalLayout_7 [QVBoxLayout] spacing=0, margins 0
            │  │     └─ preview [OBSQTDisplay] min 0×150
            │  └─ propertiesFrame [QFrame] NoFrame
            │     └─ propertiesLayout [QVBoxLayout] margins 0   ← filter properties inserted here
            └─ horizontalLayout_2 [QHBoxLayout] spacing=4
               └─ buttonBox [QDialogButtonBox] standardButtons=Close|RestoreDefaults
```

Dialog-local actions (used from the list context menus):

| objectName | English | Icon | Shortcut |
| --- | --- | --- | --- |
| `actionRemoveFilter` | Remove | minus.svg | Del |
| `actionMoveUp` | Move &Up | up.svg | Ctrl+Up |
| `actionMoveDown` | Move &Down | down.svg | Ctrl+Down |
| `actionRenameFilter` | Rename... | — | Return (macOS) / F2 (code) |

### 6.2 Properties dialog — `OBSBasicProperties.ui`

Window: `OBSBasicProperties [QDialog]`, title `Properties` → "Properties"
(literal, resolves to the same), `sizeGripEnabled=true`.

```
OBSBasicProperties [QDialog]
└─ verticalLayout [QVBoxLayout]
   ├─ windowSplitter [QSplitter] Vertical, min 0×400
   │  ├─ previewFrame [QFrame] NoFrame
   │  │  └─ verticalLayout_7 [QVBoxLayout] spacing=0, margins 0
   │  │     └─ preview [OBSQTDisplay] min 20×150
   │  └─ propertiesFrame [QFrame] NoFrame
   │     └─ propertiesLayout [QVBoxLayout] margins 0   ← source properties inserted here
   └─ frame [QFrame] NoFrame
      └─ horizontalLayout [QHBoxLayout] spacing=6, margins 0
         ├─ defaultsButton   [QPushButton] text=`RestoreDefaults` → "Defaults", autoDefault=false
         ├─ transitionButton [QPushButton] text=`PreviewTransition` → "Preview Transition"
         └─ buttonBox        [QDialogButtonBox] standardButtons=Cancel|Ok
```

### 6.3 Scene Item Transform dialog — `OBSBasicTransform.ui`

Window: `OBSBasicTransform [QDialog]`, title `Basic.TransformWindow` →
"Scene Item Transform". Connection in `.ui`: `buttonBox.rejected() → reject()`.

```
OBSBasicTransform [QDialog]
└─ verticalLayout [QVBoxLayout] stretch=0, margins 0
   └─ outerFrame [QFrame] NoFrame, class="dialog-container"
      └─ verticalLayout_3 [QVBoxLayout] spacing=0, margins 0
         ├─ transformSettings [QFrame] class="dialog-container dialog-frame"
         │  └─ gridLayout_2 [QGridLayout] margins 0
         │     row 0: label [QLabel] "Position" (Basic.TransformWindow.Position, class=subtitle)
         │            label_3 [QLabel] "Size" (…Size, class=subtitle)
         │            label_2 [QLabel] "Rotation" (…Rotation, class=subtitle)
         │            label_4 [QLabel] "Alignment" (…Alignment, class=subtitle)
         │     r1c0 positionXLabel [QLabel] text "X"  (accessibleName …Accessible.PositionX)
         │     r1c1 positionX [OBS::DoubleSpinBox] 120 wide, suffix "px", decimals=2 (accessibleName …PositionX)
         │     r2c0 positionYLabel [QLabel] text "Y"  (accessibleName …Accessible.PositionY)
         │     r2c1 positionY [OBS::DoubleSpinBox] 120 wide, suffix "px", decimals=2
         │     r1c2 sizeWidthLabel [QLabel] text=Basic.TransformWindow.Width  → "Width"
         │     r1c3 sizeX [OBS::DoubleSpinBox] 120 wide, suffix "px", decimals=2
         │     r2c2 sizeHeightLabel [QLabel] text=Basic.TransformWindow.Height → "Height"
         │     r2c3 sizeY [OBS::DoubleSpinBox] 120 wide, suffix "px", decimals=2
         │     r1c4 rotation [OBS::DoubleSpinBox] 120 wide, suffix "°" (no decimals)
         │     r1c5 alignmentWidget [QFrame] (filled in C++ with an AlignmentSelector)
         │        └─ alignmentLayout [QVBoxLayout] spacing=0, margins 0
         │     r1c6 horizontalSpacer_3 [spacer] Horizontal 0×10
         ├─ boundsSettings [QFrame] class="dialog-container dialog-frame"
         │  └─ gridLayout_3 [QGridLayout] margins 0
         │     r0c0 label_7 [QLabel] "Bounds" (…Bounds, class=subtitle, colspan 3)
         │     r0c3 label_6 [QLabel] "Alignment" (…Alignment, class=subtitle)
         │     r1c0 boundsType [QComboBox] colspan 3, items (in order):
         │         Basic.TransformWindow.BoundsType.None       → "Automatic"
         │         Basic.TransformWindow.BoundsType.Stretch    → "Stretch"
         │         Basic.TransformWindow.BoundsType.ScaleInner → "Fit"
         │         Basic.TransformWindow.BoundsType.ScaleOuter → "Cover"
         │         Basic.TransformWindow.BoundsType.ScaleToWidth  → "Fill Width"
         │         Basic.TransformWindow.BoundsType.ScaleToHeight → "Fill Height"
         │         Basic.TransformWindow.BoundsType.MaxOnly   → "Maximum size only"
         │     r1c3 alignmentWidget2 [QFrame] (AlignmentSelector, disabled by default)
         │        └─ boundsAlignmentLayout [QVBoxLayout] margins 0
         │     r2c0 boundsWidthLabel  [QLabel] "Width"  (accessibleName …BoundsWidth)
         │     r2c1 boundsWidth  [OBS::DoubleSpinBox] enabled=false, suffix "px", decimals=2
         │     r3c0 boundsHeightLabel [QLabel] "Height" (accessibleName …BoundsHeight)
         │     r3c1 boundsHeight [OBS::DoubleSpinBox] enabled=false, suffix "px", decimals=2
         │     r2c2 cropToBounds [QCheckBox] enabled=false, max 100 wide,
         │          text=Basic.TransformWindow.CropToBounds → "Crop Bounds"
         │     r0c7 horizontalSpacer_4 [spacer] Horizontal 0×10, rowspan 4
         ├─ cropSettings [QFrame] class="dialog-container dialog-frame"
         │  └─ gridLayout [QGridLayout] margins 0
         │     r0c0 label_8 [QLabel] text=Basic.TransformWindow.Crop → "Crop" (class=subtitle)
         │     r1c0 cropLeftLabel [QLabel] "Left"     r1c1 cropLeft   [OBS::SpinBox] 120 wide, suffix "px", max 100000
         │     r1c2 cropRightLabel [QLabel] "Right"   r1c3 cropRight  [OBS::SpinBox] 120 wide, suffix "px", max 100000
         │     r2c0 cropTopLabel [QLabel] "Top"       r2c1 cropTop    [OBS::SpinBox] 120 wide, suffix "px", max 100000
         │     r2c2 cropBottomLabel [QLabel] "Bottom" r2c3 cropBottom [OBS::SpinBox] 120 wide, suffix "px", max 100000
         │     r1c4 horizontalSpacer_2 [spacer] Horizontal 40×20
         └─ buttonBox [QDialogButtonBox] standardButtons=Close|Reset
            (Close is the default button; Reset triggers OBSBasic::on_actionResetTransform_triggered)
```

The two `AlignmentSelector` widgets are custom-painted 3×3 alignment grids (9 cells,
top-left default), with accessible names `Basic.TransformWindow.Alignment` and
`Basic.TransformWindow.BoundsAlignment`.

### 6.4 Add Source dialog — `OBSBasicSourceSelect.ui`

Window: `OBSBasicSourceSelect [QDialog]`, title `Basic.SourceSelect` → "Add Source",
`windowModality=NonModal`, `maximumSize=16777215×1000`.

```
OBSBasicSourceSelect [QDialog] class="" 
└─ verticalLayout_7 [QVBoxLayout] spacing=0, margins 0
   └─ dialogInner [QFrame] NoFrame, class="dialog-container"
      └─ horizontalLayout [QHBoxLayout] spacing=0, margins 0, stretch=1,4
         ├─ selectTypeFrame [QFrame] NoFrame, class="dialog-frame",
         │     accessibleName=Basic.SourceSelect.SelectType → "Source Type"
         │  └─ verticalLayout [QVBoxLayout] spacing=0, margins 0
         │     ├─ sourceTypeList [QListWidget] min 0×460, NoFrame,
         │     │     vScrollBar AlwaysOn, hScrollBar AlwaysOff,
         │     │     accessibleName=Basic.SourceSelect.SelectType, class=""
         │     └─ verticalSpacer_2 [spacer] Vertical, Minimum 17×4
         └─ sourcesFrame [QFrame] NoFrame, class=""
            └─ verticalLayout_8 [QVBoxLayout] spacing=0, margins 0, stretch=0,0
               ├─ selectSourceContainer [QFrame] NoFrame, class="dialog-container"
               │  └─ verticalLayout_2 [QVBoxLayout] spacing=0, margins 0
               │     ├─ sourceSelectTitle [QLabel] text=Basic.SourceSelect.Recent → "Recently Created"
               │     │     class="text-title"
               │     ├─ sourceSelectDescription [QLabel] text=Basic.SourceSelect.Description
               │     │     → "Select which source(s) to add to your current scene."
               │     │     class="text-small text-muted margin-y"
               │     ├─ deprecatedFrame [QFrame] NoFrame, class="frame-notice"
               │     │  └─ verticalLayout_3 [QVBoxLayout] spacing=0, margins 0
               │     │     └─ deprecatedCreateLabel [QLabel] NoFrame, AlignCenter,
               │     │           text=Basic.SourceSelect.Deprecated.Create
               │     │           → "This source type is marked as deprecated and may be removed in the future."
               │     ├─ selectSourceFrame [QFrame] class="dialog-container dialog-frame",
               │     │     accessibleName=Basic.SourceSelect.AddExisting → "Add %1 existing"
               │     │  └─ verticalLayout_6 [QVBoxLayout] spacing=0, margins 0
               │     │     ├─ createNewSource [QPushButton] text=Basic.SourceSelect.NewSource
               │     │     │     → "Add a new %1", class="btn-create-new"
               │     │     ├─ noExistingLabel [QLabel] AlignCenter, text=Basic.SourceSelect.NoExisting
               │     │     │     → "You have no existing %1 sources yet.", class="text-muted"
               │     │     ├─ existingScrollArea [QScrollArea] NoFocus, NoFrame,
               │     │     │     vScrollBar AlwaysOn, hScrollBar AlwaysOff
               │     │     │  └─ existingScrollContents [QWidget] autoFillBackground=true
               │     │     │     └─ verticalLayout_4 [QVBoxLayout] spacing=0, margins 0
               │     │     │        ├─ existingListFrame [FlowFrame] NoFrame
               │     │     │        └─ verticalSpacer [spacer] Vertical 20×10
               │     │     └─ addExistingContainer [QWidget] min 0×0
               │     │        └─ horizontalLayout_4 [QHBoxLayout] margins 0
               │     │           ├─ addExistingButton [QPushButton] enabled=false,
               │     │           │     text=Basic.SourceSelect.NoSelection → "Add existing",
               │     │           │     class="button-primary"
               │     │           ├─ horizontalSpacer_4 [spacer] Horizontal 40×10
               │     │           └─ horizontalSpacer_3 [spacer] Horizontal 259×10
               │     └─ (footer is a sibling of selectSourceContainer)
               └─ footer [QFrame] NoFrame, class="dialog-container"
                  └─ horizontalLayout_2 [QHBoxLayout] spacing=0, margins 0
                     ├─ sourceVisible [QCheckBox] text=Basic.SourceSelect.AddVisible
                     │     → "Make source visible", checked=true
                     ├─ horizontalSpacer_2 [spacer] Horizontal 40×20
                     └─ buttonBox [QDialogButtonBox] standardButtons=Close
```

Notes: `sourceTypeList` is populated at runtime with every source type (icon + display
name); `existingListFrame` (`FlowFrame`) holds one button per existing source of the
selected type; `createNewSource` text substitutes the type name (`Basic.SourceSelect.NewSource`).

### 6.5 Advanced Audio Properties — `OBSAdvAudio.ui`

Window: `OBSAdvAudio [QDialog]`, title `Basic.AdvAudio` → "Advanced Audio Properties",
`sizeGripEnabled=true`, `contextMenuPolicy=CustomContextMenu`.
Connection in `.ui`: `closeButton.clicked() → OBSAdvAudio.close()`.

```
OBSAdvAudio [QDialog]
└─ gridLayout [QGridLayout] margins 11
   ├─ scrollArea [QScrollArea]                                   @r0 c0
   │  └─ scrollAreaWidgetContents [QWidget]
   │     └─ gridLayout_3 [QGridLayout] margins 0, spacing 0
   │        └─ verticalLayout [QVBoxLayout] spacing=0, margins 4  @r0 c0
   │           ├─ mainLayout [QGridLayout]      ← header row (row 0)
   │           │  c0 label_8 [QLabel] text=""                       (icon column)
   │           │  c1 label   [QLabel] Basic.AdvAudio.Name        → "Name"
   │           │  c2 label_7 [QLabel] Basic.Stats.Status         → "Status"
   │           │  c3 widget  [QWidget]
   │           │     └─ gridLayout_2 [QGridLayout] margins 0, spacing 0
   │           │        └─ horizontalLayout_2 [QHBoxLayout] spacing=2
   │           │           ├─ label_9 [QLabel] Basic.AdvAudio.Volume → "Volume"
   │           │           ├─ usePercent [QCheckBox] text="%"
   │           │           └─ horizontalSpacer_3 [spacer] Horizontal, Minimum 0×0
   │           │  c4 label_3 [QLabel] Basic.AdvAudio.Mono       → "Mono"
   │           │  c5 label_2 [QLabel] Basic.AdvAudio.Balance    → "Balance"
   │           │  c6 label_4 [QLabel] Basic.AdvAudio.SyncOffset → "Sync Offset"
   │           │  c7 label_6 [QLabel] Basic.AdvAudio.Monitoring → "Audio Monitoring"
   │           │  c8 label_5 [QLabel] Basic.AdvAudio.AudioTracks → "Tracks"
   │           └─ verticalSpacer [spacer] Vertical 20×40
   └─ horizontalLayout [QHBoxLayout] spacing=7                    @r1 c0
      ├─ activeOnly [QCheckBox] text=Basic.AdvAudio.ActiveOnly → "Active Sources Only", checked=true
      ├─ horizontalSpacer [spacer] Horizontal 40×20
      └─ closeButton [QPushButton] text=Close → "Close"
```

One grid row is appended per audio source at runtime, matching the nine header columns:
source icon, name, status/active indicator, volume slider + percentage, mono checkbox,
balance slider, sync-offset spin box (ms), monitoring combo, and track checkboxes.

---

## 7. Translation-string appendix

All key → English pairs referenced above, from `frontend/data/locale/en-US.ini`.
`&` marks a Qt mnemonic; `%1`,`%2` are runtime substitutions. Plain `.ui` literals that
resolve through the same lookup are marked *(literal)*.

### 7.1 Main menus

| Key | English |
| --- | --- |
| `Basic.MainMenu.File` | `&File` |
| `Basic.MainMenu.File.ShowRecordings` | `Show &Recordings` |
| `Basic.MainMenu.File.Remux` | `Re&mux Recordings` |
| `Basic.MainMenu.File.Settings` | `&Settings` |
| `Basic.MainMenu.File.ShowSettingsFolder` | `Show Settings Folder` |
| `Basic.MainMenu.File.ShowProfileFolder` | `Show Profile Folder` |
| `Basic.MainMenu.File.ShowMissingFiles` | `Check for Missing Files` |
| `Basic.MainMenu.File.Exit` | `E&xit` |
| `Basic.MainMenu.Edit` | `&Edit` |
| `Basic.MainMenu.Edit.Undo` | `&Undo` |
| `Basic.MainMenu.Edit.Redo` | `&Redo` |
| `Basic.MainMenu.Edit.Transform` | `&Transform` |
| `Basic.MainMenu.Edit.Transform.EditTransform` | `&Edit Transform` |
| `Basic.MainMenu.Edit.Transform.CopyTransform` | `Copy Transform` |
| `Basic.MainMenu.Edit.Transform.PasteTransform` | `Paste Transform` |
| `Basic.MainMenu.Edit.Transform.ResetTransform` | `&Reset Transform` |
| `Basic.MainMenu.Edit.Transform.Rotate90CW` | `Rotate 90 degrees CW` |
| `Basic.MainMenu.Edit.Transform.Rotate90CCW` | `Rotate 90 degrees CCW` |
| `Basic.MainMenu.Edit.Transform.Rotate180` | `Rotate 180 degrees` |
| `Basic.MainMenu.Edit.Transform.FlipHorizontal` | `Flip &Horizontal` |
| `Basic.MainMenu.Edit.Transform.FlipVertical` | `Flip &Vertical` |
| `Basic.MainMenu.Edit.Transform.FitToScreen` | `&Fit to screen` |
| `Basic.MainMenu.Edit.Transform.StretchToScreen` | `&Stretch to screen` |
| `Basic.MainMenu.Edit.Transform.CenterToScreen` | `&Center to screen` |
| `Basic.MainMenu.Edit.Transform.VerticalCenter` | `Center Vertically` |
| `Basic.MainMenu.Edit.Transform.HorizontalCenter` | `Center Horizontally` |
| `Basic.MainMenu.Edit.Order` | `&Order` |
| `Basic.MainMenu.Edit.Order.MoveUp` | `Move &Up` |
| `Basic.MainMenu.Edit.Order.MoveDown` | `Move &Down` |
| `Basic.MainMenu.Edit.Order.MoveToTop` | `Move to &Top` |
| `Basic.MainMenu.Edit.Order.MoveToBottom` | `Move to &Bottom` |
| `Basic.MainMenu.Edit.Scale` | `Preview &Scaling` |
| `Basic.MainMenu.Edit.Scale.Window` | `Scale to Window` |
| `Basic.MainMenu.Edit.Scale.Canvas` | `Canvas (%1x%2)` |
| `Basic.MainMenu.Edit.Scale.Output` | `Output (%1x%2)` |
| `Basic.MainMenu.Edit.Scale.ZoomIn` | `Zoom In` |
| `Basic.MainMenu.Edit.Scale.ZoomOut` | `Zoom Out` |
| `Basic.MainMenu.Edit.Scale.ResetZoom` | `Reset Zoom` |
| `Basic.MainMenu.Edit.LockPreview` | `&Lock Preview` |
| `Basic.MainMenu.Edit.AdvAudio` | `&Advanced Audio Properties` |
| `Basic.MainMenu.View` | `&View` |
| `Basic.MainMenu.View.ResetUI` | `&Reset UI` |
| `Basic.MainMenu.View.Fullscreen.Interface` | `Fullscreen Interface` |
| `Basic.MainMenu.View.SceneListMode` | `Scene List Mode` |
| `Basic.MainMenu.View.ListboxToolbars` | `Dock Toolbars` |
| `Basic.MainMenu.View.ContextBar` | `Source Toolbar` |
| `Basic.MainMenu.View.SourceIcons` | `Source &Icons` |
| `Basic.MainMenu.View.StatusBar` | `&Status Bar` |
| `Basic.MainMenu.View.AlwaysOnTop` | `&Always On Top` |
| `Basic.MainMenu.Docks` | `&Docks` |
| `Basic.MainMenu.Docks.LockDocks` | `&Lock Docks` |
| `Basic.MainMenu.Docks.SideDocks` | `&Full-Height Docks` |
| `Basic.MainMenu.Docks.ResetDocks` | `&Reset Docks` |
| `Basic.MainMenu.Docks.CustomBrowserDocks` | `&Custom Browser Docks` |
| `Basic.MainMenu.Profile` | `&Profile` |
| `Basic.MainMenu.SceneCollection` | `&Scene Collection` |
| `Basic.MainMenu.SceneCollection.Migrate` | `Set Base Resolution` |
| `Basic.MainMenu.SceneCollection.Remigrate` | `Reset Base Resolution` |
| `Basic.MainMenu.SceneCollection.Export` | `Export Scene Collection` (file-dialog title) |
| `Basic.MainMenu.Profile.Import` | `Import Profile` (file-dialog title) |
| `Basic.MainMenu.Profile.Export` | `Export Profile` (file-dialog title) |
| `Basic.MainMenu.Profile.Exists` | `The profile already exists` |
| `Basic.MainMenu.Import` | `Import...` |
| `Basic.MainMenu.Export` | `Export...` |
| `Basic.MainMenu.Tools` | `&Tools` |
| `Basic.AutoConfig` | `Auto-Configuration Wizard` |
| `Basic.OpenPluginManager` | `Plugin Manager` |
| `Basic.MainMenu.Help` | `&Help` |
| `Basic.MainMenu.Help.HelpPortal` | `Help &Portal` |
| `Basic.MainMenu.Help.Website` | `Visit &Website` |
| `Basic.MainMenu.Help.Discord` | `Join &Discord Server` |
| `Basic.MainMenu.Help.Logs` | `&Log Files` |
| `Basic.MainMenu.Help.Logs.ShowLogs` | `&Show Log Files` |
| `Basic.MainMenu.Help.Logs.UploadCurrentLog` | `Upload &Current Log File` |
| `Basic.MainMenu.Help.Logs.UploadLastLog` | `Upload &Previous Log File` |
| `Basic.MainMenu.Help.Logs.ViewCurrentLog` | `&View Current Log` |
| `Basic.MainMenu.Help.CrashLogs` | `Crash &Reports` |
| `Basic.MainMenu.Help.CrashLogs.ShowLogs` | `&Show Crash Reports` |
| `Basic.MainMenu.Help.CrashLogs.UploadLastLog` | `Upload &Previous Crash Report` |
| `Basic.MainMenu.Help.Repair` | `Check File Integrity` |
| `Basic.MainMenu.Help.CheckForUpdates` | `Check For Updates` |
| `Basic.MainMenu.Help.RestartSafeMode` | `Restart in Safe Mode` |
| `Basic.MainMenu.Help.RestartNormal` | `Restart in Normal Mode` |
| `MacPermissions.MenuAction` | `Review App Permissions...` |
| `Basic.MainMenu.Help.WhatsNew` | `What's New` |
| `Basic.MainMenu.Help.ReleaseNotes` | `Release Notes` |
| `Basic.MainMenu.Help.About` | `&About` |
| `Basic.Stats` | `Stats` |
| `Projector.Open.Multiview` | `Open Multiview` |
| `Projector.Window` | `New window` |

### 7.2 Menu literals resolved through the lookup

| Literal in `.ui` | English |
| --- | --- |
| `New` | `New...` |
| `Duplicate` | `Duplicate...` |
| `Rename` | `Rename...` |
| `Remove` | `Remove` |
| `Copy` | `Copy` |
| `PasteReference` | `Paste (Reference)` |
| `PasteDuplicate` | `Paste (Duplicate)` |
| `Copy.Filters` | `Copy Filters` |
| `Paste.Filters` | `Paste Filters` |
| `Undo.Undo` | `Undo` |
| `Undo.Redo` | `Redo` |
| `Grid` | `Grid` |
| `List` | `List` |
| `Interact` | `Interact` |
| `Filters` | `Filters` |
| `Properties` | `Properties` |
| `Settings` | `Settings` |
| `Close` | `Close` |
| `RestoreDefaults` | `Defaults` |
| `PreviewTransition` | `Preview Transition` |

### 7.3 Docks, controls, transitions

| Key | English |
| --- | --- |
| `Basic.Main.Scenes` | `Scenes` |
| `Basic.Main.Sources` | `Sources` |
| `Basic.Main.Controls` | `Controls` |
| `Basic.SceneTransitions` | `Scene Transitions` |
| `Mixer` | `Audio Mixer` |
| `AddScene` | `Add Scene` |
| `RemoveScene` | `Remove Selected Scene` |
| `SceneFilters` | `Open Scene Filters` |
| `MoveSceneUp` | `Move Scene Up` |
| `MoveSceneDown` | `Move Scene Down` |
| `AddSource` | `Add Source` |
| `RemoveSource` | `Remove Selected Source(s)` |
| `SourceProperties` | `Open Source Properties` |
| `SourceFilters` | `Open Source Filters` |
| `MoveSourceUp` | `Move Source(s) Up` |
| `MoveSourceDown` | `Move Source(s) Down` |
| `MoveUp` | `Move Up` |
| `MoveDown` | `Move Down` |
| `Basic.TransitionDuration` | `Duration` |
| `Basic.AddTransition` | `Add Configurable Transition` |
| `Basic.RemoveTransition` | `Remove Configurable Transition` |
| `Basic.TransitionProperties` | `Transition Properties` |
| `Basic.Main.StartStreaming` | `Start Streaming` |
| `Basic.Main.StopStreaming` | `Stop Streaming` |
| `Basic.Main.ForceStopStreaming` | `Stop Streaming (discard delay)` |
| `Basic.Main.PreparingStream` | `Preparing...` |
| `Basic.Main.Connecting` | `Connecting...` |
| `Basic.Main.StoppingStreaming` | `Stopping Stream...` |
| `Basic.Main.StartBroadcast` | `Go Live` |
| `Basic.Main.StopBroadcast` | `End Broadcast` |
| `Basic.Main.SetupBroadcast` | `Manage Broadcast` |
| `Basic.Main.AutoStopEnabled` | `(Auto Stop)` |
| `Basic.Main.StartRecording` | `Start Recording` |
| `Basic.Main.StopRecording` | `Stop Recording` |
| `Basic.Main.StoppingRecording` | `Stopping Recording...` |
| `Basic.Main.PauseRecording` | `Pause Recording` |
| `Basic.Main.UnpauseRecording` | `Unpause Recording` |
| `Basic.Main.StartReplayBuffer` | `Start Replay Buffer` |
| `Basic.Main.StopReplayBuffer` | `Stop Replay Buffer` |
| `Basic.Main.StoppingReplayBuffer` | `Stopping Replay Buffer...` |
| `Basic.Main.SaveReplay` | `Save Replay` |
| `Basic.Main.StartVirtualCam` | `Start Virtual Camera` |
| `Basic.Main.StopVirtualCam` | `Stop Virtual Camera` |
| `Basic.Main.VirtualCamConfig` | `Configure Virtual Camera` |
| `Basic.TogglePreviewProgramMode` | `Studio Mode` |
| `Basic.Main.PreviewConextMenu.Enable` | `Enable Preview` |
| `Basic.Main.PreviewDisabled` | `Preview is currently disabled` |
| `StudioMode.PreviewSceneName` | `Preview: %1` |
| `ContextBar.NoSelectedSource` | `No source selected` |

### 7.4 Status bar

| Key | English |
| --- | --- |
| `DroppedFrames` | `Dropped Frames %1 (%2%)` |
| `Basic.StatusBar.Delay` | `Delay (%1 sec)` |
| `Basic.StatusBar.DelayStartingIn` | `Delay (starting in %1 sec)` |
| `Basic.StatusBar.DelayStoppingIn` | `Delay (stopping in %1 sec)` |
| `Basic.StatusBar.DelayStartingStoppingIn` | `Delay (stopping in %1 sec, starting in %2 sec)` |
| `Basic.StatusBar.Reconnecting` | `Disconnected, reconnecting in %2 second(s) (attempt %1)` |
| `Basic.StatusBar.AttemptingReconnect` | `Attempting to reconnect... (attempt %1)` |
| `Basic.StatusBar.ReconnectSuccessful` | `Reconnection successful` |
| `HighResourceUsage` | `Encoding overloaded! Consider turning down video settings or using a faster encoding preset.` |
| `Basic.SystemTray.Message.Reconnecting` | `Disconnected. Reconnecting...` |

### 7.5 Dialogs

| Key | English |
| --- | --- |
| `Basic.Filters` | `Filters` |
| `Basic.Filters.AsyncFilters` | `Audio/Video Filters` |
| `Basic.Filters.EffectFilters` | `Effect Filters` |
| `Properties` *(literal)* | `Properties` |
| `Basic.TransformWindow` | `Scene Item Transform` |
| `Basic.TransformWindow.Position` | `Position` |
| `Basic.TransformWindow.Size` | `Size` |
| `Basic.TransformWindow.Rotation` | `Rotation` |
| `Basic.TransformWindow.Alignment` | `Alignment` |
| `Basic.TransformWindow.Bounds` | `Bounds` |
| `Basic.TransformWindow.BoundsAlignment` | `Bounds Alignment` |
| `Basic.TransformWindow.Width` | `Width` |
| `Basic.TransformWindow.Height` | `Height` |
| `Basic.TransformWindow.PositionX` | `X` |
| `Basic.TransformWindow.PositionY` | `Y` |
| `Basic.TransformWindow.Accessible.PositionX` | `X Position` |
| `Basic.TransformWindow.Accessible.PositionY` | `Y Position` |
| `Basic.TransformWindow.BoundsType` | `Bounds Type` |
| `Basic.TransformWindow.BoundsType.None` | `Automatic` |
| `Basic.TransformWindow.BoundsType.Stretch` | `Stretch` |
| `Basic.TransformWindow.BoundsType.ScaleInner` | `Fit` |
| `Basic.TransformWindow.BoundsType.ScaleOuter` | `Cover` |
| `Basic.TransformWindow.BoundsType.ScaleToWidth` | `Fill Width` |
| `Basic.TransformWindow.BoundsType.ScaleToHeight` | `Fill Height` |
| `Basic.TransformWindow.BoundsType.MaxOnly` | `Maximum size only` |
| `Basic.TransformWindow.BoundsWidth` | `Bounding Box Width` |
| `Basic.TransformWindow.BoundsHeight` | `Bounding Box Height` |
| `Basic.TransformWindow.CropToBounds` | `Crop Bounds` |
| `Basic.TransformWindow.Crop` | `Crop` |
| `Basic.TransformWindow.CropLeft` | `Crop Left` |
| `Basic.TransformWindow.CropRight` | `Crop Right` |
| `Basic.TransformWindow.CropTop` | `Crop Top` |
| `Basic.TransformWindow.CropBottom` | `Crop Bottom` |
| `Basic.SourceSelect` | `Add Source` |
| `Basic.SourceSelect.SelectType` | `Source Type` |
| `Basic.SourceSelect.Recent` | `Recently Created` |
| `Basic.SourceSelect.Description` | `Select which source(s) to add to your current scene.` |
| `Basic.SourceSelect.NewSource` | `Add a new %1` |
| `Basic.SourceSelect.NoExisting` | `You have no existing %1 sources yet.` |
| `Basic.SourceSelect.NoSelection` | `Add existing` |
| `Basic.SourceSelect.AddExisting` | `Add %1 existing` |
| `Basic.SourceSelect.AddVisible` | `Make source visible` |
| `Basic.SourceSelect.Deprecated.Create` | `This source type is marked as deprecated and may be removed in the future.` |
| `Basic.AdvAudio` | `Advanced Audio Properties` |
| `Basic.AdvAudio.ActiveOnly` | `Active Sources Only` |
| `Basic.AdvAudio.Name` | `Name` |
| `Basic.Stats.Status` | `Status` |
| `Basic.AdvAudio.Volume` | `Volume` |
| `Basic.AdvAudio.Mono` | `Mono` |
| `Basic.AdvAudio.Balance` | `Balance` |
| `Basic.AdvAudio.SyncOffset` | `Sync Offset` |
| `Basic.AdvAudio.Monitoring` | `Audio Monitoring` |
| `Basic.AdvAudio.AudioTracks` | `Tracks` |

### 7.6 Source toolbars / media / mixer

| Key | English |
| --- | --- |
| `Basic.PropertiesWindow.SelectColor` | `Select color` |
| `Basic.PropertiesWindow.SelectFont` | `Select font` |
| `RefreshBrowser` | `Refresh` |
| `Browse` | `Browse` (a lookup key whose value equals the literal) |
| `ContextBar.MediaControls.RestartMedia` | `Restart Media` |
| `ContextBar.MediaControls.StopMedia` | `Stop Media` |
| `ContextBar.MediaControls.PlaylistPrevious` | `Previous in Playlist` |
| `ContextBar.MediaControls.PlaylistNext` | `Next in Playlist` |
| `ContextBar.MediaControls.PlayMedia` | `Play Media` |
| `ContextBar.MediaControls.PauseMedia` | `Pause Media` |
| `ContextBar.MediaControls.BlindSeek` | `Media Seek Widget` |
| `Basic.AudioMixer.Options` | `Options` |
| `Basic.AudioMixer.HiddenTotal` | `%1 hidden` |
| `Basic.AudioMixer.ShowHidden` | `Show hidden sources` |
| `Basic.AudioMixer.HideHidden` | `Hide hidden sources` |
| `Basic.AudioMixer.ShowInactive` | `Show inactive sources` |
| `Basic.AudioMixer.KeepHiddenRight` | `Keep hidden sources to the right` |
| `Basic.AudioMixer.KeepHiddenBottom` | `Keep hidden sources at the bottom` |
| `Basic.AudioMixer.KeepInactiveRight` | `Keep inactive sources to the right` |
| `Basic.AudioMixer.KeepInactiveBottom` | `Keep inactive sources at the bottom` |
| `Basic.AudioMixer.Layout.Vertical` | `Vertical Layout` |
| `Basic.AudioMixer.Layout.Horizontal` | `Horizontal Layout` |
| `Basic.AudioMixer.Pin` / `Basic.AudioMixer.Unpin` | `Pin` / `Unpin` |
| `Basic.AudioMixer.Hide` / `Basic.AudioMixer.Unhide` | `Hide` / `Unhide` |
| `Basic.AudioMixer.Monitoring.Enable` | `Enable Monitoring` |
| `Basic.AudioMixer.Monitoring.Disable` | `Disable Monitoring` |
| `Basic.AudioMixer.Category.Active` | `Active` |
| `Basic.AudioMixer.Category.Unassigned` | `Unassigned` |
| `Basic.AudioMixer.Category.Global` | `Global` |
| `Basic.AudioMixer.Category.Pinned` | `Pinned` |
| `Basic.AudioMixer.Category.Hidden` | `Hidden` |
| `Basic.AudioMixer.Category.Inactive` | `Inactive` |
| `Basic.AudioMixer.Category.Preview` | `Preview` |
| `LockVolume` | `Lock Volume` |
| `Mute` / `Unmute` | `Mute` / `Unmute` |
| `VolControl.Mute` | `Mute '%1'` |
| `UnhideAll` | `Unhide All` |
| `Basic.Main.MixerRename.Title` | `Rename Audio Source` |
| `Basic.Main.MixerRename.Text` | `Please enter the name of the audio source` |
| `VolControl.UnassignedWarning.Title` | `Unassigned Audio Source` |
| `VolControl.UnassignedWarning.Text` | `"%1" is not assigned to any audio tracks and it will not be audible in streams or recordings.` |
| `DoNotShowAgain` | `Do not show again` |

### 7.7 Context menus / misc

| Key | English |
| --- | --- |
| `Basic.Main.GroupItems` | `Group Selected Items` |
| `Basic.Main.Ungroup` | `Ungroup` |
| `HideMixer` | `Hide in Mixer` |
| `ResizeOutputSizeOfSource` | `Resize output (source size)` |
| `ShowInMultiview` | `Show in Multiview` |
| `Screenshot.Preview` | `Save Preview Screenshot` |
| `Screenshot.Source` | `Save Source Screenshot` |
| `Screenshot.Scene` | `Save Scene Screenshot` |
| `Screenshot.StudioProgram` | `Save Program Screenshot` |
| `QuickTransitions.DuplicateScene` | `Duplicate Scene` |
| `QuickTransitions.EditProperties` | `Edit Properties` |
| `QuickTransitions.SwapScenes` | `Swap Scenes` |
| `Transition` | `Transition` |
| `TransitionOverride` | `Transition Override` |
| `FadeToBlack` | `Fade to Black` |
| `ConfirmRemove.Title` | `Confirm Remove` |
| `ConfirmRemove.Text` | `Are you sure you wish to remove '%1'?` |
| `NameExists.Title` | `Name already exists` |
| `NameExists.Text` | `The name is already in use.` |
| `NoNameEntered.Title` | `Please enter a valid name` |
| `NoNameEntered.Text` | `You cannot use empty names.` |
| `Restart` | `Restart` |
| `NeedsRestart` | `OBS Studio needs to be restarted. Do you want to restart now?` |
| `LoadProfileNeedsRestart` | `Profile contains settings that require restarting OBS:\n%1\n\nDo you want to restart OBS for these settings to take effect?` |
| `ResetUIWarning.Title` | `Are you sure you want to reset the UI?` |
| `ResetUIWarning.Text` | `Resetting the UI will hide additional docks. You will need to unhide these docks from the Docks menu if you want them to be visible.\n\nAre you sure you want to reset the UI?` |
| `SafeMode.Restart` | `Do you want to restart OBS in Safe Mode (third-party plugins, scripting, and WebSockets disabled)?` |
| `SafeMode.RestartNormal` | `Do you want to restart OBS in Normal Mode?` |

### 7.8 Exact literal (untranslated) strings used as labels/tooltips

These `.ui` values are not found in the lookup table and are rendered verbatim:
`Message`, `DelayInfo`, `Device`, `Mode`, `Window`, `Image File`, `color here`,
`TextLabel`, `Activate`, `Idian Playground`, `--:--:--`,
`/`, `0 kbps`, `CPU: 0.0%`, `0.00 / 0.00 FPS`, `00:00:00`, `100%`, `%`, `ms`, `px`, `°`,
`border: none;`, and the styling-class tokens
`dialog-container`, `dialog-frame`, `frame-notice`, `text-title`, `text-muted`,
`text-small text-muted margin-y`, `subtitle`, `btn-create-new`, `button-primary`,
`toolbar-button`, `text-bold`, `toggle-hidden`, `icon-*`, `label-preview-title`.

---

## Appendix A — Widget-class → header map (custom widgets)

| Class in `.ui` | Extends | Header |
| --- | --- | --- |
| `OBSDock` | QDockWidget | `docks/OBSDock.hpp` |
| `OBSBasicPreview` | QWidget | `widgets/OBSBasicPreview.hpp` |
| `OBSBasicStatusBar` | QStatusBar | `widgets/OBSBasicStatusBar.hpp` |
| `SceneTree` | QListWidget | `components/SceneTree.hpp` |
| `SourceTree` | QListView | `components/SourceTree.hpp` |
| `OBSPreviewScalingLabel` | QLabel | `components/OBSPreviewScalingLabel.hpp` |
| `OBSPreviewScalingComboBox` | QComboBox | `components/OBSPreviewScalingComboBox.hpp` |
| `FocusList` | QListWidget | `components/FocusList.hpp` |
| `OBSQTDisplay` | QWidget | `widgets/OBSQTDisplay.hpp` |
| `FlowFrame` | QFrame | `components/FlowFrame.hpp` |
| `OBS::SpinBox` | QSpinBox | `SpinBox.hpp` |
| `OBS::DoubleSpinBox` | QDoubleSpinBox | `DoubleSpinBox.hpp` |
| `ClickableLabel` | QLabel | `components/ClickableLabel.hpp` |
| `AbsoluteSlider` | QSlider | `components/AbsoluteSlider.hpp` |

All icons are Qt resources under `:/res/images/...` and `:/settings/images/settings/...`
(declared in `obs.qrc`; `OBSBasic.ui` `<resources><include location="obs.qrc"/></resources>`).

## Appendix B — Fidelity checklist for the web port

1. Reproduce the **exact dock arrangement** from §1.4, not the `.ui` attribute values
   (all four `.ui` docks nominally say "Bottom").
2. Label resolution must strip spaces and fall back to the literal, per §0.2 — otherwise
   `Mixer` renders as "Mixer" instead of "Audio Mixer" and `Rename` loses its ellipsis.
3. Menu order is File, Edit, View, Docks, Profile, Scene Collection, Tools, Help — note
   **Docks precedes Profile**, and the Profile list precedes Scene Collection.
4. The Source Toolbar is not a dock toolbar; it is `contextContainer` in the central
   widget and is replaced per source type.
5. The status bar is a single right-aligned permanent widget; `delayFrame`, `issuesFrame`
   and `kbps` start hidden.
6. Two dialogs use a vertical `QSplitter` (`OBSBasicFilters.rightLayout`,
   `OBSBasicProperties.windowSplitter`) with a 0×400 minimum.
7. `OBSBasicFilters` uses `stretch=1,10` between the filter lists and the right pane;
   `OBSBasicSourceSelect` uses `stretch=1,4` between the type list and the source pane.
