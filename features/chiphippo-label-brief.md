# File & Desktop menus made consistent, plus one Browse window (Recent Projects + Gallery)

## Context

The same project and desktop actions show up in five places, and each place has a different set of items, a different order and different labels:

| Surface | Today |
|---|---|
| Native **File** | New Project · Open… · Open Recent ▸ · — · Save · Save As… · — · Project Properties… · — · Bill Of Materials… |
| Toolbar **File pill** (4 icons) | Only **Open** has a right-click menu (the recent list); New, Save and Save As have none, and in the web build they show the browser's own menu. Project Properties… can't be reached on the web at all. |
| Native **Desktop** | New Desktop · Duplicate Desktop · — · Import Desktop… · Export ▸ · Share to Gallery… · — · Desktop Properties… · Delete Desktop |
| **Tab right-click** | **Properties…** (first, different label) · Duplicate Desktop · Export ▸ · Share to Gallery… · — · Delete Desktop. New and Import are missing. |
| **"+" right-click** | New Desktop · Import Desktop… |
| **Browse Gallery** | Only under **Help ▸ Browse Gallery…**, while Share to Gallery is under Desktop |

Each surface builds its own literal item list (main.js `buildAppMenu`, `project-tabs.js` `#openMenu` / `#openAddMenu`, `app.js` `buildFilePill`), so they have already drifted, and the rule docs have drifted too (ui-chrome.md and projects.md are both missing Share and the Export submenu).

The goals:
1. Every surface draws from **one action list**, so labels, order and availability match.
2. The gallery is one click away.
3. Recent projects can be opened from a **visual grid** showing a picture of each board.

## Part A — One action table drives every menu

**New pure module `src/web/scripts/model/menu-actions.js`**
- Dependency-free ES module. Main can `require()` it, the same way `serial/protocol.js` requires `model/serial-wire.js`.
- It exports `FILE_ACTIONS` and `DESKTOP_ACTIONS`: ordered arrays of `{ id, labelKey, accelerator?, event, gate?, submenu? }` or `{ separator: true }`.
  - `event` is the `chiphippo:*` / `menu:*` name already in use.
  - `gate` is `"duplicate"` or `"delete"`; it maps to the existing `{canDelete, canDuplicate}` state.
- Two adapters:
  - `toElectronTemplate(actions, {m, send, state})` in main.
  - `toPopupItems(actions, {t, run, state})` in the renderer.

**Canonical order.** The Desktop list follows the same rhythm as File: create, then load/export, then share, then properties, then destroy.

- **File:** New Project ⌘N · — · Open… ⌘O · Open Recent ▸ · **Browse Projects…** ⇧⌘B (new, Part B) · — · Save ⌘S · Save As… ⇧⌘S · — · Project Properties… · — · Bill Of Materials… ⌘B. Off macOS, Settings… and Quit are still appended after this.
- **Desktop:** New Desktop · Duplicate Desktop · — · Import Desktop… · Export ▸ (Chip Hippo Desktop… · — · KiCad Project… · Digital Circuit…) · — · Share to Gallery… · — · Desktop Properties… · — · Delete Desktop (danger).
- **Help:** loses Browse Gallery… (it moves into the Browse window, Part B). User Guide · Support · — · Shortcuts · — · Check for Updates.

**Where each surface gets its items**
- **Native menus.** `buildAppMenu` (main.js ~2195–2303) builds `fileItems` and `desktopItems` through `toElectronTemplate`.
  - Menu ids `desktop-duplicate`, `desktop-share` and `desktop-delete` are kept, so `setDesktopMenuState` (main.js 2547) is unchanged.
  - Open Recent's submenu still comes from `recentProjectItems()`.
- **Tab right-click.** `project-tabs.js` `#openMenu` shows the whole `DESKTOP_ACTIONS` list through `toPopupItems`, aimed at that tab's id.
  - New Desktop and Import Desktop… are added to it.
  - "Properties…" becomes "Desktop Properties…", and the `tabs.properties` key is dropped.
  - The existing per-tab callbacks stay. `run(id)` maps an action id to the callback, so the tab id is still what gets acted on.
