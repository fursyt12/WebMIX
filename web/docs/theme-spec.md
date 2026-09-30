# OBS Studio Dark Theme — Design Token Specification

Reconnaissance reference for reproducing the **default OBS Studio dark theme** in a web UI.

Extracted from the OBS Studio source checkout at `/home/huckskee/git/WebMIX`.

---

## 0. Sources and scope

### 0.1 Correction to the task premise: there is no `Yami.qss`

The task asked for `frontend/data/themes/Yami.qss`. **That file does not exist in this checkout** (nor does any `.qss` file anywhere in the repo). This OBS version uses the newer **OBS Theme System**, where a single `.obt` file contains:

1. `@OBSThemeMeta { … }` — name / id / author / `dark` flag,
2. `@OBSThemeVars { … }` — the design-token block (`--name: value;`),
3. the raw Qt Style Sheet body (everything after the last metadata block).

The file that plays the role of "the main/default dark theme stylesheet" is therefore:

| Role | File |
| --- | --- |
| Main base theme (palette **and** all widget QSS) | `frontend/data/themes/Yami.obt` (2887 lines) |
| The variant selected as *default* | `frontend/data/themes/Yami_Default.ovt` (24 lines — a **stub**, see below) |

`Yami_Default.ovt` contains **no variable overrides and no QSS body**. It only declares metadata and `extends: 'com.obsproject.Yami'`. Consequently, **the default dark palette is exactly the palette defined inside `Yami.obt` itself.** All values in this document are the Yami base values, which is what "Yami_Default" resolves to.

```
@OBSThemeMeta {
    name: 'Default';
    id: 'com.obsproject.Yami.Original';
    extends: 'com.obsproject.Yami';
    author: 'Warchamp7';
    dark: 'true';
}
```

### 0.2 File inventory read for this document

| Path | Lines | Contents |
| --- | --- | --- |
| `frontend/data/themes/Yami.obt` | 2887 | Meta + 182 variables + full QSS body |
| `frontend/data/themes/Yami_Default.ovt` | 24 | Stub, `dark: true`, no overrides |
| `frontend/data/themes/Yami_Grey.ovt` | 36 | 8 grey overrides only, no QSS body |
| `frontend/data/themes/Yami_Classic.ovt` | 286 | Many overrides |
| `frontend/data/themes/Yami_Acri.ovt` | 232 | Many overrides |
| `frontend/data/themes/Yami_Rachni.ovt` | 226 | Many overrides |
| `frontend/data/themes/Yami_Light.ovt` | 444 | Light variant (`dark: false`) |
| `frontend/data/themes/System.obt` | 477 | Special non-selectable accessibility base |
| `frontend/OBSApp_Themes.cpp` | 1120 | Parser + substitution engine |
| `frontend/data/themes/Dark/` | 58 files | Icon set for dark themes |
| `frontend/data/themes/Yami/` | 6 files | Checkbox indicator SVGs |
| `frontend/data/themes/Acri/`, `Rachni/` | 16 / 21 files | **Dead assets** (see §5.4) |

### 0.3 How variables are substituted (important for fidelity)

Implemented in `OBSApp::SetTheme` → `PrepareQSS()` / `EvalMath()` / `ResolveVariable()` in `frontend/OBSApp_Themes.cpp`.

1. Themes are composed in dependency order: `Yami` first, then the variant (`.ovt`) on top. Later definitions overwrite earlier ones (`vars[var.name] = std::move(var)`).
2. OBS **injects two runtime variables** before parsing (lines 910–924):
   * `--obsFontScale` ← `Appearance/FontScale` config value, **default `10`** (`frontend/OBSApp.cpp:425`)
   * `--obsPadding` ← `getPaddingForDensityId(Appearance/Density)`, **default `4`** (see below)
3. The QSS body is obtained by **stripping everything up to and including the last `}` of the metadata sections** (`FindEndOfOBSMetadata`). Both `@OBSThemeMeta` and `@OBSThemeVars` are removed from the text handed to Qt.
4. Substitution is a **plain textual replacement of the exact needle `var(--name)`**. There is no CSS cascade, no `var(--name, fallback)`, and no runtime `var()` in the output. Every `var(--x)` in the QSS body is replaced by a literal before Qt ever sees it.
5. Type-dependent formatting of the replacement:
   * **Color** → `QColor::name(HexRgb)` → lowercase-normalised `#RRGGBB` (input may be `#hex`, `rgb(r,g,b)`, or `bikeshed`).
   * **Size / Number** → numeric text plus the original suffix.
   * **calc / min / max** → recursively evaluated arithmetic (`+ - * /`); both operands carrying a suffix must carry the *same* suffix, otherwise a suffix-less operand adopts the other's.
   * **Alias (`var(--x)`)** → resolved by following the alias chain.
   * **String** → as written (e.g. `"transparent"`).
6. **Final px rounding:** if the substituted string ends in `px`, the numeric part is rounded with `roundf()` and re-emitted as an integer. So an internal `1.6px` becomes the literal `2px` in the effective stylesheet. `pt` values are **not** rounded (`6.75pt` stays `6.75pt`).
7. `--palette_*` variables are **not** substituted into the QSS. They are applied to the `QPalette` via `PreparePalette()` (see §6).

### 0.4 The two runtime variables, resolved

`Appearance/FontScale` default = `10` → **`--obsFontScale = 10`**.

`Appearance/Density` default = `1`. The density radio buttons are auto-assigned negative button-group IDs (`-2 … -5`) because the `.ui` buttongroup declares no explicit IDs:

| Button | Button-group id | `getPaddingForDensityId(id)` |
| --- | --- | --- |
| Classic | `-2` | `0.25` |
| Compact | `-3` | `2` |
| **Normal** | `-4` | **`4`** |
| Comfortable | `-5` | `6` |
| *(default config value)* | `1` → no match | fallback **`4`** |

So the shipped default is **Normal density → `--obsPadding = 4`**.

**All derived metrics in this document assume `--obsFontScale: 10` and `--obsPadding: 4`.**

### 0.5 Base Qt style (affects unstyled controls)

`OBSApp::InitTheme()` (line 1048) sets:

```cpp
# Linux:   setStyle(new OBSProxyStyle("Fusion"));
# Windows: setStyle(new OBSProxyStyle("windowsvista"));
# macOS:   setStyle(new OBSProxyStyle());   // native macOS style
```

`OBSProxyStyle` only overrides `PM_TextCursorWidth`; it does not draw widgets. **On Linux the effective base style is Fusion**, so any control with no QSS rule is drawn by Fusion using the `QPalette` — not by a native GTK theme.

### 0.6 Fonts are bundled

`frontend/obs-main.cpp:537-539` registers the bundled fonts as application fonts:

```cpp
QFontDatabase::addApplicationFont(":/fonts/OpenSans-Regular.ttf");
QFontDatabase::addApplicationFont(":/fonts/OpenSans-Bold.ttf");
QFontDatabase::addApplicationFont(":/fonts/OpenSans-Italic.ttf");
```

Fonts ship at `frontend/forms/fonts/OpenSans-{Regular,Bold,Italic}.ttf` and are listed in `frontend/forms/obs.qrc` (lines 94–96). Therefore `'Open Sans'` in the QSS resolves to the bundled Open Sans (400 / 700 / italic), **not** a host font.

A web reproduction should ship/load **Open Sans 400, 700 and italic**.

---

## 1. Palette table

### 1.1 Raw colour ramps

These are the raw named colours defined in `Yami.obt` lines 33–101. Each ramp runs light → dark.

#### Blue (`--blue1` … `--blue6`) — the accent ramp

| Variable | Value | Typical use in Yami |
| --- | --- | --- |
| `--blue1` | `#718CDC` | `--primary_lighter`; focus borders; `.text-bright` |
| `--blue2` | `#476BD7` | `--primary_light`; slider filled track; progress-bar top border; link colour |
| `--blue3` | `#284CB8` | **`--primary`** — selection, checked buttons, active tabs |
| `--blue4` | `#213E97` | `--primary_dark`; progress-bar bottom border |
| `--blue5` | `#1A3278` | `--primary_darker`; pinned mixer category bg |
| `--blue6` | `#162A64` | default mixer category bg |

| Variable | Value |
| --- | --- |
| `--red1` | `#E85E75` |
| `--red2` | `#E33B57` |
| `--red3` | `#C01C37` |
| `--red4` | `#A1172E` |
| `--red5` | `#7D1224` |
| `--red6` | `#590D1A` |

| Variable | Value |
| --- | --- |
| `--pink1` | `#E5619A` |
| `--pink2` | `#E03E84` |
| `--pink3` | `#C11F65` |
| `--pink4` | `#9E1A53` |
| `--pink5` | `#7B1441` |
| `--pink6` | `#580E2E` |

| Variable | Value |
| --- | --- |
| `--teal1` | `#3DBEF5` |
| `--teal2` | `#16B1F3` |
| `--teal3` | `#0981B4` |
| `--teal4` | `#086F9B` |
| `--teal5` | `#065374` |
| `--teal6` | `#04374E` |

| Variable | Value |
| --- | --- |
| `--purple1` | `#997FDC` |
| `--purple2` | `#805FD3` |
| `--purple3` | `#5B34BF` |
| `--purple4` | `#4D2CA0` |
| `--purple5` | `#3D2380` |
| `--purple6` | `#2E1A60` |

| Variable | Value |
| --- | --- |
| `--green1` | `#59D966` |
| `--green2` | `#37D247` |
| `--green3` | `#25A231` |
| `--green4` | `#1E8528` |
| `--green5` | `#17641E` |
| `--green6` | `#0F4313` |

| Variable | Value |
| --- | --- |
| `--yellow1` | `#EABC48` |
| `--yellow2` | `#E5AF24` |
| `--yellow3` | `#B88A16` |
| `--yellow4` | `#926E11` |
| `--yellow5` | `#6E520D` |
| `--yellow6` | `#493709` |

#### Grey ramp — **the structural backbone of the dark theme**

| Variable | Value | Role / usage |
| --- | --- | --- |
| `--grey1` | `#5B6273` | `--input_border`, `--input_border_hover`, `--button_border_hover`, `--button_border_focus`; hover borders |
| `--grey2` | `#4E5566` | `--palette_light`; `--scrollbar_down`, `--scrollbar_border` |
| `--grey3` | `#464B59` | `--button_bg_hover`, `--tab_bg_hover`, `--scrollbar_hover`; list-item hover border |
| `--grey4` | `#3C404D` | `--border_color`, `--input_bg`, `--button_bg`, `--scrollbar_handle`; slider groove; **the dominant control fill** |
| `--grey5` | `#323540` | `QDockWidget::title` bg |
| `--grey6` | `#272A33` | **`--bg_base`** (panels), `--button_bg_disabled`, `--tab_bg`, `--scrollbar_bg`, `--palette_dark` |
| `--grey7` | `#1D1F26` | **`--bg_window`** (window chrome), `--palette_mid`, `--button_bg_down`, `--input_bg_hover`, `--input_bg_focus` |
| `--grey8` | `#13141A` | **`--bg_preview`** (canvas), `.bg-info`, `.frame-notice` bg |

#### Neutral ramp (white / black)

| Variable | Value | Role / usage |
| --- | --- | --- |
| `--white1` | `#FFFFFF` | **`--text`**, `--text_light`; slider handle; `--separator_hover` |
| `--white2` | `#E1E1E1` | unused in Yami base QSS (ramp only) |
| `--white3` | `#D2D2D2` | list-item focus border; slider handle pressed; `.button-primary:hover` border |
| `--white4` | `#B4B4B4` | slider handle hover; disabled meter foreground |
| `--white5` | `#969696` | **`--text_muted`**, `--text_disabled`; meter major ticks; slider handle disabled |
| `--black1` | `#0A0A0A` | Light-variant text (not used in dark base QSS) |
| `--black2` | `#1F1F1F` | unused in Yami base QSS |
| `--black3` | `#414141` | disabled meter `backgroundErrorColorDisabled` |
| `--black4` | `#646464` | disabled meter `backgroundNominalColorDisabled` |
| `--black5` | `#828282` | disabled meter `backgroundWarningColorDisabled` |

### 1.2 Semantic tokens (Base Theme Colors + Layout + Controls)

This is the actual token layer. Values shown are **fully resolved** for `Yami_Default` (FontScale 10, Padding 4).

