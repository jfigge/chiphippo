---
paths:
  - "src/web/scripts/components/settings-*.js"
  - "src/app/store/settings-store.js"
  - "src/web/scripts/font-scale.js"
  - "src/web/styles/**"
  - "src/web/scripts/components/info-button.js"
  - "src/web/scripts/components/segmented-picker.js"
  - "src/web/scripts/components/color-swatches.js"
  - "src/web/scripts/tests/settings-*.test.js"
  - "src/web/scripts/tests/font-scale.test.js"
  - "src/web/scripts/tests/type-scale.test.js"
  - "src/app/tests/settings-store.test.js"
---

## Settings

**The Settings dialog is dumb**: it broadcasts a `chiphippo:settings-changed` patch and
`app.js`'s `applySettings` both persists it (`settings.set`) and applies it live. It is a
tabbed master-detail card (left nav rail → panels): **Appearance** (first/default — there
is no General), **Serial I/O** (key `integration`), **Data Sheets**, **AI**, **About**.
Serial I/O is the one panel that is NOT live-apply (see "Arduino serial integration").

- **`theme`** — a **segmented picker** (`components/segmented-picker.js`: a DIALOG's form
  of the toolbar pill — one bordered track, borderless `.segmented-option`s, the chosen one
  filled; shared with the Properties dialog's `"segmented"` field exactly as
  `color-swatches.js` is shared with its `"color"` field, which is why the class names
  carry no `settings-` prefix). System / Light / Dark, default `"system"`. **The one
  setting the renderer does not apply**: main turns it into Electron's
  `nativeTheme.themeSource`, and everything follows — every window's
  `prefers-color-scheme` (so theme.css's light palette reaches every auxiliary window with
  no per-window plumbing and no flash), the native menus/dialogs, and each new
  `BrowserWindow`'s pre-paint `backgroundColor` (`windowBackground()`). The
  `:root[data-theme]` blocks in theme.css stay as a manual override only.
- **`selectionColor`** (`#rrggbb` or null → the `--color-selection` custom property
  `.board-outline-path` strokes with, falling back to `--color-accent`).
- **`defaultLedColor`** (one of `LED_COLOR_OPTIONS`, default `"red"`) and
  **`defaultWireLayout`** (Direct / Routed, default `"direct"`) — both **not live-apply**,
  read only at placement time (`applySettings` just keeps
  `DeskController.setDefaultWireLayout` current).
- **`paletteAutoClose`** ("Auto-close tray folders", On / Off, default Off). On, opening a parts-tray section shuts every section NOT ON THE WAY TO IT:
  `PalettePanel.#openOnly` collapses everything bar the section and the folder it is
  shelved under (`folderOf`, the same bucketing `#render` does — Memory is top-level), so
  a nested group opened elsewhere is shut too, and a folder reopened later shows tidy. A
  header click and a rail icon go through the same rule (off, the rail still shuts only the
  other TOP-LEVEL entries). Closing is only ever closing, and switching it on closes
  nothing — which of several open sections is "the" one is only known at the next opening.
  `applySettings` keeps `palette.setAutoClose` current.