- **"+" right-click.** It shows the first block of the same table (New Desktop · Import Desktop…), with the same labels.
- **File pill right-click.** A secondary click on **any** of the File segments opens the File list, anchored under that segment.
  - Open Recent ▸ is that list's submenu, and keeps its × remove rows.
  - ⇧⌘O still opens the flat recent list directly, as it does now.
  - This also gives the web build its only route to Project Properties….
  - It replaces Open's current right-click (the flat recent list), which becomes one hover deeper. See question 1.
- **Disabled items.** Gate rules are read from the one table, so a tab menu and the menu bar can't disagree.
  - Share follows `canDuplicate`, as it does now.
  - Delete follows `canDelete`.

**Tests**
- A new `tests/menu-actions.test.js`:
  - Each label key exists in `en.json`.
  - No adjacent or leading/trailing separators.
  - The tab menu, the "+" menu and the native template come out in the same order with the same labels.
- `app/tests/ipc-parity.test.js` gains whatever new channels Part B adds.
- Existing tab-menu tests are updated for the new order and labels.

## Part B — One Browse window: Recent | Gallery

The existing singleton gallery window (`openGalleryWindow`, main.js 1697; `gallery.html`; `gallery-window.js`; `gallery/gallery-view.js`) becomes a **Browse** window with two tabs: **Recent Projects** (the default) and **Gallery**.

**Ways in**
- A **5th File-pill segment** (a grid icon) placed after Save As.
- File ▸ Browse Projects… (⇧⌘B).
- The Gallery tab can also be opened directly (`gallery:show {tab:"gallery"}`). The `chiphippo://` link path is unchanged.

**Recent tab**
- **Data.** A new main IPC `project:recent:details` returns `[{path, name, savedAt (mtime), missing, desktops, thumb: dataURL|null}]`.
  - It is read from the existing `recentProjects` list (`recent-files.js`).
  - `missing` is checked with `fs.stat`, so a vanished file shows greyed with a Remove button, instead of only being discovered when clicked.
- **Grid.** The cards reuse `.gallery-grid` / `.gallery-card` / `.gallery-card-thumb` and the striped `gallery-thumb--empty` placeholder.
  - `GalleryView` gets a `mode: "local"` option that skips the level/engine/tag filters and the detail pane. The search box stays.
  - A card shows the title, the "2 days ago" save time and the desktop count.
  - Clicking a card opens the project. Hovering shows a ×, which forgets the entry exactly as the menu's × does.
- **Opening.** The window relays `{kind:"open-recent", path}` to the app window over the existing `gallery:host-inbound` path. The app window runs `workspace.openRecentProject(path)`, so the unsaved-changes guard and the missing / denied / invalid handling are all reused, and focus returns to the main window.
- **Permissions.** The `ipc-guard.js` "gallery" role gains `project:recent:details`, `project:recent:remove` and the open relay. It gets nothing that accepts an arbitrary path: the relay is checked against the recent allowlist in main, as `project:open-recent` already does.

**Gallery tab**
- It is today's gallery view, unchanged.
- **Access gate.** The window itself can now open without `galleryAccess` (the Recent tab never touches the network). Main still checks `galleryAllowed()` on every gallery read handler.
- When access is not "yes", the Gallery tab shows a short card ("The gallery reads chiphippo.com") with an **Allow…** button. That button relays to the app window, which runs the existing `galleryAccess` question in `gallery-open.js` and then reloads the tab.

**Thumbnails (desktop app)**
- **When.** A picture is taken on **Save and Save As**, and when leaving a saved project (Open, New, opening a recent project).
  - The renderer adds `app--capturing` to hide floating chrome: `.project-tabs`, `.desk-zoom`, `.desk-lock`, hole rings and the selection outline. It waits two frames, then asks main over `project:thumb:capture {rect}`, passing the `.desk-viewport` bounds.