| Variable | Resolved value | Description / what it is used for |
| --- | --- | --- |
| `--bg_window` | `#1D1F26` | Application window background: `QDialog`, `QMainWindow`, `QStatusBar`, `QMenuBar`, `QMenu`, scrollbar `::corner` |
| `--bg_base` | `#272A33` | Panel/dock/container background: `QAbstractItemView`, `QToolTip`, `QTableView`, `QGroupBox`, `OBSDock`, status bar, mixer |
| `--bg_preview` | `#13141A` | Video canvas background (`OBSQTDisplay::displayBackgroundColor`) |
| `--primary` | `#284CB8` | Primary accent: selection bg, checked buttons, active tab, progress/highlight |
| `--primary_light` | `#476BD7` | Accent hover |
| `--primary_lighter` | `#718CDC` | Accent focus / brightest accent |
| `--primary_dark` | `#213E97` | Accent pressed / dark |
| `--primary_darker` | `#1A3278` | Darkest accent |
| `--text` | `#FFFFFF` | Default foreground |
| `--text_light` | `#FFFFFF` | "Light" foreground (same as `--text` in dark) |
| `--text_muted` | `#969696` | Secondary / de-emphasised text |
| `--text_disabled` | `#969696` | Disabled text (aliases `--text_muted`) |
| `--text_inactive` | `#FFFEFF` | Text for inactive palette group (`rgb(255,254,255)`) |
| `--highlight_width` | `1px` | Border width used for keyboard-focus highlights |
| `--highlight_color` | `#718CDC` | Keyboard-focus highlight border colour (= `--primary_lighter`) |
| `--border_highlight` | `"transparent"` | String token, focus border placeholder (TODO in source) |
| `--separator_hover` | `#FFFFFF` | `QMainWindow::separator:hover` border |
| `--border_color` | `#3C404D` | Generic border (= `--grey4`) |
| `--border_radius` | `4px` | Default corner radius |
| `--border_radius_small` | `2px` | Small radius (scrollbar handle, progress chunk) |
| `--border_radius_large` | `6px` | Large radius (unused in base QSS) |
| `--scrollbar_size` | `12px` | Scrollbar thickness |
| `--settings_scrollbar_size` | `21px` | Scrollbar thickness inside Settings dialog |
| `--scrollbar_handle` | `#3C404D` | Scrollbar thumb |
| `--scrollbar_bg` | `#272A33` | Scrollbar trough |
| `--scrollbar_hover` | `#464B59` | Thumb hover |
| `--scrollbar_down` | `#4E5566` | Thumb pressed |
| `--scrollbar_border` | `#4E5566` | Thumb hover border |
| `--input_bg` | `#3C404D` | Input resting fill (combo, line edit, spinbox) |
| `--input_bg_hover` | `#1D1F26` | Input hover fill |
| `--input_bg_focus` | `#1D1F26` | Input focus fill |
| `--input_border` | `#5B6273` | Input resting border |
| `--input_border_width` | `1px` | Input border width |
| `--input_border_hover` | `#5B6273` | Input hover border |
| `--input_border_focus` | `#284CB8` | Input focus border |
| `--list_item_bg_selected` | `#284CB8` | Selected list/menu item bg |
| `--list_item_bg_hover` | `#476BD7` | Hovered list item bg |
| `--button_bg` | `#3C404D` | Button resting fill (aliases `--input_bg`) |
| `--button_bg_hover` | `#464B59` | Button hover fill |
| `--button_bg_down` | `#1D1F26` | Button pressed fill |
| `--button_bg_disabled` | `#272A33` | Button disabled fill |
| `--button_border_width` | `1px` | Button border width (= `--input_border_width`) |
| `--button_border` | `#3C404D` | Button resting border (= `--button_bg`, i.e. borderless look) |
| `--button_border_hover` | `#5B6273` | Button hover/focus border |
| `--button_border_focus` | `#5B6273` | Button focus border |
| `--tab_bg` | `#272A33` | Tab resting bg |
| `--tab_bg_hover` | `#464B59` | Tab hover bg |
| `--tab_bg_down` | `#284CB8` | Tab pressed bg |
| `--tab_bg_disabled` | `#272A33` | Tab disabled bg |
| `--tab_border` | `#3C404D` | Tab resting border |
| `--tab_border_hover` | `#5B6273` | Tab hover border |
| `--tab_border_focus` | `#718CDC` | Tab keyboard-focus border |
| `--tab_border_selected` | `#284CB8` | Tab selected border |
| `--palette_window` | `#1D1F26` | Qt palette `Window` |
| `--palette_windowText` | `#FFFFFF` | Qt palette `WindowText` |
| `--palette_base` | `#272A33` | Qt palette `Base` |
| `--palette_light` | `#4E5566` | Qt palette `Light` (= `--grey2`) |
| `--palette_mid` | `#1D1F26` | Qt palette `Mid` (= `--grey7`) |
| `--palette_dark` | `#272A33` | Qt palette `Dark` (= `--grey6`) |
| `--palette_highlight` | `#284CB8` | Qt palette `Highlight` |
| `--palette_highlightedText` | `#FFFFFF` | Qt palette `HighlightedText` |
| `--palette_text` | `#FFFFFF` | Qt palette `Text` |
| `--palette_link` | `#476BD7` | Qt palette `Link` (= `--blue2`) |
| `--palette_linkVisited` | `#476BD7` | Qt palette `LinkVisited` |
| `--palette_button` | `#3C404D` | Qt palette `Button` |
| `--palette_buttonText` | `#FFFFFF` | Qt palette `ButtonText` |
| `--palette_text_active` | `#FFFFFF` | Qt palette Text, `Active` group |
| `--palette_text_disabled` | `#969696` | Qt palette Text, `Disabled` group |
| `--palette_text_inactive` | `#FFFEFF` | Qt palette Text, `Inactive` group |

### 1.3 Layout / metric tokens (resolved)

| Variable | Resolved value | Description |
| --- | --- | --- |
| `--font_base_value` | `10` | Font scale (from `--obsFontScale`) |
| `--padding_base_value` | `4` | Density (from `--obsPadding`) |
| `--spacing_base_value` | `4` | `calc(2 + obsPadding/2)` |
| `--os_mac_font_base_value` | `12` | `calc(1.2 * obsFontScale)` |
| `--font_base` | `10pt` | Base font size |
| `--font_small` | `8pt` | Small font size |
| `--font_xsmall` | `6.75pt` | Extra-small font size |
| `--font_large` | `11pt` | Large font size |
| `--font_xlarge` | `15pt` | Extra-large font size (preview/program labels) |
| `--font_heading` | `25pt` | Heading font size |
| `--icon_base` | `16px` | Standard icon / indicator size |
| `--icon_small` | `14px` | Small icon size (mixer buttons) |
| `--spacing_base` | `2px` | Base spacing (internally `1.6px`, rounded) |
| `--spacing_large` | `4px` | Large spacing |
| `--spacing_small` | `1px` | Small spacing |
| `--spacing_title` | `4px` | Group-box title offset |
| `--padding_base` | `2px` | Base padding |
| `--padding_large` | `4px` | Large padding |
| `--padding_xlarge` | `7px` | Extra-large padding |
| `--padding_small` | `1px` | Small padding |
| `--padding_container` | `4px` | Container padding |
| `--padding_wide` | `16px` | Wide padding (button left/right) |
| `--padding_menu` | `12px` | Menu item horizontal padding |
| `--padding_menubar` | `7px` | Menu-bar item horizontal padding |
| `--padding_base_border` | `3px` | `--padding_base + 1px` |
| `--spacing_input` | `2px` | Vertical margin around inputs (= `--spacing_base`) |
| `--input_font_scale` | `22` | `fontScale * 2.2` |
| `--input_font_padding` | `8` | `padding * 2` |
| `--input_height_base` | `30` | Base control row height |
| `--input_height` | `22px` | Actual control inner height |
| `--input_height_half` | `15` | Half of `--input_height_base` |
| `--input_padding` | `4px` | Input vertical padding |
| `--input_text_padding` | `8px` | Input horizontal text padding |
| `--spinbox_width` | `38px` | Spinbox min width |
| `--spinbox_min_width` | `55px` | Spinbox absolute min width (overrides `--spinbox_width`) |
| `--spinbox_button_height` | `14px` | Spinbox up/down button height |
| `--preview_scale_width` | `28px` | Preview scale-percent label min width |
| `--volume_slider` | `4px` | Vertical-mixer slider groove width (internally `3.5px`) |
| `--volume_slider_box` | `14px` | Vertical-mixer slider box width |
| `--volume_slider_label` | `28px` | Mixer volume label min width |
| `--action_row_base` | `22.5` | Idian settings-row base height (unitless) |
| `--action_row_input_width` | `90` | Idian row input min width |
| `--action_row_padding` | `5px` | Idian row padding (internally `4.8px`) |
| `--action_row_padding_x` | `10px` | Idian row horizontal padding (internally `9.6px`) |
| `--action_row_padding_nested` | `14px` | Nested Idian row left padding (internally `14.4px`) |
| `--toggle_border` | `1` | Toggle switch border width |
| `--toggle_margin` | `3` | Toggle handle margin |
| `--toggle_width` | `36` | Toggle switch width |
| `--toggle_height` | `18` | Toggle switch height |
| `--toggle_handle` | `11.2` | Toggle handle diameter (unitless) |
| `--toggle_radius` | `9` | Toggle switch corner radius |

### 1.4 Variant overrides (for reference — not part of the default)

Only overrides are listed. `Yami_Default` overrides **nothing**.

**`Yami_Grey.ovt`** — greys only:
`--grey1: #616161`, `--grey2: #575757`, `--grey3: #4D4D4D`, `--grey4: #434343`, `--grey5: #393939`, `--grey6: #2F2F2F`, `--grey7: #212121`, `--grey8: #151515`.
(Note: quoted from `rgb(97,97,97)` etc.)

**`Yami_Classic.ovt`** — the "old OBS" look: `--grey1/2/3/4/5/6/7/8` → `#616161`/`#868786`/`#7A797A`/`#4C4C4C`/`#464546`/`#1F1E1F`/`#3A393A`/`#2E2D2E`; `--bg_window: var(--grey7)` = `#3A393A`; `--bg_preview: #4C4C4C`; `--primary: #19344C`; `--primary_light: #21476D`; `--primary_dark: #13283A`; `--border_radius: 2px`; `--border_radius_small: 1px`; `--border_radius_large: 2px`; `--input_height_base: max(…, 20)`; `--button_bg_disabled: var(--grey8)`; plus a large QSS body (dock titles centred, `QGroupBox` gets a border, `QMenu::item` padding `--padding_menu_y`, 1px tab pane, etc.).

**`Yami_Acri.ovt`** — blue/red "Acri" look: `--grey4: #162458`; `--grey6: #181819`; `--grey7: #101010`; `--grey8: #090909`; `--primary: #131A30`; `--primary_light: #2A3A75`; `--primary_dark: #161F41`; `--button_bg: #162458`; `--button_bg_red: #581624`; `--button_bg_red_hover: #742031`; `--button_bg_red_down: #3F151E`; `--scrollbar_hover: var(--primary_light)`; plus a QSS body.

**`Yami_Rachni.ovt`** — pink/cyan look: `--primary: #914C67`; `--primary_light: #00BCD4`; `--primary_lighter: #F06092`; `--primary_dark: #59424F`; `--primary_darker: #191B26`; `--bg_window: var(--grey4)`; `--bg_preview: #222528`; plus a QSS body (2px input borders, tinted toolbars).

**`Yami_Light.ovt`** — `dark: false`. Inverts the greys (`--grey1: #8C8C8C` … `--grey8: #C1C1C1`), sets `--text: var(--black1)`, `--primary: #8CB5FF`, `--primary_light: #B2CFFF`, `--primary_dark: #7AA4F3`, and re-points every icon to `theme:Light/…`.

### 1.5 Orphaned variables — **bug worth knowing**

`Yami_Classic.ovt`, `Yami_Acri.ovt` and `Yami_Rachni.ovt` reference five variables that **are not defined anywhere in the repository** (not in `Yami.obt`, not in `System.obt`, not in any other theme or C++ file):

`--toolbutton_bg`, `--toolbutton_bg_hover`, `--toolbutton_bg_down`, `--toolbutton_bg_disabled`, `--button_bg_red`, `--button_bg_red_hover`, `--button_bg_red_down`, `--dock_title_padding`, `--icon_base_mixer`, `--padding_menu_y`.

(Exact set found: `--toolbutton_bg`, `--toolbutton_bg_down`, `--toolbutton_bg_disabled`, `--button_bg_red`, `--button_bg_red_hover`, `--button_bg_red_down`, `--dock_title_padding`, `--icon_base_mixer`, `--padding_menu_y`. `--toolbutton_bg_hover`, `--button_bg_red` etc. are defined inside the .ovt var blocks that *do* exist for red, but `--toolbutton_bg*` is never defined.)

Because `PrepareQSS` only replaces needles for variables that exist, the literal text `var(--toolbutton_bg)` survives into the stylesheet handed to Qt, where it is an invalid value that Qt ignores. Net effect: **those variant themes are partially broken in this checkout.** This does not affect `Yami_Default`, which uses none of them.

Additionally, the variant QSS bodies use the selector `QPushButton[toolButton="true"]`, but `Yami.obt` never sets a `toolButton` property, so that selector never matches.

---

## 2. Mapping to CSS custom properties

Proposed `:root` block. Names are `--obs-*`, semantically grouped. Every value is the resolved `Yami_Default` value.