- **`view3dEnabled`** ("3D enabled", On / Off, default Off — Appearance's last row):
  whether the toolbar OFFERS the 3D view. `applySettings` hides or shows the cube segment
  (`.toolbar-pill-btn[hidden]`), and switching it Off while the 3D view is up returns to
  the breadboard (that segment was the way back). The view itself stays a toolbar toggle,
  never persisted — this decides only whether the toggle is there.
- **`spiceLite`** (Settings ▸ **Spice Lite**, its own tab between Serial I/O and Data
  Sheets; `components/settings-spice-panel.js`): `{enabled, gapPercent, families}`, ONE
  object emitted whole, families holding OVERRIDES only (Reset deletes a family's entry).
  App-wide (Jason, 2026-10-07). Read by `SimController` at RUN, never mid-run — the whole
  object, numbers included (`#runConfig`: a budget edited mid-run must not brown-smoke a
  chip the circuit did nothing to). `normalizeSpiceConfig` drops a VIL/VIH pair leaving no
  band, and the panel holds an emptied field to the same rule. The family
  strip follows `familiesShown(logicFamily, projectFamilies)` — `SettingsDialog.open`
  takes `projectFamilies` (app.js passes `palette.projectFamilies`) and the Data Sheets
  picker re-filters it live. See "Spice Lite".
- **The card's height is Appearance's.** `.settings-popup` is `max(520px, 34 lines)`: the
  Appearance rows grow additively with the type while the lines grow 34 px a step, so the
  px floor binds up to 14px. 520 was MEASURED in the running app across every shipped
  language and size so the tab never scrolls — and the eighth row (3D enabled) fit only by
  tightening every `.settings-row` from `--space-3` to `--space-2` padding (2026-10-05:
  tightest Italian at 13px, 37px spare). A new Appearance row means measuring again, with
  the panel NOT scrolling (a scrollbar narrows it and wraps more labels, overstating the
  need).
- **`fontSize` — ONE BASE, AND EVERY OTHER SIZE DERIVED FROM IT**
  (`web/scripts/font-scale.js` + the type scale in `theme.css`). Six steps
  `11 · 12 · 13 · 14 · 16 · 18`, default 13, a segmented picker under Language, plus
  **⌘= / ⌘− / ⌘0**. theme.css derives the whole ramp off `--font-size`
  (`-xs`/`-sm`/`-lg`/`-xl`/`-display`) **additively** — a UI step is one pixel at every
  base, so a caption stays exactly one step under its label however large the app is set,
  and the shipped 13 reproduces the original values exactly. The two small ranks carry a
  `max()` FLOOR (chrome text stops being readable below a size); nothing is capped at the
  top, the direction the setting exists for. `--header-height` / `--control-height` /
  `--toolbar-height` / `--segment-height` derive from it too, on the law that **a box is
  ONE LINE OF TEXT PLUS CONSTANT CHROME** — the px term is the padding, not the box — so a
  control grows with its text instead of clipping it. (The toolbar gets its own pair
  because a row of mixed text and icon buttons has to stay FLUSH: sized by content, the
  text ones would grow and the icon ones would not.)
  - **Only chrome scales.** The desk's own type is stated in SVG **user units** (one unit =
    one pitch) — `.part-chip-label`, `.board-row-label`, `.bus-band-label`, every
    `font-size` ATTRIBUTE `schematic-view.js` writes — plus `.annotation-text` /
    `.annotation-editor` (document content inside the zoom-scaled layer) and
    `.wire-gauge-length` (a viewBox's own coordinates). All of it stays literal: it is
    printed ON THE CIRCUIT, it scales with the camera, and a screen-pixel token there would
    slide a label off the part it names and make one saved desk read differently on two
    machines. `tests/type-scale.test.js` is the ratchet, since a bare px looks completely
    normal and renders perfectly at 13; every exemption is a SELECTOR with its reason,
    checked in both directions so a stale one fails too.
  - It is the **third** setting main acts on and the only one with nothing native to ride
    (there is no font-size `nativeTheme.themeSource`), so `settings:set` fans `fontSize`
    out itself as `settings:font-size` → `chiphippo:font-size-changed`, to every window BUT
    the sender (which already applied it) and by `getAllWindows()` rather than the aux
    registries, so a later window type follows for free. The three auxiliary renderers only
    ever follow, hence `followFontSize(bridge)`: one awaited line each, before they paint.
    `MemoryInspector` is the one place the size feeds ARITHMETIC rather than layout (its
    grid is virtualized, so `#rowH` decides how many rows exist and which one a scroll
    offset lands on) — it measures `--font-size` at construction and `refreshMetrics()`
    re-measures on the push; under `node --test` there is no stylesheet, so it falls back to
    the shipped 22.
- **The app has two scales and Option is the whole difference**, which is why ONE pure
  `scaleStepForEvent` decides both rather than two modules that could drift: **⌘=/−/0
  resize the app's TEXT**, **⌥⌘=/−/0 zoom the desk CAMERA**. Bare ⌘ is the text because
  that is what a reader who cannot see the screen reaches for first, and the desk already
  has a zoom cluster, a Fit button and the wheel. Both are matched on **`e.code`** — the
  one place in the app that cannot use `e.key`, because with Option held macOS reports the
  alt-layout CHARACTER (`⌥=` is `≠`, `⌥-` is `–`, `⌥0` is `º`), so a key-name match would
  make the DESK pair silently never fire. The block sits AHEAD of `bindShortcuts`' Cmd gate
  (which discards every Alt chord) and ahead of the typing guard, but UNDER the
  `PopupManager.isOpen()` guard: a dialog owns the keyboard, and Settings is precisely the
  one that would be open, where its own picker would then show a size the app had stopped
  using. A font step that saturates changes nothing and says nothing — the resizing is the
  feedback. NOTE macOS's own Zoom binds `⌥⌘=`/`⌥⌘−` when *Use keyboard shortcuts to zoom*
  is on and takes them first, which costs the DESK zoom rather than the text size (the zoom
  cluster and ⌘F are its other routes).
- **Data Sheets** drives **`datasheetDir`** (the external datasheet-PDF folder, default
  null; Browse calls the native `settings:choose-datasheet-dir` picker, exposed as
  `settings.chooseDatasheetDir`), with no live apply (the pinout window reads it at open
  time). Beside it **Download…** FILLS that folder (below); both end in the same one-line
  patch, and nothing downstream knows which button produced it. Its FIRST row is **Chip
  family** (`logicFamily`: 74LS / CD4000 / both — a segmented picker, live-applied to the
  tray through `PalettePanel.setFamilyMode`; see "Logic families"). Main stores it
  unvalidated, like `paletteAutoClose`; the renderer coerces it (`normalizeFamilyMode`).
- **AI** drives the NON-SECRET half (`ai: {provider, baseUrl, model}`, emitted WHOLE as an
  object-valued setting) and is the one panel built asynchronously — its picker comes from
  `ai:providers`, so it cannot drift from `app/ai/providers.js`. Its API-key field is the
  ONE control that bypasses `#emit` entirely, calling `ai.key.set` directly.
- **About** is the updater's UI and the one panel with LIVE state: the version from
  `app:info:get`, **`autoUpdateCheck`** as a segmented On/Off (default Off), a Check
  button, and a status line fed by the `chiphippo:updater-*` broadcasts — whose listeners
  belong to the dialog's OPEN lifetime, so `buildAboutPanel` hands back a `dispose` that
  `onClose` runs.
- Window bounds and the desk camera (incl. zoom) are already persisted in `settings.json`
  (`windowBounds` via `window-state.js`; `viewport` via the renderer's debounced save).
- **Every explanatory note is behind an (i), not printed under its row** (`rowWithNote()` +
  `components/info-button.js`). Eight of them across the four tabs, several a full
  paragraph, turned each panel into more prose than settings. The note FLOATS over the rows
  below rather than pushing them down (a note that reflowed the panel would move the very
  control the reader is about to reach for), which is why it is a CHILD of its
  `.settings-row` (`position: relative`) rather than its sibling — hiding a row takes its
  note with it (a store build hides two). It is deliberately **not** a
  `PopupManager.popover` (PopupManager QUEUES, so a card raised from inside the Settings
  modal would not appear until Settings closed), hence `info-button.js` — un-prefixed and
  shared, as `segmented-picker.js` and `color-swatches.js` are, because the About dialog's
  version details are the same control. **Escape is the whole reason it is a module**: both
  callers sit inside a native modal `<dialog>`, where Escape fires `cancel` and closes the
  WHOLE card, so the keydown is caught in the **capture** phase and `preventDefault`ed —
  the first Escape closes the note, the next closes the dialog. A click outside and the (i)
  again also dismiss it, and the listeners self-remove if the card's dialog is torn down
  while it is open. The target's `hidden` attribute is the single source of truth. The one
  note NOT behind an (i) is About's store-build message, which is the only thing on that
  panel (it explains why every control above it is gone).
- **One CSS rule the whole card depends on**: a settings element that sets a `display` of
  its own must be listed in the shared **`[hidden]`** rule beside `.settings-panel`,
  because a class selector outranks the UA sheet's `[hidden] { display: none }`. Without it
  `el.hidden = true` sets an attribute that changes nothing — which is exactly how Data
  Sheets came to offer a **Clear** button with no folder to clear. `.settings-note` is on
  that list (it sets `display: flex`).