- **How.** Main calls `webContents.capturePage(rect)`, resizes the image to 480 px wide with `nativeImage`, and writes it atomically with `io.js` to `userData/thumbs/<sha256(path)>.png`.
  - The thumbnail's path never crosses the bridge.
  - `forgetProject` and the 10-entry cap delete stale thumbnails.
  - Save As moves the picture to the new path's key.
- **What it shows.** It captures what is on screen for the active desktop, LEDs lit if the circuit is running. That is the "visual capture of the board" without building Feature 160's SVG exporter.
- **Web build.** It has no `capturePage`, so `thumb` is null and cards show the striped placeholder. The Recent tab still works from the web-host's recent list.

**Rejected alternative: embedding the thumbnail inside the `.chiphippo` file.** That would change the file format, add about 50 KB per save, and feed into the gallery validator's snapshot rules. A side cache is cheaper and private; the only cost is that a moved file loses its picture until its next save.

## Docs to update

- `.claude/rules/ui-chrome.md` → the "Application menu" and "Header toolbar" (File pill) sections.
- `.claude/rules/projects.md` → the tab menu section.
- `.claude/rules/gallery.md` → the Phase 3 entry point and the access gate.
- User guide pages `src/web/docs/` (projects, gallery), then `make docs` / `make pdf`.
- New `menu.file.browse`, `toolbar.file.browseTitle` and `browse.*` strings in all 7 locales; the i18n guards will catch any that are missing.

## Critical files

- `src/web/scripts/model/menu-actions.js` (new) + test
- `src/app/main.js` (`buildAppMenu`, `openGalleryWindow`, the new IPC handlers), `src/app/preload.js`, `src/app/ipc-guard.js`
- `src/app/store/recent-files.js` (prune hook), plus a new `src/app/store/thumb-store.js`
- `src/web/scripts/components/project-tabs.js`, `src/web/scripts/app.js` (`buildFilePill`, `wireProjectMenu`), `components/project-workspace.js` (`openRecentMenu`, the capture-before-leave hook)
- `src/web/scripts/gallery/gallery-view.js`, `src/web/scripts/gallery-window.js`, `src/web/gallery.html`, `components/gallery-open.js`
- `src/web-host/ipc.js` (`recent:details` with `thumb: null`), `src/web/styles/app.css` (a tab switcher in the gallery block, tokens only)

## Verification

- Targeted tests while iterating: `menu-actions`, `project-tabs`, `ipc-parity`, `recent-files`, `gallery-open`, a new `thumb-store` test, and `make test-i18n`. Run `make test` once at the end.
- In the real app, using an isolated `--user-data-dir` and a PID-scoped kill (as the electron-launch memory says):
  - Compare the native File and Desktop menus against the tab menu, the "+" menu and each File segment's right-click, item by item.
  - Run the circuit and check that Duplicate, Share and Delete grey out on every surface.
  - Save two projects, open the Browse window, and check that both cards show board pictures. Open one; forget one.
  - Rename a file on disk and check that its card shows as missing.
  - Gallery tab with access "no": the Allow… flow should work.
- Web build: `make web-serve`. The File-pill right-click should reach Project Properties…, and the Recent tab should show placeholder cards.

## Decisions to confirm (defaults above unless told otherwise)

1. **File-pill right-click.** Should every one of the four (now five) segments open the full File menu, with recents moved into an Open Recent ▸ submenu? Default: yes. The alternative keeps Open's right-click as the flat recent list and gives the other segments the File menu.
2. **One Browse window with Recent | Gallery tabs, or two separate surfaces?** Default: one window. The alternative is a Recent grid as a dialog inside the main window, with the gallery window kept as it is.
3. **Recent list length.** The grid could hold more than the menu. Default: keep 10 everywhere. The alternative stores 24 and shows the first 10 in the menus.
4. **Browse Gallery under Help.** Default: remove it, since it now lives in File ▸ Browse Projects… → Gallery tab. The alternative keeps it as a second door.
5. **Bill Of Materials ⌘B.** Default: leave it in File; the View menu holds only Developer Tools today, so moving it there would make it a lone item.