```css
:root {
  /* ============================================================
   * OBS Studio default dark theme (Yami / Yami_Default)
   * Resolved for FontScale = 10, Density = Normal (padding = 4)
   * ============================================================ */

  /* ---------- Surfaces ---------- */
  --obs-window-bg:        #1D1F26; /* --bg_window : dialogs, main window, menu bar, menus */
  --obs-panel-bg:         #272A33; /* --bg_base   : docks, lists, tables, group boxes, tooltips */
  --obs-preview-bg:       #13141A; /* --bg_preview: video canvas */
  --obs-dock-title-bg:    #323540; /* --grey5     : QDockWidget title bar */
  --obs-dock-title-border:#3C404D; /* --grey4     : QDockWidget title border */
  --obs-menu-bg:          #1D1F26; /* QMenu background (--bg_window) */
  --obs-tooltip-bg:       #272A33; /* QToolTip background (--bg_base) */

  /* ---------- Borders ---------- */
  --obs-border:           #3C404D; /* --border_color / --grey4 */
  --obs-border-width:     1px;
  --obs-border-input:     #5B6273; /* --input_border / --grey1 */
  --obs-border-input-hover:#5B6273;
  --obs-border-focus:     #284CB8; /* --input_border_focus / --primary */
  --obs-border-highlight: transparent; /* --border_highlight */
  --obs-highlight-width:  1px;     /* --highlight_width */
  --obs-highlight-color:  #718CDC; /* --highlight_color (keyboard focus) */

  /* ---------- Radii ---------- */
  --obs-radius:           4px;     /* --border_radius */
  --obs-radius-sm:        2px;     /* --border_radius_small */
  --obs-radius-lg:        6px;     /* --border_radius_large */

  /* ---------- Text ---------- */
  --obs-text:             #FFFFFF; /* --text */
  --obs-text-light:       #FFFFFF; /* --text_light */
  --obs-text-muted:       #969696; /* --text_muted */
  --obs-text-disabled:    #969696; /* --text_disabled */
  --obs-text-inactive:    #FFFEFF; /* --text_inactive */
  --obs-text-on-accent:   #FFFFFF; /* selection-color */

  /* ---------- Accent / primary blue ---------- */
  --obs-primary:          #284CB8; /* blue3 : selection, checked, active tab */
  --obs-primary-light:    #476BD7; /* blue2 : hover accent, slider fill, links */
  --obs-primary-lighter:  #718CDC; /* blue1 : focus accent, .text-bright */
  --obs-primary-dark:     #213E97; /* blue4 : pressed accent */
  --obs-primary-darker:   #1A3278; /* blue5 : deepest accent */
  --obs-primary-surface:  #162A64; /* blue6 : mixer category surface */

  /* ---------- Interaction states ---------- */
  --obs-hover-bg:         #464B59; /* --button_bg_hover / --grey3 */
  --obs-pressed-bg:       #1D1F26; /* --button_bg_down / --grey7 */
  --obs-disabled-bg:      #272A33; /* --button_bg_disabled / --grey6 */
  --obs-selection-bg:     #284CB8; /* --list_item_bg_selected / --primary */
  --obs-selection-hover-bg:#476BD7;/* --list_item_bg_hover / --primary_light */
  --obs-selection-border: #476BD7; /* selected item border (--primary_light) */
  --obs-focus-border:     #D2D2D2; /* --white3 : list-item focus ring */
  --obs-list-hover-bg:    #3C404D; /* --grey4 : list/menu item hover bg */
  --obs-list-hover-border:#464B59; /* --grey3 : list/menu item hover border */
  --obs-separator-hover:  #FFFFFF; /* --separator_hover */

  /* ---------- Inputs ---------- */
  --obs-input-bg:         #3C404D; /* --input_bg / --grey4 */
  --obs-input-bg-hover:   #1D1F26; /* --input_bg_hover */
  --obs-input-bg-focus:   #1D1F26; /* --input_bg_focus */
  --obs-input-border-hover:#5B6273;

  /* ---------- Buttons ---------- */
  --obs-button-bg:        #3C404D; /* --button_bg */
  --obs-button-bg-hover:  #464B59; /* --button_bg_hover */
  --obs-button-bg-down:   #1D1F26; /* --button_bg_down */
  --obs-button-bg-disabled:#272A33;/* --button_bg_disabled */
  --obs-button-border:    #3C404D; /* --button_border (= bg → borderless look) */
  --obs-button-border-hover:#5B6273;

  /* ---------- Tabs ---------- */
  --obs-tab-bg:           #272A33; /* --tab_bg */
  --obs-tab-bg-hover:     #464B59; /* --tab_bg_hover */
  --obs-tab-bg-down:      #284CB8; /* --tab_bg_down */
  --obs-tab-fg:           #969696; /* unselected tab text (--text_muted) */
  --obs-tab-fg-active:    #FFFFFF;
  --obs-tab-border-hover: #5B6273;
  --obs-tab-border-focus: #718CDC;
  --obs-tab-border-selected:#284CB8;

  /* ---------- Scrollbars ---------- */
  --obs-scrollbar-size:   12px;    /* --scrollbar_size */
  --obs-scrollbar-bg:     #272A33; /* --scrollbar_bg / --grey6 */
  --obs-scrollbar-handle: #3C404D; /* --scrollbar_handle / --grey4 */
  --obs-scrollbar-hover:  #464B59; /* --scrollbar_hover / --grey3 */
  --obs-scrollbar-active: #4E5566; /* --scrollbar_down / --grey2 */
  --obs-scrollbar-border: #4E5566; /* --scrollbar_border / --grey2 */

  /* ---------- Semantic status ---------- */
  --obs-success:          #25A231; /* green3 : .text-success */
  --obs-success-surface:  #0F4313; /* green6 : .bg-success */
  --obs-success-bright:   #59D966; /* green1 : meter nominal fg */
  --obs-warning:          #B88A16; /* yellow3 : .text-warning */
  --obs-warning-surface:  #493709; /* yellow6 : .bg-warning */
  --obs-warning-bright:   #EABC48; /* yellow1 : meter warning fg */
  --obs-error:            #C01C37; /* red3 : .text-danger */
  --obs-error-surface:    #590D1A; /* red6 : .bg-danger */
  --obs-error-bright:     #E85E75; /* red1 : meter error fg */
  --obs-info:             #0981B4; /* teal3 : .bg-secondary */
  --obs-info-bright:      #3DBEF5; /* teal1 : .text-secondary */
  --obs-info-surface:     #13141A; /* grey8 : .bg-info */

  /* ---------- Audio meter (VolumeMeter qproperties) ---------- */
  --obs-meter-nominal-bg:  #17641E; /* green5 */
  --obs-meter-warning-bg:  #6E520D; /* yellow5 */
  --obs-meter-error-bg:    #7D1224; /* red5 */
  --obs-meter-nominal-fg:  #37D247; /* green2 */
  --obs-meter-warning-fg:  #E5AF24; /* yellow2 */
  --obs-meter-error-fg:    #E33B57; /* red2 */
  --obs-meter-magnitude:   #000000; /* rgb(0,0,0) */
  --obs-meter-major-tick:  #969696; /* white5 */
  --obs-meter-minor-tick:  #5B6273; /* grey1 */
  --obs-meter-nominal-bg-disabled: #646464; /* black4 */
  --obs-meter-warning-bg-disabled: #828282; /* black5 */
  --obs-meter-error-bg-disabled:   #414141; /* black3 */
  --obs-meter-nominal-fg-disabled: #D2D2D2; /* white3 */
  --obs-meter-warning-fg-disabled: #D2D2D2; /* white3 */
  --obs-meter-error-fg-disabled:   #B4B4B4; /* white4 */

  /* ---------- Mixer category chips ---------- */
  --obs-mixer-category-bg:          #162A64; /* blue6 */
  --obs-mixer-category-fg:          #718CDC; /* blue1 */
  --obs-mixer-pinned-bg:            #1A3278; /* blue5 */
  --obs-mixer-hidden-bg:            #2E1A60; /* purple6 */
  --obs-mixer-hidden-fg:            #997FDC; /* purple1 */
  --obs-mixer-unassigned-bg:        #493709; /* yellow6 */
  --obs-mixer-unassigned-fg:        #EABC48; /* yellow1 */
  --obs-mixer-inactive-bg:          #13141A; /* grey8 */
  --obs-mixer-preview-bg:           #0F4313; /* green6 */
  --obs-mixer-preview-fg:           #59D966; /* green1 */

  /* ---------- Typography ---------- */
  --obs-font-family: 'Open Sans', '.AppleSystemUIFont', Helvetica, Arial,
                     'MS Shell Dlg', sans-serif;
  --obs-font-size:        10pt;    /* 13.333px @96dpi */
  --obs-font-size-small:  8pt;     /* 10.667px @96dpi */
  --obs-font-size-xsmall: 6.75pt;  /* 9px      @96dpi */
  --obs-font-size-large:  11pt;    /* 14.667px @96dpi */
  --obs-font-size-xlarge: 15pt;    /* 20px     @96dpi */
  --obs-font-size-heading:25pt;    /* 33.333px @96dpi */
  --obs-font-weight-normal: 400;
  --obs-font-weight-bold:   700;

  /* ---------- Metrics ---------- */
  --obs-icon:             16px;    /* --icon_base */
  --obs-icon-sm:          14px;    /* --icon_small */
  --obs-control-height:   22px;    /* --input_height */
  --obs-control-row-height:30px;   /* --input_height_base */
  --obs-spinbox-button-height:14px;/* --spinbox_button_height */
  --obs-spinbox-min-width:55px;    /* --spinbox_min_width */
  --obs-padding-base:     2px;
  --obs-padding-small:    1px;
  --obs-padding-large:    4px;
  --obs-padding-xlarge:   7px;
  --obs-padding-wide:     16px;
  --obs-padding-menu:     12px;
  --obs-padding-menubar:  7px;
  --obs-spacing-base:     2px;
  --obs-spacing-small:    1px;
  --obs-spacing-large:    4px;
}
```

---

## 3. Widget styling rules

All values below are **post-substitution literals** (as Qt actually receives them), with variable names in parentheses for traceability. Line numbers refer to `frontend/data/themes/Yami.obt`.

### 3.0 Global defaults

**`QWidget`** (L590–597) — applies to every widget as inheritance baseline:

| Property | Value |
| --- | --- |
| `alternate-background-color` | `#272A33` (`--bg_base`) |
| `color` | `#FFFFFF` (`--text`) |
| `selection-background-color` | `#284CB8` (`--primary`) |
| `selection-color` | `#FFFFFF` (`--text`) |
| `font-size` | `10pt` (`--font_base`) |
| `font-family` | `'Open Sans', '.AppleSystemUIFont', Helvetica, Arial, 'MS Shell Dlg', sans-serif` |

**`QWidget:disabled`** (L599–601): `color: #969696` (`--text_disabled`).

**Container windows** (L605–611): `QDialog`, `QMainWindow`, `QStatusBar`, `QMenuBar`, `QMenu` → `background-color: #1D1F26` (`--bg_window`).

**Framed widgets** (L650–657): any widget with `frameShape` 1–6 gets `border: 1px solid #272A33` (`--bg_base`).

**Utility classes** (L295–482): `.bg_window` → `#1D1F26`; `.bg-base` → `#272A33`; `.bg-primary` → `#284CB8`; `.bg-secondary` → `#0981B4` (`teal3`); `.bg-info` → `#13141A` (`grey8`); `.bg-warning` → `#493709` (`yellow6`); `.bg-danger` → `#590D1A` (`red6`); `.bg-success` → `#0F4313` (`green6`).
Text classes: `.text-title` `11pt`/bold; `.text-small` `8pt`; `.text-tiny` `6.75pt`; `.text-heading` `25pt`/bold; `.text-large` `11pt`; `.text-bold` bold; `.text-italic` italic; `.text-bright` `#718CDC`; `.text-muted` `#969696`; `.text-warning` `#B88A16`; `.text-danger` `#C01C37`; `.text-success` `#25A231`.

**`.dialog-container`** (L408): `padding: 4px 7px` (`--padding_large --padding_xlarge`).
**`.dialog-frame`** (L412): `background-color: #272A33` (`grey6`); `border-radius: 4px`; `border: 1px solid #3C404D`; `margin: 2px`.
**`.dialog-frame > QWidget`** (L419): `margin: 2px 0`.
**`.frame-notice`** (L397): `background: #13141A` (`grey8`); `border: 1px solid #272A33` (`grey6`); `border-radius: 4px`; `padding: 7px 4px`.
**`.subtitle`** (L423): `8pt`, bold, `#969696`.

---

### 3.1 `QPushButton` (L1494–1548)

| Property | Normal | Hover | Focus | Checked | Checked hover/focus | Pressed | Disabled |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `background-color` | `#3C404D` (`--button_bg`) | `#464B59` (`--button_bg_hover`) | — | `#284CB8` (`--primary`) | `#284CB8` | `#1D1F26` (`--button_bg_down`) | `#272A33` (`--button_bg_disabled`) |
| `color` | `#FFFFFF` | — | — | — | — | — | `#969696` (inherited `QWidget:disabled`) |
| `border` | `1px solid #3C404D` (`--button_border`) | `1px solid #5B6273` (`--button_border_hover`) | `1px solid #5B6273` | `1px solid #476BD7` (`--primary_light`) | `1px solid #718CDC` (`--primary_lighter`) | `1px solid #3C404D` | `1px solid #3C404D` |
| `border-radius` | `4px` | | | | | | |
| `height` / `max-height` | `22px` (`--input_height`) | | | | | | |
| `margin-top` / `margin-bottom` | `2px` (`--spacing_input`) | | | | | | |
| `padding` | `4px 16px` (`--input_padding --padding_wide`) | | | | | | |
| `icon-size` | `16px` (`--icon_base`) | | | | | | |
| `outline` | `none` | | | | | | |

* `QPushButton::flat` (L1517): `background-color: #3C404D`.
* `QPushButton::menu-indicator` (L1542): `image: url(theme:Dark/collapse.svg)`; `subcontrol-position: right`; `subcontrol-origin: content`; `margin-left: 4px`; `right: -2px`.
* **Primary CTA class `.button-primary` (L429–443)**: `background-color: #213E97` (`--primary_dark`); `border-color: #284CB8` (`--primary`); `outline: none`. Hover/focus → `background-color: #284CB8`, `border-color: #D2D2D2` (`--white3`); hover only → `border-color: #476BD7`.
* **Control-bar buttons (L1449–1489)**: `#streamButton`, `#recordButton`, `#replayBufferButton`, `#broadcastButton` → `padding: 4px`; `#pauseRecordButton`, `#saveReplayButton`, `#virtualCamConfigButton` → `padding: 4px 4px`, `width/max-width: 22px`. `.state-active` (not hovered/pressed) → `background: #284CB8`; `.state-active:hover` → `background: #476BD7`, `color: #FFFFFF`.
* `#contextContainer QPushButton` (L1114): `padding-left/right: 12px`.
* `QTableView QPushButton` (L2006): `padding: 0`; `margin: -1px`; `border-radius: 0`.
* `OBSBasicFilters #widget QPushButton` (L2038): `min-width: 16px`; `padding: 2px 4px`; `margin-top: 0`.
* `OBSHotkeyWidget QPushButton` (L2177): `min-width: 16px`; `padding: 2px`; `margin-top: 0`; `margin-left: 2px`.

---

### 3.2 `QToolButton` (L1550–1602)

| Property | Normal | Hover/Focus | Checked | Checked hover/focus | Pressed | Disabled |
| --- | --- | --- | --- | --- | --- | --- |
| `background-color` | `#3C404D` (`--button_bg`) | `#464B59` (`--button_bg_hover`) | `#284CB8` (`--primary`) | `#284CB8` | `#1D1F26` (`--button_bg_down`) | `#272A33` (`--button_bg_disabled`) |
| `border` | `1px solid #3C404D` | `1px solid #3C404D` (`--button_border`) | `1px solid #476BD7` | `1px solid #718CDC` | `1px solid #3C404D` | `1px solid transparent` |
| `padding` | `2px 2px` (`--padding_base`) | | | | | |
| `margin` | `0` | | | | | |
| `border-radius` | `4px` | | | | | |
| `icon-size` | `16px` (`--icon_base`) | | | | | |

The same rules are duplicated for the `.btn-tool` class (`QToolButton, .btn-tool { … }` L1554). `QToolButton:last-child` / `.btn-tool:last-child` → `margin-right: 0px`.
Standalone `QToolButton` (L1550) alone sets `border: 1px solid #3C404D`.

**Docked toolbar variant `OBSDock QToolBar QToolButton` (L895–911)**: `background: transparent`; `border: 1px solid transparent`; `margin: 1px`; `margin-top: 2px`; `padding: 4px`; `max-width: 14px`; `max-height: 14px`. Hover → `border-color: #5B6273` (`grey1`). Disabled → `background: #1D1F26` (`grey7`).

**`QTabBar QToolButton` (L1223)**: `background: #272A33` (`--tab_bg`); `min-width: 16px`; `padding: 0px`.

**`QCalendarWidget QToolButton` (L2317–2352)**: `background-color: #3C404D`; `padding: 2px 16px`; `border-radius: 4px`; `margin: 2px`. Hover → `background-color: #464B59`; pressed → `background-color: #1D1F26`. Prev/next month buttons `padding: 1px`, `icon-size: 16px`, icons `theme:Dark/left.svg` / `theme:Dark/right.svg`.

---

### 3.3 `QComboBox` / `QDateTimeEdit` (L1231–1304)

| Property | Value |
| --- | --- |
| `background-color` | `#3C404D` (`--input_bg`) |
| `border` | `1px solid #3C404D` (`--input_bg`) |
| `border-radius` | `4px` |
| `padding` | `4px 8px` (`--input_padding --input_text_padding`) |
| `height` | `22px` (`--input_height`) |
| `margin-top`/`margin-bottom` | `2px` (`--spacing_input`) |

**States:**
* `:hover`, `:focus`, `QDateTimeEdit:selected` → `border-color: #5B6273` (`--input_border_hover`).
* `:on` (popup open) → `background-color: #1D1F26` (`--input_bg_focus`); `border-color: #284CB8` (`--input_border_focus`); `border-bottom-left-radius: 0`; `border-bottom-right-radius: 0`.
* `:editable:hover` → `background-color: #1D1F26` (`--input_bg_hover`); `border-color: #5B6273`.
* `:editable:focus` → `background-color: #1D1F26`; `border-color: #284CB8`.
* `QDateTimeEdit:on` (L2306) → `background-color: #1D1F26` (`grey7`).

**`::drop-down`** (L1267): `border: none`; `border-left: 1px solid #272A33` (`grey6`); `width: 22px` (`--input_height`). `:editable` variant adds `border-top-right-radius: 4px`; `border-bottom-right-radius: 4px`.
**`::down-arrow`** (L1274): `qproperty-alignment: AlignTop`; `image: url(theme:Dark/collapse.svg)`; `width: 100%`.

**Popup `QComboBox QAbstractItemView`** (L1240): `padding: 2px 4px` (`--spacing_base --spacing_large`); `border: 1px solid #3C404D` (`--border_color`); `outline: none`.
**`::item`** (L1246): `padding: 4px 7px` (`--padding_large --padding_xlarge`).
**`::item:selected`, `::item:hover`** (L1250): `background-color: #284CB8` (`--list_item_bg_selected`).

**Idian-row override `idian--Row QComboBox` (L2664–2708)**: `background-color: transparent`; `min/max-height: 22.5`; `min-width: 90px`; `border: 1px solid transparent`; `padding: 0 0 0 7px`; `margin: 0`. `.hover` → `border-color: #5B6273`; `.keyFocus` → `border-color: #718CDC`. `::drop-down` → `border: none`; `::down-arrow` → `url(theme:Dark/collapse.svg)`.

---

### 3.4 `QSpinBox` / `QDoubleSpinBox` (L1348–1442)

| Property | Value |
| --- | --- |
| `background-color` | `#3C404D` (`--input_bg`) |
| `border` | `1px solid #3C404D` (`--input_border_width` solid `--input_bg`) |
| `border-radius` | `4px` |
| `padding` | `4px 2px 4px 8px` (`--input_padding --padding_base --input_padding --input_text_padding`†) |
| `height` | `22px` (`--input_height`) |
| `max-height` | `22px` |
| `min-width` | `55px` (`--spinbox_min_width`, declared last so it wins over the earlier `--spinbox_width` = `38px`) |
| `margin-top`/`margin-bottom` | `2px` (`--spacing_input`) |

† Source declares `padding: var(--input_padding) var(--input_text_padding);` then `padding-right: var(--padding_base);` → `4px 2px 4px 8px` in CSS shorthand order (top/right/bottom/left), i.e. left = 8px, right = 2px.

**States:** `:hover` → `background-color: #1D1F26` (`--input_bg_hover`), `border-color: #5B6273`; `:focus` → `background-color: #1D1F26`, `border-color: #284CB8`.

**`::up-button` / `::down-button`** (L1374–1400): `subcontrol-origin: padding`; `width: 22px` (`--input_height`); `height: 14px` (`--spinbox_button_height`); `border-left: 1px solid #272A33` (`grey6`); up-button: `border-bottom: 1px solid transparent`, `border-radius: 0`, `border-top-right-radius: 2px`; down-button: `border-top: 1px solid #272A33`, `border-radius: 0`, `border-bottom-right-radius: 2px`.
Position: up-button `top right`, down-button `bottom right`.

**Button states:** `:hover` → `background-color: #464B59` (`--button_bg_hover`); `:pressed` → `background-color: #1D1F26` (`--button_bg_down`); `:disabled`, `:off` → `background-color: #272A33` (`--button_bg_disabled`).

**Arrows:** `up-arrow` → `image: url(theme:Dark/up.svg)`, `width: 100%`, `margin: 2px`; `down-arrow` → `image: url(theme:Dark/down.svg)`, `width: 100%`, `padding: 2px`.

---

### 3.5 `QLineEdit` / `QTextEdit` / `QPlainTextEdit` (L1308–1344)

| Property | Value |
| --- | --- |
| `background-color` | `#3C404D` (`--input_bg`) |
| `border` | `1px solid #3C404D` (last declaration wins; an earlier `border: none` is overridden) |
| `border-radius` | `4px` |
| `padding` | `4px 8px` (`--input_padding --input_text_padding`) |
| `height` | `22px` (`--input_height`) |

**States:** `:hover` → `background-color: #1D1F26` (`--input_bg_hover`), `border-color: #5B6273`; `:focus` → `background-color: #1D1F26` (`--input_bg_focus`), `border-color: #284CB8` (`--input_border_focus`).
**`:read-only`** (all of `:read-only`, `:read-only:hover`, `:read-only:focus`) → `background-color: transparent`; `border-color: #3C404D` (`--input_bg`).
**`QTextEdit:!editable`** (and hover/focus) → `background-color: #3C404D` (`--input_bg`).

**`QListWidget QLineEdit` / `QListView QLineEdit` (L843–855)**: `padding: 0 0 1px 0`; `margin: 0`; `border: 1px solid #FFFFFF` (`--white1`); `border-radius: 4px`. `:focus` → `border: 1px solid #5B6273` (`grey1`).
**`QTableView QLineEdit` (L2000)**: `background: #1D1F26` (`--input_bg_focus`); `padding: 0`; `margin: 0`.

---

### 3.6 `QCheckBox` (L631–664, L2070–2116)

`QCheckBox` itself: `background: transparent`; `spacing: 1px` (`--spacing_small`); `margin-top`/`margin-bottom: 2px` (`--spacing_input`).

**Indicator** (shared with `QGroupBox::indicator` and `QTableView::indicator`, L2070–2116):

| Property | Value |
| --- | --- |
| `width` / `height` | `16px` (`--icon_base`) |
| `margin-right` | `4px` (`--spacing_large`) |
| `QGroupBox::indicator` extra | `margin-left: 2px` |

| State | Image |
| --- | --- |
| `:unchecked` | `theme:Yami/checkbox_unchecked.svg` (stroke `#B0AFB3`, 8u) |
| `:unchecked:hover` | `theme:Yami/checkbox_unchecked_focus.svg` (stroke `#FFFFFF`, 12u) |
| `:checked` | `theme:Yami/checkbox_checked.svg` (stroke `#B0AFB3`, 8u box + 12u tick) |
| `:checked:hover` | `theme:Yami/checkbox_checked_focus.svg` (stroke `#FFFFFF`, 12u box + 20u tick) |
| `:checked:disabled` | `theme:Yami/checkbox_checked_disabled.svg` (stroke `#4A4C53`, 8u/12u) |
| `:unchecked:disabled` | `theme:Yami/checkbox_unchecked_disabled.svg` (stroke `#4A4C53`, 8u) |

Note the SVG colours (`#B0AFB3`, `#FFFFFF`, `#4A4C53`) are **hard-coded in the SVG files**, not theme variables.

**Icon-checkbox class `.checkbox-icon` (L2119–2138)**: `outline: none`; `background: transparent`; `max-width/max-height: 16px`; `padding: 2px`; `margin-right: 4px`; `border: 1px solid transparent`; `border-radius: 4px`. `:hover`, `:focus` → `border-color: #718CDC` (`--primary_lighter`). `::indicator` → `16px × 16px`.

**Specialised indicators:**
* `.indicator-lock` (L2142): checked → `theme:Dark/locked.svg`; unchecked → `:res/images/unlocked.svg`.
* `.indicator-visibility` (L2154): checked → `theme:Dark/visible.svg`; unchecked → `:res/images/invisible.svg`.
* `.indicator-expand` (L2187): checked → `theme:Dark/expand.svg`; unchecked → `theme:Dark/collapse.svg`.
* `SourceTree .indicator-expand` (L798): `margin-right: 4px`; `margin-left: 0`.
* `SourceTreeItem .checkbox-icon` (L793): `margin-right: 0`; `margin-left: 4px`.

---

### 3.7 `QRadioButton` (L662)

**Only styling present:**

```css
QRadioButton {
    background: transparent;   /* from the QLabel, QGroupBox, QCheckBox group */
    spacing: 1px;              /* --spacing_small, from the QCheckBox/QGroupBox/QMenuBar/QRadioButton group */
}
```

**There is no `QRadioButton::indicator` rule anywhere in the repository.** The radio indicator is therefore drawn by the active Qt base style (`Fusion` on Linux, `windowsvista` on Windows, native on macOS) using the **QPalette** — including `--palette_base`, `--palette_text`, `--palette_highlight`, `--palette_button`. See §6. For a 1:1 web reproduction you must hand-author a radio that matches Fusion's rendering, or accept a deviation.

---

### 3.8 `QSlider` (L1606–1679)

| Part | Property | Value |
| --- | --- | --- |
| `::groove` | `background-color` | `#3C404D` (`grey4`) |
| | `border` | `none` |
| | `border-radius` | `2px` |
| `::groove:horizontal` | `height` | `4px` |
| `::groove:vertical` | `width` | `4px` |
| `::sub-page:horizontal` | `background-color` | `#476BD7` (`blue2`) — the *filled* portion left of the handle |
| | `border-radius` | `2px` |
| `::add-page:vertical` | `background-color` | `#476BD7` (`blue2`) — the *filled* portion below the handle |
| | `border-radius` | `2px` |
| `::sub-page:horizontal:disabled` | `background-color` | `#3C404D` (`grey4`) |
| `::add-page:horizontal:disabled` | `background-color` | `#1D1F26` (`grey7`) |
| `::add-page:vertical:disabled` | `background-color` | `#3C404D` (`grey4`) |
| `::sub-page:vertical:disabled` | `background-color` | `#1D1F26` (`grey7`) |
| `::handle` | `background-color` | `#FFFFFF` (`white1`) |
| | `border-radius` | `4px` |
| `::handle:horizontal` | `height` / `width` | `10px` / `20px` |
| | `margin` | `-3px 0` |
| `::handle:vertical` | `width` / `height` | `10px` / `20px` |
| | `margin` | `0 -3px` |
| `::handle:hover` | `background-color` | `#B4B4B4` (`white4`) |
| `::handle:pressed` | `background-color` | `#D2D2D2` (`white3`) |
| `::handle:disabled` | `background-color` | `#969696` (`white5`) |

**Studio-mode T-bar `.slider-tbar` (L2254–2270)**: `height: 24px`; `::groove:horizontal` → `height: 8px`; `::sub-page:horizontal` → `background: #476BD7` (`blue2`); `::handle:horizontal` → `width: 12px`, `height: 24px`, `margin: -24px 0px`.

**Mixer slider overrides**: `#hVolumeWidgets VolumeControl QSlider` (L1884) → `margin: 4px 0`; `::groove:horizontal` → `background: #1D1F26` (`--bg_window`), `height: 4px` (`--volume_slider`, from `3.5px`). `#vMixerScrollArea VolumeControl QSlider` (L1911) → `width: 14px` (`--volume_slider_box`), `margin: 0 7px`; `::groove:vertical` → `background: #1D1F26`, `width: 4px`.

---

### 3.9 `QScrollBar` (L1006–1104)

| Property | Value |
| --- | --- |
| `background-color` | `#272A33` (`--scrollbar_bg`, `grey6`) |
| `margin` | `0px` |
| `border-radius` | `4px` |
| `border` | `1px solid #272A33` (`grey6`) |
| `QScrollBar:vertical` `width` | `12px` (`--scrollbar_size`) |
| `QScrollBar:horizontal` `height` | `12px` (`--scrollbar_size`) |

**Lines/arrows/pages are all suppressed:** `::add-line`, `::sub-line` (vertical → `height: 0px`; horizontal → `width: 0px`) all `border: none; background: none`. `::up-arrow`, `::down-arrow`, `::left-arrow`, `::right-arrow`, `::add-page`, `::sub-page` → `border: none; background: none; color: none`.

**`::handle`** (L1058): `background-color: #3C404D` (`--scrollbar_handle`, `grey4`); `margin: 2px`; `border-radius: 2px` (`--border_radius_small`); `border: 1px solid #3C404D`.
`::handle:vertical` → `min-height: 32px`; `::handle:horizontal` → `min-width: 32px`.
`::handle:hover` → `background-color: #464B59` (`--scrollbar_hover`), `border-color: #4E5566` (`--scrollbar_border`).
`::handle:pressed` → `background-color: #4E5566` (`--scrollbar_down`), `border-color: #4E5566`.
`::handle:disabled` → `background: transparent`, `border-color: transparent`.

**`::corner`** (L1013): `background-color: #1D1F26` (`--bg_window`), `border: none`.

**Settings dialog** (L859–866): `OBSBasicSettings QScrollBar:vertical` → `width: 21px` (`--settings_scrollbar_size`), `margin-left: 9px`; horizontal → `height: 21px`.
**Dock** (L1088–1104): `OBSDock QScrollBar` → `border-radius: 0`; horizontal → `border-top: 1px solid #3C404D`; vertical → `border-left: 1px solid #3C404D`. `OBSDock QListWidget::corner` → `background: transparent`, `border-top/left: 1px solid #3C404D`.

**Preview scrollbars** `#previewXScrollBar`, `#previewYScrollBar` (L2461–2480): `background: transparent`; `border: 1px solid #272A33` (`grey6`); `border-radius: 0`; `#previewXScrollBar` → `border-left: none`, `height: 16px`; `#previewYScrollBar` → `width: 16px`; `::handle` → `margin: 3px`.

---

### 3.10 `QMenuBar` / `QMenu` (L609, 693–724, 756–784)

**`QMenuBar`** (L608): `background-color: #1D1F26` (`--bg_window`); `spacing: 1px` (`--spacing_small`).
**`QMenuBar::item`** (L717): `background-color: transparent`; `padding: 4px 7px` (`--padding_large --padding_menubar`).
**`QMenuBar::item:selected`** (L722): `background: #284CB8` (`--primary`).

**`QMenu`** (L609): `background-color: #1D1F26` (`--bg_window`). From the `QListView, QListWidget, QMenu` group (L744): `padding: 2px` (`--spacing_base`); `outline: none`. From L780: `border: 1px solid #3C404D` (`--border_color`); `padding: 2px`.
**`QMenu::item`, `QMenu > QWidget`** (L756): `padding: 4px 12px`; `padding-right: 20px`. Plus (L766): `border-radius: 4px`; `color: #FFFFFF`; `border: 1px solid transparent`.
**`QMenu::item:selected`** (L803): `background-color: #284CB8` (`--primary`); `border-color: #476BD7` (`--primary_light`).
**`QMenu::item:hover`** (L811): `background: #3C404D` (`grey4`); `border: 1px solid #464B59` (`grey3`).
**`QMenu::item:focus`**, `:selected:focus` (L818): `border: 1px solid #D2D2D2` (`white3`).
**`QMenu::item:selected:hover`** (L827): `background: #476BD7` (`--primary_light`); `border: 1px solid #718CDC` (`--primary_lighter`); `color: #FFFFFF`.
**`QMenu::item:disabled`** (L707): `color: #969696` (`--text_disabled`); `background: transparent`.
**`QMenu::separator`** (L701): `background: #3C404D` (`--border_color`); `height: 1px`; `margin: 2px 4px` (`--spacing_base --spacing_large`).
**`QMenu::icon`** (L697): `left: 7px` (`--padding_xlarge`). **`QMenu::indicator`** (L693): `left: 4px` (`--padding_large`).
**`QMenu::right-arrow`** (L712): `image: url(theme:Dark/expand.svg)`.
**`QMenu > QWidget`** (L762): `outline: none`.
`QMenu > QMenu` (L781): same border/padding as `QMenu`.

---

### 3.11 `QTabWidget` / `QTabBar` (L1152–1227)

| Selector | Property | Value |
| --- | --- | --- |
| `QTabWidget::pane` | `border-top` | `4px solid #272A33` (`--tab_bg`) |
| `QTabWidget::tab-bar` | `alignment` | `left` |
| `QTabBar` | `outline` | `none` |
| | `font-size` | `8pt` (`--font_small`) |
| `QTabBar::top` / `::tab:top` | radius | `border-top-left-radius: 4px`; `border-top-right-radius: 4px` |
| `QTabBar::bottom` / `::tab:bottom` | radius | `border-bottom-left-radius: 4px`; `border-bottom-right-radius: 4px` |

**`QTabBar::tab`** (L1185): `background: #272A33` (`--tab_bg`); `color: #969696` (`--text_muted`); `border: 1px solid #272A33` (`--tab_bg`); `padding: 4px 16px` (`--tab_padding_base --tab_padding_large`); `min-width: 50px`; `margin: 1px 0px`; `margin-right: 2px`.

| State | Property | Value |
| --- | --- | --- |
| `:pressed` | `background` | `#284CB8` (`--tab_bg_down`) |
| `:hover` | `background` / `border-color` / `color` | `#464B59` / `#5B6273` / `#FFFFFF` |
| `:focus` | `border-color` | `#718CDC` (`--tab_border_focus`) |
| `:selected` | `background` / `color` / `border` | `#284CB8` (`--primary`) / `#FFFFFF` / `1px solid #476BD7` (`--primary_light`) |
| `:top` | `margin-bottom` | `0px` |
| `:bottom` | `margin-top` | `0px` |

`QTabBar QToolButton` (L1223): `background: #272A33` (`--tab_bg`); `min-width: 16px`; `padding: 0px`.

---

### 3.12 `QListWidget` / `QListView` / `QAbstractItemView` (L668, 736–855)

| Selector | Property | Value |
| --- | --- | --- |
| `QAbstractItemView` | `background-color` | `#272A33` (`--bg_base`) |
| `QListView, QListWidget, QMenu` | `padding` | `2px` (`--spacing_base`) |
| | `outline` | `none` |
| `QListWidget` | `border-radius` | `4px` |
| `QListView QWidget, QListWidget QWidget` | `margin-top/bottom` | `0` |

**Items** (L751, 766, 787):
```css
QListWidget::item, SourceTreeItem {
    padding: 4px 4px;            /* --padding_large --padding_large */
    min-height: 12px;            /* --padding_menu */
}
QListView::item, QListWidget::item {
    border-radius: 4px;
    color: #FFFFFF;
    border: 1px solid transparent;
}
```
`QListWidget::item` (L740) alone: `color: #FFFFFF` (`--text`).

| State | Property | Value |
| --- | --- | --- |
| `::item:selected` | `background-color` / `border-color` | `#284CB8` (`--primary`) / `#476BD7` (`--primary_light`) |
| `::item:hover` | `background` / `border` | `#3C404D` (`grey4`) / `1px solid #464B59` (`grey3`) |
| `::item:focus`, `::item:selected:focus` | `border` | `1px solid #D2D2D2` (`white3`) |
| `::item:selected:hover` | `background` / `border` / `color` | `#476BD7` (`--primary_light`) / `1px solid #718CDC` (`--primary_lighter`) / `#FFFFFF` |
| `::item:disabled`, `::item:disabled:hover` | `background` / `color` | `transparent` / `#969696` (`--text_disabled`) |

**SceneTree grid mode** (L2229–2250):
* `.list-grid SceneTree::item` → `color: #FFFFFF`; `background-color: #3C404D` (`--button_bg`); `border-radius: 4px`; `margin: 2px`.
* `:selected` → `#284CB8` (`--list_item_bg_selected`); `:checked` → `#284CB8` (`--primary`); `:hover` → `#476BD7` (`--list_item_bg_hover`); `:selected:hover` → `#476BD7`.
* `SceneTree` (L2224): `qproperty-gridItemWidth: 154`; `qproperty-gridItemHeight: 30` (`--input_height_base`).

---

### 3.13 `QTreeView` / `QTreeWidget` / `QHeaderView` / `QTableView`

**`QTreeView` / `QTreeWidget`: there is no rule at all in `Yami.obt`.** They inherit `QAbstractItemView { background-color: #272A33 }` (L668) and the generic `QWidget` defaults; branch indicators, expand/collapse arrows and tree lines are drawn by the base Qt style (§6). Only the OBS-specific `SceneTree` / `SourceTree` subclasses (which derive from `QTreeView`-like widgets) receive styling via `SceneTree` / `SourceTreeItem` selectors above.

**`QHeaderView::section` (L2013)**:

| Property | Value |
| --- | --- |
| `background-color` | `#3C404D` (`--button_bg`) |
| `color` | `#FFFFFF` (`--text`) |
| `border` | `none` |
| `border-left` / `border-right` | `1px solid #1D1F26` (`--bg_window`) each |
| `padding` | `3px 0px` |
| `margin-bottom` | `2px` |

**`QTableView` (L1990)**: `background: #272A33` (`--bg_base`); `gridline-color: #5B6273` (`grey1`).
`QTableView::item` → `margin: 0px`; `padding: 0px`.
`QTableView QPushButton`, `QTableView QToolButton` → `padding: 0px`; `margin: -1px`; `border-radius: 0px`.
`QTableView::indicator` → shares the 16px checkbox indicator rules (§3.6).

`OBSBasicStats` (L2415) → `background: #272A33`; `OBSBasicAdvAudio #scrollAreaWidgetContents` (L2420) → `background: #272A33`.

---

### 3.14 `QGroupBox` (L988–1001, L2078)

| Property | Value |
| --- | --- |
| `background` | `#272A33` (`--bg_base`) |
| `border-radius` | `4px` |
| `border` | **none** (the base theme does not draw a border) |
| `padding-top` | `30px` (`--input_height_base`) |
| `padding-bottom` | `4px` (`--padding_large`) |
| `font-weight` | `bold` |
| `margin-bottom` | `4px` (`--spacing_large`) |
| `spacing` | `1px` (`--spacing_small`) |

**`QGroupBox::title`** (L997): `subcontrol-origin: margin`; `left: 4px` (`--spacing_title`); `top: 4px`.
**`QGroupBox::indicator`** (L2070–2116): `16px × 16px`; `margin-right: 4px`; `margin-left: 2px`; checkbox SVG set (see §3.6).

> The `Classic` variant adds `border: 1px solid #3C404D` and swaps the background to `--bg_window`.

---

### 3.15 `QSplitter`

**There is no `QSplitter` or `QSplitter::handle` rule in `Yami.obt`.** Splitter handles are drawn by the base Qt style with the `QPalette` and the style's default `PM_SplitterWidth` (Fusion default = **4px** on Linux; `1px` under `windowsvista`). For the main-window dock separators OBS relies on `QMainWindow::separator`:

* **`QMainWindow::separator` (L615)**: `background: transparent`; `width: 4px` (`--spacing_large`); `height: 4px`; `margin: 0px`.
* **`QMainWindow::separator:hover` (L622)**: `border: 1px solid #FFFFFF` (`--separator_hover`); `margin: 1px`.

This is one of the OS/base-style-derived surfaces (see §6). A web reproduction should use a 4px transparent separator that turns into a 1px `#FFFFFF` outline on hover.

---

### 3.16 `QDockWidget` (L921–960)

**`QDockWidget`** (L921): `font-size: 8pt` (`--font_small`); `font-weight: bold`; `color: #FFFFFF` (`--text_light`); `titlebar-close-icon: url(theme:Dark/close.svg)`; `titlebar-normal-icon: url(theme:Dark/popout.svg)`.

**`QDockWidget::title`** (L930): `text-align: left`; `background-color: #323540` (`grey5`); `border: 1px solid #3C404D` (`grey4`); `padding: 2px 4px` (`--padding_base --padding_large`); `border-top-left-radius: 4px`; `border-top-right-radius: 4px`.

**`QDockWidget::close-button`, `::float-button`** (L939): `border: none`; `border-radius: 4px`; `background: transparent`; `margin-right: 1px`; `min-width/min-height: 16px` (`--icon_base`); `icon-size: 16px`; `padding: 2px` (`--padding_base`).
`:hover` → `background: #464B59` (`--button_bg_hover`).
`:pressed` → `background: #1D1F26` (`--button_bg_down`); `padding: 1px -1px -1px 1px`.

**`OBSDock > QWidget`** (L878): `background: #272A33` (`--bg_base`); `border-bottom-left-radius: 4px`; `border-bottom-right-radius: 4px`; `border: 1px solid #3C404D`; `border-top: none`.
**`OBSDock QToolBar`** (L886): `padding: 1px`; `margin: 0px`; `height: 32px`; `max-height: 32px`; `border-top: 1px solid #3C404D`; `spacing: 0`.
**`OBSDock QLabel`** (L917): `background: transparent`.

---

### 3.17 `QStatusBar` (L607, 974–984, 1984)

* `QStatusBar` (L607): `background-color: #1D1F26` (`--bg_window`).
* **`OBSBasicStatusBar`** (L974): `margin-top: 4px` (`--spacing_large`); `border-top: 1px solid #3C404D` (`--border_color`); `background: #272A33` (`--bg_base`). (Comment in source explains the margin is used to counteract Qt's forced internal padding.)
* **`StatusBarWidget > QFrame`** (L980): `border: 0px solid #3C404D`; `border-left-width: 1px`; `padding: 0px 7px 1px` (`0 --padding_xlarge --padding_small`).
* **`QStatusBar::item`** (L1984): `border: none`.

---

### 3.18 `QProgressBar` (L678–689)

| Selector | Property | Value |
| --- | --- | --- |
| `QProgressBar` | `text-align` | `center` |
| | `border-radius` | `4px` (hard-coded, not a variable) |
| | `border-top` | `2px solid transparent` |
| `QProgressBar::chunk` | `background` | `#284CB8` (`blue3`) |
| | `border-top` | `1px solid #476BD7` (`blue2`) |
| | `border-bottom` | `2px solid #213E97` (`blue4`) |
| | `border-radius` | `2px` (`--border_radius_small`) |

The trough background is not set here, so it falls back to the `QWidget` background / palette `Base` (`#272A33`).

---

### 3.19 `QDialog` / `QDialogButtonBox` (L605, 408–421, 2410)

* `QDialog` (L605): `background-color: #1D1F26` (`--bg_window`).
* `.dialog-container` (L408): `padding: 4px 7px`.
* `.dialog-frame` (L412): `background-color: #272A33` (`grey6`); `border-radius: 4px`; `border: 1px solid #3C404D`; `margin: 2px`.
* `.dialog-frame > QWidget` (L419): `margin: 2px 0`.
* `QDialogButtonBox` (L2410): `dialogbuttonbox-buttons-have-icons: 0` — explicitly **disables** icons on standard dialog buttons.

---

### 3.20 `QToolTip` (L672)

| Property | Value |
| --- | --- |
| `background-color` | `#272A33` (`--bg_base`, `grey6`) |
| `color` | `#FFFFFF` (`--text`) |
| `border` | `none` |

No border radius, no padding override → Qt default padding with a hard square `#272A33` box.

---

### 3.21 Mixer / volume meters (L1681–1980)

**Containers:**
* `#stackedMixerArea` (L1681): `border: none`; `padding: 0px`.
* `VolumeControl`, `VolumeMeter` (L1799): `background: #272A33` (`--bg_base`).
* `.mixer-category` (L1686): `color: #969696` (`--text_muted`); `margin: 0`; `padding: 0`; `text-align: center`.
* `VolumeControl .mixer-category` (L1946): `font-weight: bold`; `background: #162A64` (`blue6`); `color: #718CDC` (`blue1`).

**Category colour states** (L1952–1975):

| Class | Background | Text |
| --- | --- | --- |
| `.volume-pinned` | `#1A3278` (`blue5`) | `#FFFFFF` (`--text_light`) |
| `.volume-hidden` | `#2E1A60` (`purple6`) | `#997FDC` (`purple1`) |
| `.volume-unassigned` | `#493709` (`yellow6`) | `#EABC48` (`yellow1`) |
| `.volume-inactive` | `#13141A` (`grey8`) | `#969696` (`--text_muted`) |
| `.volume-preview` | `#0F4313` (`green6`) | `#59D966` (`green1`) |

**Inactive volume control** (L1936): `VolumeControl.volume-inactive`, `VolumeControl.volume-inactive VolumeMeter` → `background: #1D1F26` (`grey7`). `.volume-hidden .mixer-name`, `.volume-inactive .mixer-name` → `color: #969696`.
`#stackedMixerArea VolumeControl.volume-hidden QSlider::groove`, `…volume-inactive QSlider::groove` (L1977) → `background: #13141A` (`grey8`).

**Volume name / label:**
* `VolumeName` (L1827): `background: transparent`; `padding: 2px 0`; `border: 1px solid transparent`.
* `VolumeName QLabel` (L1833): `font-size: 8pt` (`--font_small`).
* `VolumeName:focus` (L1837) → `border: 1px solid #5B6273` (`--button_border_hover`).
* `VolumeName:hover` (L1841) → `background: #464B59` (`--button_bg_hover`); `border: 1px solid #5B6273`.
* `VolumeControl #volLabel` (L1846): `min-width: 48px`; `padding: 2px 0px`; `text-align: center`; `font-size: 8pt`; `color: #969696`.

**Mute / monitor buttons `.btn-mute`, `.btn-monitor`** (L1695–1785):
Base: `width/height: 14px` (`--icon_small`); `background-color: transparent`; `padding: 3px 3px` (`--padding_base_border`); `margin: 0px 1px` (`0 --spacing_small`); `border: 1px solid transparent` (`--highlight_width`); `border-radius: 4px`; `icon-size: 14px`.
`:checked` → `background-color: transparent`; `border-color: transparent`.
`:hover` → `background-color: #464B59` (`--button_bg_hover`); `border-color: transparent`.
`:pressed` → `background-color: #1D1F26` (`--button_bg_down`).

`.btn-mute` → `color: #FFFFFF`; icon `theme:Dark/settings/audio.svg`.
`.btn-mute.checked` → `color: #C01C37` (`red3`); `background: transparent`; icon `theme:Dark/mute.svg`.
`.btn-mute.checked.hover` → `color: #E33B57` (`red2`); `background: #13141A` (`grey8`); `border-color: #E85E75` (`red1`).
`.btn-mute.checked:focus` → `border-color: #E85E75`.
`.btn-mute.mute-warning` → `color: #EABC48` (`yellow1`); `background: #493709` (`yellow6`); icon `theme:Dark/unassigned.svg`.
`.btn-mute.mute-warning.hover`, `:focus` → `border-color: #EABC48`.

`.btn-monitor` → `background: transparent`; icon `theme:Dark/headphones-off.svg`.
`.btn-monitor:focus` → `border-color: #E85E75` (`red1`).
`.btn-monitor.checked` → `background: #1E8528` (`green4`); `color: #FFFFFF` (`--text_light`); icon `theme:Dark/headphones.svg`.
`.btn-monitor.checked:focus` → `color: #FFFFFF`; `border-color: #59D966` (`green1`).
`.btn-monitor.checked:hover` → `background: #25A231` (`green3`); `border-color: #59D966`; `color: #FFFFFF`.

`.toggle-hidden:checked` → `background: #3D2380` (`purple5`); `border-color: #5B34BF` (`purple3`).
`.toggle-hidden:disabled` → `background: transparent`; `border-color: transparent`.

**`VolumeMeter` qproperties** (L1804–1825) — these drive the actual meter drawing (not QSS colours):

| Property | Value |
| --- | --- |
| `color` | `#464B59` (`grey3`) |
| `font-size` | `6pt` |
| `font-weight` | `bold` |
| `backgroundNominalColor` | `#17641E` (`green5`) |
| `backgroundWarningColor` | `#6E520D` (`yellow5`) |
| `backgroundErrorColor` | `#7D1224` (`red5`) |
| `foregroundNominalColor` | `#37D247` (`green2`) |
| `foregroundWarningColor` | `#E5AF24` (`yellow2`) |
| `foregroundErrorColor` | `#E33B57` (`red2`) |
| `magnitudeColor` | `rgb(0,0,0)` = `#000000` |
| `majorTickColor` | `#969696` (`white5`) |
| `minorTickColor` | `#5B6273` (`grey1`) |
| `backgroundNominalColorDisabled` | `#646464` (`black4`) |
| `backgroundWarningColorDisabled` | `#828282` (`black5`) |
| `backgroundErrorColorDisabled` | `#414141` (`black3`) |
| `foregroundNominalColorDisabled` | `#D2D2D2` (`white3`) |
| `foregroundWarningColorDisabled` | `#D2D2D2` (`white3`) |
| `foregroundErrorColorDisabled` | `#B4B4B4` (`white4`) |

**Horizontal mixer** (`#hVolumeWidgets`, L1855–1899):
`VolumeControl` → `padding: 0`; `border-bottom: 1px solid #3C404D`; `margin-bottom: 0`.
`.mixer-category` → `margin: 2px`; `padding: 0px 7px`; `border-radius: 4px`.
`VolumeName` → `padding-right: 4px`; `VolumeName QLabel` → `margin: 0 4px`; `#volLabel` → `margin: 0 2px`, `border-radius: 4px`; `#volMeterFrame` → `margin-bottom: 4px`; `QSlider` → `margin: 4px 0px`; `QSlider::groove:horizontal` → `background: #1D1F26`, `height: 4px`; `QPushButton` → `margin-left: 4px`; `#volMeterFrame` → `padding: 0 7px`.

**Vertical mixer** (`#vVolumeWidgets`, L1902–1934):
`VolumeControl` → `padding: 0px 0px 4px`; `border-right: 1px solid #3C404D`.
`.mixer-category` → `border-bottom: 1px solid #3C404D`.
`#vMixerScrollArea VolumeControl QSlider` → `width: 14px`; `margin: 0px 7px`.
`#volLabel` → `padding: 2px 0px`; `min-width: 28px`; `margin-left: 7px`; `text-align: center`.
`QSlider::groove:vertical` → `background: #1D1F26`; `width: 4px`.
`#volMeterFrame` → `padding: 4px 7px 4px 0px`.
`QLabel` → `padding: 0px 4px`.

---

### 3.22 Preview / Program labels (L2045–2052)

```css
.label-preview-title {
    font-size: 15pt;          /* --font_xlarge */
    font-weight: bold;
    color: #FFFFFF;           /* --text_light */
    margin-bottom: 4px;       /* literal 4px */
}
```

This single class is used for **both** the Preview scene-name label (`frontend/forms/OBSBasic.ui:213`) and the Program scene label (`frontend/widgets/OBSBasic_StudioMode.cpp:227`, `programLabel->setProperty("class", "label-preview-title")`).

**Canvas** (L2025): `OBSQTDisplay { qproperty-displayBackgroundColor: #13141A; }` (`--bg_preview`).

**Preview toolbar bits:**
* `#previewScalePercent`, `#previewScalingMode` (L2424): `background: transparent`; `color: #969696` (`--text_muted`); `font-size: 6.75pt` (`--font_xsmall`); `height: 14px`; `max-height: 14px`; `padding: 0px`; `margin: 0`; `border: none`; `border-radius: 0`.
* `#previewScalePercent` → `padding: 0px 8px`; `min-width: 28px`.
* `#previewScalingMode` → `padding: 0px 8px`; `border: 1px solid #272A33` (`grey6`). `:hover`, `:focus` → `border-color: #5B6273`; `:on` → `background-color: #1D1F26`, `border-color: #284CB8`.
* `#previewXContainer` → `border: 1px solid #272A33` (`grey6`).
* `#previewZoomInButton`, `#previewZoomOutButton` (L2482–2507): `border: none`; `border-radius: 0`; `outline: none`; `:!hover` → `background-color: transparent`; `:pressed` → `background-color: #3C404D`; `:focus` → `border: 1px solid #5B6273`.

---

### 3.23 Additional OBS-specific widgets (condensed)

| Selector | Key values |
| --- | --- |
| `QToolBar` (L1131) | `background-color: transparent`; `border: none`; `margin: 2px 0`; `spacing: 2px` |
| `QToolBar::separator` (L728) | `background: #3C404D`; `width: 1px`; `margin: 0 2px 0` |
| `QToolBarExtension` (L1138) | `background: #3C404D` (`--button_bg`); `min/max-width: 12px`; `padding: 4px 0`; `margin-left: 0`; icon `theme:Dark/dots-vert.svg` |
| `.toolbar-button` (L445) | `background: transparent`; `font-weight: bold`; `padding: 0 7px`; `margin: 1px 1px 0px`; `border: 1px solid transparent`; `border-radius: 4px` |
| `#contextContainer` (L1108) | `background-color: #272A33`; `margin-top: 4px`; `border-radius: 4px` |
| `OBSBasicSettings #PropertiesContainer` (L869) | `background-color: #272A33` |
| `#transitionsFrame` (L913) | `padding: 4px` (`--padding_container`) |
| `#controlsFrame` (L1445) | `padding: 4px` |
| `OBSBasicFilters #widget, #widget_2` (L2031) | `margin: 0`; `padding: 0 0 2px 0` |
| `.btn-create-new` (L2510) | `background: transparent`; `padding: 16px 4px`; `border-radius: 4px`; `border: 2px dashed #464B59` (`grey3`); `outline: none`; icon `theme:Dark/plus.svg`; `margin-bottom: 4px` |
| `SourceSelectButton` (L2520) | `background: #323540` (`grey5`); `padding: 2px 4px`; `margin: 2px`; `border-radius: 4px`; `border: 1px solid #464B59`; hover → `#464B59`; checked → `#284CB8` / border `#476BD7`; focus → border `#D2D2D2`; pressed → `#1D1F26` / border `#3C404D` |
| `SourceSelectButton QLabel` (L2529) | `padding: 4px 0`; `text-align: center` |
| `SourceSelectButton #thumbnail` (L2534) | `background: #272A33` (`grey6`); `border-radius: 4px`; `padding: 0`; `margin-top: 2px` |
| `InfoChip` (L2561) | `font-size: 8pt`; `font-weight: bold`; `padding: 0 4px`; `border-radius: 4px` |
| `OBSHotkeyWidget` (L2168) | `padding: 8px 0px`; `margin: 2px 0px` |
| `OBSHotkeyLabel` (L2173) | `padding: 4px 0px` |
| `#ytEventList QLabel` (L2277) | `color: #FFFFFF`; `background-color: #3C404D`; `border: none`; `border-radius: 4px`; `padding: 4px 20px`; hover → `#464B59`; `.row-selected` → `#284CB8`, hover → `#476BD7` |
| `QCalendarWidget QWidget#qt_calendar_navigationbar` (L2311) | `background-color: #272A33`; `padding: 2px 4px` |
| `QCalendarWidget QSpinBox` (L2358) | `background-color: #3C404D`; `border: none`; `border-radius: 4px`; `margin: 0 2px 0 0`; `padding: 2px 16px`; up/down buttons `width: 16px`; arrows `10px × 10px` |
| `QCalendarWidget QAbstractItemView:enabled` (L2393) | `background-color: #272A33`; `color: #FFFFFF` |
| `QCalendarWidget QWidget` (L2389) | `alternate-background-color: #1D1F26` (`grey7`) |
| `AlignmentSelector` (L2849) | `border: 1px solid #5B6273`; `margin: 0px`; `border-radius: 2px`; focus/hover → border `#D2D2D2`; checked:hover → border `#718CDC`; `::indicator:checked` → `background: #284CB8`; `:checked:focus` → `#476BD7`; disabled → border `#464B59`, indicator `#323540`, checked-disabled `#464B59` |

**Idian settings widgets** (L2569–2887) — the modern settings-row toolkit:

| Selector | Key values |
| --- | --- |
| `idian--ListHeader` | `border-radius: 4px`; `font-weight: bold`; `margin: 0 0 2px`; `padding: 0 2px`; `min-width: 300px` |
| `idian--RowList .title` | `font-weight: bold`; `padding: 0` |
| `idian--RowList .description` | `font-size: 8pt`; `color: #969696`; `padding: 0` |
| `idian--RowList` | `border-width: 0`; `padding: 0`; `margin: 2px 0` |
| `idian--Row` | `background: #323540` (`grey5`); `padding: 5px 10px`; `border-radius: 4px`; `border: 1px solid #3C404D` |
| `idian--Row.keyFocus` | `background: #3C404D`; `border: 1px solid #718CDC` |
| `idian--Row.cursor-pointer.hover` | `background: #3C404D`; `border: 1px solid #5B6273` |
| `idian--ToggleSwitch` | bg `#272A33`, hover `#1D1F26`, checked `#284CB8`, checked-hover `#476BD7`; `min-width: 36px`; `min-height: 18px`; `border-radius: 9px`; handle `#FFFFFF`, size `11.2`; `border: 1px solid transparent` |
| `idian--ToggleSwitch.hover` | `border-color: #3C404D` (`grey4`) |
| `idian--ToggleSwitch.checked.hover` | `border-color: #FFFFFF` |
| `idian--ToggleSwitch.keyFocus` | `border-color: #718CDC` |
| `idian--RowListSpacer` | `max/min-height: 1px`; `background-color: #1D1F26` |
| `idian--CheckBox::indicator` | `border: 1px solid transparent`; `border-radius: 4px`; focus/hover → `#5B6273`; keyFocus → `#718CDC` |
| `idian--CollapsibleGroup` | `margin: 0`; `padding: 0`; `border: none` |
| `idian--CollapsibleGroup idian--RowList` | `border-radius: 0`; `border-left/right/bottom: 1px solid #323540`; `margin: 1px 0 0` |
| `idian--CollapsibleGroup idian--RowList idian--Row` | `background-color: #272A33`; `padding-left: 14px` |
| `idian--InlineButton` | `background: transparent`; `min-width/min-height: 22px`; `border-radius: 4px`; `padding: 2px`; `margin: 0 2px`; `border: 1px solid transparent`; hover → `background-color: #464B59`, `border-color: #5B6273`; pressed → `#1D1F26`; focus → `border-color: #718CDC` |
| `idian--ExpandButton` | icon `theme:Dark/down.svg`; `.checked` → icon `theme:Dark/up.svg`, `background: transparent`, `border-color: transparent` |

---

## 4. Metrics

### 4.1 Typography

| Token | Value | px @96 dpi | Use |
| --- | --- | --- | --- |
| `--font_base` | `10pt` | `13.333px` | Global default (`QWidget`) |
| `--font_small` | `8pt` | `10.667px` | Tabs, dock titles, `VolumeName`, `.text-small`, `.subtitle` |
| `--font_xsmall` | `6.75pt` | `9px` | `.text-tiny`, preview scale labels |
| `--font_large` | `11pt` | `14.667px` | `.text-title`, `.text-large` |
| `--font_xlarge` | `15pt` | `20px` | `.label-preview-title` (Preview/Program) |
| `--font_heading` | `25pt` | `33.333px` | `.text-heading` |
| `VolumeMeter` | `6pt` | `8px` | Meter tick labels |
| `--os_mac_font_base_value` | `12` | — | macOS multiplier source (macOS-only override path) |

**Font family (from `QWidget`):** `'Open Sans', '.AppleSystemUIFont', Helvetica, Arial, 'MS Shell Dlg', sans-serif` — with bundled **Open Sans** Regular (400), Bold (700) and Italic. **Weights used:** `normal` and `bold` only. **Styles:** normal and `italic`.

### 4.2 Control heights

| Token | Value | Notes |
| --- | --- | --- |
| `--input_height_base` | `30px` | Full control row (group-box title inset, action rows, scene-tree grid item height) |
| `--input_height` | `22px` | `height`/`max-height` of buttons, combos, spinboxes, line edits; width of spinbox/combo buttons |
| `--input_height_half` | `15px` | Intermediate for spinbox button height |
| `--spinbox_button_height` | `14px` | Spinbox up/down buttons |
| `--action_row_base` | `22.5px` | Idian row / inline-button / combo height |
| `--toggle_height` | `18px` | Idian toggle switch |
| `--toggle_width` | `36px` | Idian toggle switch |
| `--toggle_radius` | `9px` | Pill radius being half the height |
| `--toggle_handle` | `11.2px` | Toggle knob |
| `.slider-tbar` | `24px` | Studio-mode T-bar |
| `OBSDock QToolBar` | `32px` | Dock toolbar height |
| `SceneTree::gridItemWidth/Height` | `154` / `30px` | Grid mode |

### 4.3 Spacing & padding

| Token | Value |
| --- | --- |
| `--spacing_base` | `2px` |
| `--spacing_small` | `1px` |
| `--spacing_large` | `4px` |
| `--spacing_title` | `4px` |
| `--spacing_input` | `2px` |
| `--padding_small` | `1px` |
| `--padding_base` | `2px` |
| `--padding_base_border` | `3px` |
| `--padding_large` | `4px` |
| `--padding_xlarge` | `7px` |
| `--padding_container` | `4px` |
| `--padding_wide` | `16px` |
| `--padding_menu` | `12px` |
| `--padding_menubar` | `7px` |
| `--input_padding` | `4px` |
| `--input_text_padding` | `8px` |
| `--action_row_padding` | `5px` |
| `--action_row_padding_x` | `10px` |
| `--action_row_padding_nested` | `14px` |

**Notable composite paddings:** button `4px 16px`; combo/spinbox/line-edit `4px 8px`; menu item `4px 12px` (right forced to `20px`); menu-bar item `4px 7px`; tab `4px 16px`; list item `4px 4px`; calendar toolbutton `2px 16px`; `#ytEventList QLabel` `4px 20px`.

### 4.4 Borders & radii

| Token | Value |
| --- | --- |
| `--border_radius` | `4px` |
| `--border_radius_small` | `2px` |
| `--border_radius_large` | `6px` |
| `--border_color` | `#3C404D` |
| `--input_border_width` / `--button_border_width` | `1px` |
| `--highlight_width` | `1px` |
| Default border colour on inputs | `#3C404D` (same as fill → appears borderless) |
| Focus border colour | `#284CB8` |
| Hover border colour | `#5B6273` |
| `QMenu` border | `1px solid #3C404D` |
| `QGroupBox` border | none |
| `QProgressBar` radius | `4px` (hard-coded) |

### 4.5 Icon sizes

| Token | Value | Use |
| --- | --- | --- |
| `--icon_base` | `16px` | `QPushButton`/`QToolButton` icon-size, checkbox/radio indicator, dock close/float buttons, `QCalendarWidget` prev/next, source properties/filters buttons |
| `--icon_small` | `14px` | `.btn-mute` / `.btn-monitor` width, height and icon-size; dock toolbar `QToolButton` max-width/height |
| `--icon_base_mixer` | **undefined** (orphan) | Referenced only by `Yami_Classic.ovt` |
| `QCalendarWidget QSpinBox` arrows | `10px × 10px` |
| `#qt_calendar_monthbutton::menu-indicator` | `10px × 10px` |
| `QToolBarExtension` | `12px` wide |
| `QCalendarWidget QSpinBox::up/down-button` | `16px` wide |

### 4.6 Scrollbars

| Token | Value |
| --- | --- |
| `--scrollbar_size` | `12px` |
| `--settings_scrollbar_size` | `21px` |
| `::handle` margin | `2px` |
| `::handle` min length | `32px` (both orientations) |
| `::handle` radius | `2px` |
| `OBSBasicSettings QScrollBar:vertical` margin-left | `9px` |
| Preview scrollbars | `16px` thick, `border-radius: 0`, handle margin `3px` |

### 4.7 Splitter / separator widths

| Target | Width | Source |
| --- | --- | --- |
| `QMainWindow::separator` | `4px` (`--spacing_large`) | Yami.obt L615 |
| `QMainWindow::separator:hover` | `1px` border, `1px` margin | Yami.obt L622 |
| `QSplitter::handle` | **not styled** → base style `PM_SplitterWidth` (Fusion: 4px) | §3.15, §6 |
| `QToolBar::separator` | `1px`, margin `0 2px 0` | L728 |
| `QMenu::separator` | `1px`, margin `2px 4px` | L701 |

### 4.8 Slider metrics

| Target | Value |
| --- | --- |
| Generic groove thickness | `4px` |
| Generic handle | `20px × 10px`, radius `4px`, margin `-3px 0` (h) / `0 -3px` (v) |
| Mixer groove (h) | `4px`, bg `#1D1F26` |
| Mixer groove (v) | `4px` wide, bg `#1D1F26`; slider width `14px` |
| T-bar groove | `8px`; handle `12px × 24px`; slider height `24px` |
| Mixer label min-width | `28px` (`--volume_slider_label`); horizontal `#volLabel` override `48px` |

### 4.9 Z-depth / elevation

The theme has **no shadows, no elevation, no opacity/blur**. Depth is expressed purely through the grey ramp (`#13141A` → `#1D1F26` → `#272A33` → `#323540` → `#3C404D` → `#464B59` → `#5B6273`) plus 1px `#3C404D` borders. There is no `box-shadow` equivalent in Qt QSS.

---

## 5. Icon / asset inventory

### 5.1 `frontend/data/themes/Yami/` — checkbox indicators (6 files)

Referenced from the QSS as `theme:Yami/<file>` (the `theme:` prefix maps to `frontend/data/themes/`).

| Path (relative to repo root) | Size | Stroke colour | Stroke widths | Used by |
| --- | --- | --- | --- | --- |
| `frontend/data/themes/Yami/checkbox_unchecked.svg` | 567 B | `#B0AFB3` | box 8 | `::indicator:unchecked` |
| `frontend/data/themes/Yami/checkbox_unchecked_focus.svg` | 371 B | `#FFFFFF` | box 12 | `::indicator:unchecked:hover`, `idian--CheckBox.keyFocus` |
| `frontend/data/themes/Yami/checkbox_unchecked_disabled.svg` | 370 B | `#4A4C53` | box 8 | `::indicator:unchecked:disabled` |
| `frontend/data/themes/Yami/checkbox_checked.svg` | 663 B | `#B0AFB3` | box 8, tick 12 | `::indicator:checked` |
| `frontend/data/themes/Yami/checkbox_checked_focus.svg` | 633 B | `#FFFFFF` | box 12, tick 20 | `::indicator:checked:hover`, keyFocus |
| `frontend/data/themes/Yami/checkbox_checked_disabled.svg` | 650 B | `#4A4C53` | box 8, tick 12 | `::indicator:checked:disabled` |

All six are 128×128 `viewBox="0 0 128 128"` vector sources rendered at 16×16 CSS px. The stroke colours are hard-coded in the SVGs, so a web port should reproduce them as inline SVG or CSS-drawn checkboxes — they are **not** derived from theme variables.

### 5.2 `frontend/data/themes/Dark/` — dark icon set (58 files)

The base theme references **58** icons from this directory. All are SVG.

**Root (36 files referenced):**
`alert.svg`*, `close.svg`, `cogs.svg`, `collapse.svg`, `dots.svg`*, `dots-vert.svg`, `down.svg`, `entry-clear.svg`, `expand.svg`, `filter.svg`, `headphones-off.svg`, `headphones.svg`, `interact.svg`, `layout-horizontal.svg`, `layout-vertical.svg`, `left.svg`, `locked.svg`, `media-pause.svg`, `minus.svg`, `mute.svg`, `network-disconnected.svg`*, `network-inactive.svg`*, `no_sources.svg`*, `plus.svg`, `popout.svg`, `recording-inactive.svg`*, `recording-pause-inactive.svg`*, `refresh.svg`, `revert.svg`, `right.svg`, `save.svg`, `streaming-inactive.svg`*, `trash.svg`, `unassigned.svg`, `updown.svg`*, `up.svg`, `visible.svg`
(* = present in the directory but **not referenced** by `Yami.obt`.)

**`frontend/data/themes/Dark/media/` (6):**
`media_next.svg`, `media_pause.svg`, `media_play.svg`, `media_previous.svg`, `media_restart.svg`, `media_stop.svg`

**`frontend/data/themes/Dark/settings/` (9):**
`accessibility.svg`, `advanced.svg`, `appearance.svg`, `audio.svg`, `general.svg`, `hotkeys.svg`, `output.svg`, `stream.svg`, `video.svg`

**`frontend/data/themes/Dark/sources/` (13):**
`brush.svg`, `camera.svg`, `default.svg`, `gamepad.svg`, `globe.svg`, `group.svg`, `image.svg`, `media.svg`, `microphone.svg`, `scene.svg`, `slideshow.svg`, `text.svg`, `windowaudio.svg`, `window.svg`

**⚠️ Broken reference:** `.icon-pin { qproperty-icon: url(theme:Dark/pin.svg); }` (L550) points at **`frontend/data/themes/Dark/pin.svg`, which does not exist.** There is no `pin.svg` anywhere in the repo. The pin icon will not render. A web port must supply its own pin glyph or omit it.

### 5.3 Shared `:res/images/` icons (Qt resource, `frontend/forms/images/`)

`obs.qrc` maps `:/images/<name>` → `frontend/forms/images/<name>`. Only two are referenced from `Yami.obt`:

| QSS reference | Repo path |
| --- | --- |
| `:res/images/unlocked.svg` | `frontend/forms/images/unlocked.svg` |
| `:res/images/invisible.svg` | `frontend/forms/images/invisible.svg` |

(Other useful dark-agnostic assets in that directory: `plus.svg`, `minus.svg`, `trash.svg`, `entry-clear.svg`, `refresh.svg`, `dots-vert.svg`, `down.svg`, `up.svg`, `help.svg`, `help_light.svg`, `hide.svg`, `alert.svg`, `locked.svg`, `cogs.svg`, `interact.svg`, and the `settings/`, `sources/`, `media/` subdirectories.)

### 5.4 `frontend/data/themes/Acri/` and `frontend/data/themes/Rachni/` — **dead assets**

**Neither directory is referenced by any file in the repository.** No `.ovt`, `.obt`, `.oha`, `.qss`, `.cpp`, `.hpp` or `.ui` file contains `theme:Acri/`, `theme:Rachni/`, `bot_hook`, `top_hook`, or `sizegrip`. They are vestigial from the pre-`.obt` theme system.

* `frontend/data/themes/Acri/` (16 PNGs): `bot_hook.png`, `bot_hook2.png`, `checkbox_checked.png`, `checkbox_checked_disabled.png`, `checkbox_checked_focus.png`, `checkbox_unchecked.png`, `checkbox_unchecked_disabled.png`, `checkbox_unchecked_focus.png`, `radio_checked.png`, `radio_checked_disabled.png`, `radio_checked_focus.png`, `radio_unchecked.png`, `radio_unchecked_disabled.png`, `radio_unchecked_focus.png`, `sizegrip.png`, `top_hook.png`
* `frontend/data/themes/Rachni/` (21 PNGs): the same checkbox/radio/sizegrip set plus `down_arrow(_disabled).png`, `left_arrow(_disabled).png`, `right_arrow(_disabled).png`, `up_arrow(_disabled).png`

They add nothing to the default dark theme. The `radio_*.png` files are the only radio-indicator artwork in the repo, and they are **not wired up** — hence §3.7 / §6.

### 5.5 Summary of asset counts

| Location | Files | Status |
| --- | --- | --- |
| `frontend/data/themes/Yami/` | 6 SVG | Active (checkbox indicators) |
| `frontend/data/themes/Dark/` | 58 SVG | 58 referenced by `Yami.obt`; 9 extra unreferenced; 1 dangling ref (`pin.svg`) |
| `frontend/data/themes/Acri/` | 16 PNG | Dead |
| `frontend/data/themes/Rachni/` | 21 PNG | Dead |
| `frontend/data/themes/Light/` | 61 SVG | Active for the Light variant only |
| `frontend/forms/images/` | 63 files | Qt resource pool; 2 referenced by `Yami.obt` |
| `frontend/forms/fonts/` | 3 TTF | Open Sans Regular/Bold/Italic |

---

## 6. Colours that come from the OS / native theme, not the stylesheet

This is the explicit list of surfaces a web port cannot source from `Yami.obt`.

### 6.1 Qt base style drawing (no QSS rule exists)

| Surface | Why it is native | Notes |
| --- | --- | --- |
| **`QRadioButton::indicator`** | Only `background`/`spacing` are set for `QRadioButton`; there is **no `::indicator` rule anywhere** (the `Acri/`+`Rachni/` `radio_*.png` files are unreferenced). | Drawn by the base style. On Linux that is **Fusion**, coloured from the `QPalette` (`Base` `#272A33`, `Text`/`ButtonText` `#FFFFFF`, `Highlight` `#284CB8`, `Button` `#3C404D`). On Windows `windowsvista`, on macOS the native control. |
| **`QSplitter::handle`** | No `QSplitter` rule at all. | Base-style `PM_SplitterWidth` (Fusion: **4px**) and palette-derived colour. Only the main-window `QMainWindow::separator` is styled (transparent 4px → 1px white on hover). |
| **`QTreeView` / `QTreeWidget` branch indicators, expand/collapse arrows, tree lines** | No `QTreeView`/`QTreeWidget` rule. | Only `QAbstractItemView { background-color: #272A33 }` applies. Branch glyphs come from the base style. (OBS's own `SceneTree`/`SourceTree` are separately styled.) |
| **`QMenuBar` on macOS** | The global macOS menu bar is drawn by the OS, outside the window. | QSS `QMenuBar` rules apply to in-window menu bars only. |
| **Window title bar / chrome, resize borders, drop shadows** | Server-side/compositor decorations; Qt QSS cannot style them. | On macOS OBS additionally calls `SetMacOSDarkMode(theme->isDark)` (`OBSApp_Themes.cpp:1017`). |
| **`QScrollBar` steppers** | Explicitly zeroed (`::add-line`/`::sub-line` → `0px`, arrows → `none`). | Effectively styled, but note there are **no arrow buttons**; if a platform style re-enables them they would be native. |
| **System file dialogs, native message boxes, `QFileDialog` native mode** | OS-provided. | Not themable by QSS. |
| **Cursor bitmaps, focus rectangles drawn by the style** | Base style. | `QWidget` does not disable the style focus rect globally. |
| **`QComboBox` popup frame shadow** | Base style/`QComboBox QAbstractItemView` has border+padding but no shadow control. | Fusion draws a popup frame; QSS only sets border and padding. |

### 6.2 QPalette roles left at the platform default

`PreparePalette()` starts from `defaultPalette`, which `OBSApp::InitTheme()` captures as `palette()` **before** any theme is applied (`OBSApp_Themes.cpp:1050`). Only the roles listed in §1.2 are overwritten. Everything else stays OS-derived:

| QPalette role | Set by theme? | Consequence |
| --- | --- | --- |
| `Window` | ✅ `#1D1F26` | |
| `WindowText` | ✅ `#FFFFFF` | |
| `Base` | ✅ `#272A33` | |
| `Text` | ✅ `#FFFFFF` (plus `Active`/`Disabled`/`Inactive` groups) | |
| `Button` | ✅ `#3C404D` | |
| `ButtonText` | ✅ `#FFFFFF` | |
| `Light` | ✅ `#4E5566` | |
| `Mid` | ✅ `#1D1F26` | |
| `Dark` | ✅ `#272A33` | |
| `Highlight` | ✅ `#284CB8` | |
| `HighlightedText` | ✅ `#FFFFFF` | |
| `Link` | ✅ `#476BD7` | |
| `LinkVisited` | ✅ `#476BD7` | |
| **`AlternateBase`** | ❌ | **OS default.** Partly mitigated by `QWidget { alternate-background-color: #272A33 }` and `QCalendarWidget QWidget { alternate-background-color: #1D1F26 }`, which cover most alternating-row widgets. |
| **`ToolTipBase`** | ❌ | **OS default**, but `QToolTip { background-color: #272A33 }` overrides the rendered tooltip background. |
| **`ToolTipText`** | ❌ | **OS default.** `QToolTip { color: #FFFFFF }` overrides the rendered tooltip text. |
| **`PlaceholderText`** | ❌ | **OS default.** Line-edit placeholder colour is therefore platform-dependent. |
| **`BrightText`** | ❌ | **OS default.** |
| **`Midlight`** | ❌ | **OS default**; used by some base-style bevel drawing. |
| **`Shadow`** | ❌ | **OS default**; used by base-style sunken/shadow frames. |
| `Highlight`/`HighlightedText` in **Disabled/Inactive** groups | ❌ (only the `Text` role defines group variants) | Those groups fall back to the platform palette. |

### 6.3 Fonts

The family fallback chain ends in `sans-serif`. The first entry, `'Open Sans'`, resolves to the **bundled** Open Sans via `QFontDatabase::addApplicationFont`, so on a normal OBS install the theme is fully font-determined. However, `.AppleSystemUIFont` / `Helvetica` / `MS Shell Dlg` fallbacks and **font hinting/antialiasing** remain platform-determined. A web port should bundle Open Sans 400/700/italic rather than rely on the host.

### 6.4 High DPI / device pixel ratio

Qt scaling (and the `QT_ENABLE_HIGHDPI_SCALING` / `QT_SCALE_FACTOR` environment) affects all px metrics. The theme's own `--obsFontScale` (10) and `--obsPadding` (4) are **OBS-level** density controls, separate from OS DPI scaling.

### 6.5 Interpolation of hard-coded (non-token) values

A few colours are literals in the QSS rather than tokens and would *not* follow a palette swap. For a web port they are still fixed values, but note they are not "variables":

* `QProgressBar { border-radius: 4px }` — literal.
* `.label-preview-title { margin-bottom: 4px }` — literal.
* `QCalendarWidget QToolButton { padding: 2px 16px }`, `QCalendarWidget QSpinBox { padding: … 16px }` — literal `16px`.
* `#ytEventList QLabel { padding: 4px 20px }` — literal.
* `QMenu::item { padding-right: 20px }` — literal.
* `#ytEventList`, `QToolBarExtension { min/max-width: 12px }` — literal.
* `VolumeControl #volLabel { min-width: 48px }` — literal.
* `SceneTree { gridItemWidth: 154 }` — literal.
* All six checkbox SVG stroke colours (`#B0AFB3`, `#FFFFFF`, `#4A4C53`) — hard-coded inside the SVG assets.
* `QSpinBox::up-arrow { margin: 2px }`, `down-arrow { padding: 2px }`, `QDockWidget::close-button:pressed { padding: 1px -1px -1px 1px }` — literal.
* Everything under `Yami.obt` §"OBS Color Palette" that is not aliased into a semantic token (e.g. `--white2`, `--black2`) is unused in the default dark theme.

---

## 7. Reproduction checklist

1. Load **Open Sans 400 / 700 / italic** (bundled at `frontend/forms/fonts/`); base size `10pt` (`13.333px`).
2. Set the root surfaces: window `#1D1F26`, panel/base `#272A33`, preview `#13141A`.
3. Use `#3C404D` as the default control fill (`--input_bg` / `--button_bg`) with a `1px solid #3C404D` border, `4px` radius, `22px` height, `4px 16px` horizontal padding for buttons and `4px 8px` for inputs.
4. Inputs invert on hover/focus: fill → `#1D1F26`, border → `#5B6273` (hover) / `#284CB8` (focus).
5. Accent = `#284CB8`, hover `#476BD7`, focus highlight `#718CDC`.
6. Selection = `#284CB8` with `#476BD7` border; list-item hover = `#3C404D` with `#464B59` border.
7. Text `#FFFFFF`, muted/disabled `#969696`.
8. Scrollbars `12px`, trough `#272A33`, thumb `#3C404D` with a `2px` inset and `2px` radius; no arrow buttons.
9. Meters: nominal `#37D247` on `#17641E`, warning `#E5AF24` on `#6E520D`, error `#E33B57` on `#7D1224`.
10. Re-create the checkbox indicators from the six `frontend/data/themes/Yami/checkbox_*.svg` assets (16×16), and the icon set from `frontend/data/themes/Dark/`.
11. Handle deviations consciously: **radio buttons**, **splitter handles**, **tree view branch indicators** and **placeholder text** are base-style/OS-derived (§6.1–6.2). Also note the **missing `Dark/pin.svg`**.
12. Do not rely on `Yami_*.ovt` variants in this checkout: several of their variable references (`--toolbutton_bg*`, `--button_bg_red*`, `--dock_title_padding`, `--icon_base_mixer`, `--padding_menu_y`) are undefined, and they use a `QPushButton[toolButton="true"]` selector that the base theme never matches (§1.5).
