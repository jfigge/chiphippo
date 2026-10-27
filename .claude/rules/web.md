---
paths:
  - "src/web-host/**"
  - "scripts/build-web.mjs"
  - "scripts/serve-web.mjs"
  - "src/web/scripts/web-flavour.js"
  - "src/web/docs/web.md"
  - "src/app/store-build.js"
---

## The web build

**Chip Hippo with Electron taken out, as a static site** (2026-10-24, no feature number;
plan `~/.claude/plans/what-woudl-be-the-tranquil-clock.md`). Every release puts out TWO
versions: the desktop installers and `chiphippo-web-<version>.zip`, published at
**chiphippo.com/desktop/** (moved from /app/ 2026-10-25, which redirects) on the same GitHub Pages site as the marketing pages (Jason chose
the subpath over a Cloudflare subdomain, 2026-10-24).
`make web` → `dist/web/`; `make web-serve` serves it (`WEB_PORT`, default 8080);
`make web-zip` zips it. User guide: `web.md` ("Chip Hippo in the Browser").

- **MAIN RUNS IN THE TAB, UNCHANGED.** The split stays exactly as on the desktop:
  `src/app/main.js` and everything it requires are BUNDLED by esbuild
  (`scripts/build-web.mjs` `bundleOptions`) onto browser stand-ins, and every page
  loads `app/preload.js` itself (bundled the same way) and talks to main over the SAME
  channels. So there is no second bridge to keep in parity: the boot rule, recovery,
  `knownPath`, the ipc-guard, the menu template, the stores and migrations are main's
  own code. **Never fork main's logic into web-host** — make the stand-in more faithful.
  `src/web-host/` (ESM, `package.json` `type: module`, out of electron-builder's
  `files`):
  - `node/` — `fs` (→ `vfs.js`), `path` (POSIX always, whatever the visitor's OS),
    `crypto` (a SYNC SHA-256: project-images hashes ROM blobs synchronously),
    `string_decoder`, `Buffer`, and `globals.js` — an esbuild `inject` giving bare
    `process` (`platform` from the browser, `webBuild: true`), `Buffer`,
    `setImmediate` and `fetch` (→ `__chiphippoFetch`, which adds
    `anthropic-dangerous-direct-browser-access` for api.anthropic.com — the visitor's
    own key, from their own browser).
  - `electron.js` (app, nativeTheme → `data-theme` on every page, shell, dialog,
    safeStorage — a MASK, not encryption, and Settings ▸ AI says so via
    `settings.ai.keyStoredWeb`), `windows.js` (BrowserWindow/webContents), `ipc.js`
    (ipcMain + `dispatch`), `menu.js` (Menu/MenuItem + the Help menu + accelerators),
    `dialogs.js`, `updater.js` (replaces `app/updater.js` — a build plugin swaps it),
    `serialport.js` (the `serialport` package over Web Serial; a framing/parity/break/
    overrun error reads on from the fresh `readable`, a fatal one releases the writer and
    closes the port so a reconnect is not "already open"), `session` (no-op permission
    handlers — the browser asks for itself).
  - Bundle aliases are listed ONCE, in `bundleOptions`. `web-host/tests/build-web.test.js`
    builds both bundles: **main requiring a Node module with no stand-in fails there.**
- **The filesystem is in memory** (`vfs.js`), because main's stores are synchronous and
  every browser storage API is not. `persist.js` loads IndexedDB (`chiphippo` db,
  `files` + `records` stores) into it before main starts and writes each change back,
  coalesced; `mounts.js` mirrors the visitor's files. Paths:
  `/userData/…` (main's own — settings, the slot, ROM sidecars, credentials),
  `/web/…` (the shipped content main reads BY PATH — locales, demos, docs, datasheet
  crops — as LAZY nodes from `web-host/files.json`; all locales prefetched at boot
  since `i18n.js` reads them synchronously — English and the start language awaited,
  the rest fetched behind the boot), `/Files/<id>/<name>` (a file picked
  through the File System Access API; persisted, written back to the real file),
  `/Files/<id>/<folder>` (a picked folder, a FileList folder's too: listed, files
  ≤ 256 KiB read, the rest lazy — except the names main reads SYNCHRONOUSLY, read
  whatever their size since a browser has no synchronous read: `mounts.js`
  `MAIN_SYNC_READS`, today `*.kicad_sch` + `sym-lib-table` (`export.js`
  `writeKicadFolder`). `storage.test.js` runs `writeKicadFolder` over a mounted folder
  of files too big to be read at once, so a new sync read in main fails there until the
  list gains it. 2026-10-27 phase 7b — phase 7's "read every non-PDF file at the pick,
  ≤ 64 MiB" cost 47–87 MiB and ~25 ms a pick and could starve the schematic),
  `/Browser/<name>` (a project kept in a browser WITHOUT the API), `/Downloads/<id>/…`
  (written → downloaded; a folder → one `.zip`, `zip.js`), `/Uploads/…` (a one-shot
  read). **An IPC answer waits for `mounts.idle(call)` and `persist.idle()`**: a save the
  renderer is told succeeded has landed, and one the visitor's disk refused is
  answered as that error (`ipc.js` `settle`). 2026-10-26: each write-back is TAGGED with
  the call it was made under (`currentCall` — the handler running, else the only call
  out), so a refusal is answered to that call and not to a stash or `settings:get`
  beside it; a call with a disk write out HOLDS storage (`persist.hold`), and if the
  disk refuses, the files of main's own it unlinked (`/userData/…` — Save As's emptied
  slot) are put back before storage ever sees them gone (the desktop's write throws
  before main's next line; here main has already gone on). A failed IndexedDB batch is
  re-queued and retried, and an `idle()` with nothing new resolves whatever the retry
  meets; `busy` covers a transaction in flight. A picked file records the disk's
  `lastModified` (`diskMtime`); a write-back finding the file NEWER (a visit booted
  storage's copy before the browser let it re-read) asks `confirmReplace` (Replace /
  Cancel → `web.changedOnDisk*`). `BEFORE` re-reads a recent project from
  disk before `project:open-recent`.
  2026-10-27 (phase 7): a re-read whose disk time MOVED writes those bytes to storage
  (`persist.store`) before recording the time — a quiet `restoreFile` had left the older
  copy under the newer time, so a later visit at "prompt" booted it and ⌘S put it over
  the newer file unasked. A moved time with the SAME bytes as last read or written
  (`mount.known`, memory only — no hash on the save path) does not ask. A call notes
  `persist.generation` as it starts and settles with `idle(since)`: its own write the
  timer's flush already lost is still its failure. Tagging is `currentCalls()`: the
  handler running, else every call whose handler is still RUNNING (none in BEFORE or
  settling — a page has no AsyncLocalStorage, so two async handlers mid-await both get
  a refusal rather than whichever settles first), else every call out. A Save As the
  disk refused puts Open Recent back EXACTLY as it was (`UNDO`): what the save added
  comes out, and a full list's tenth entry it pushed off (or one it moved up) is restored
  by writing main's own `recentProjects` back to `/userData/settings.json` (main has no
  call that adds anywhere but the top), then a `project:recent:remove` of nothing so
  main re-reads, prunes and rebuilds as after any change (phase 7b). A call that has
  reached `idle(call)` is SETTLED (`#settled`): a later write tagged to it is not owed
  or kept for it — with no unsettled call left to name, it is anyone's.
- **Without the API (Safari, Firefox)** a browser can upload and download, nothing
  else: Save As of a PROJECT asks a name and keeps it in `/Browser` (the Open card
  lists those, each with Download and Delete, plus Upload from Computer…); any other
  save downloads. Main never knows — it is handed paths, as always.
- **Windows**: the app window IS the tab (the first BrowserWindow loading
  `index.html` binds to it); every other window is a real POPUP named
  `chiphippo-wc-<id>`, whose preload finds the host through `window.opener`. A popup
  is watched for `closed` (no reliable event). A browser refuses a picker or a popup
  with no click behind it, so `ui.continueWith` asks for one (Open Window, Continue).
  IPC crosses realms by `structuredClone` at both ends, as Electron serializes.
  A test can reach a popup from the tab with `window.open("", "chiphippo-wc-<n>")`.
- **No menu bar** (Jason, 2026-10-25): the page's own toolbar File pill, tab strip and
  gear carry File, Desktop and Settings, so of main's template (`buildAppMenu`) the web
  build uses only the ACCELERATORS and the **Help menu**, which hangs from a **book**
  button the header shows on the web only (left of the gear; `app.js`, glyph
  `bookSvg` from `protocol-doc-button.js`). The button only ASKS —
  `chiphippo:web-help-menu` `{anchor}` on its window — and the host draws main's Help
  submenu there (`menu.js` `toggleHelpMenu`; a second ask shuts it), adding About from
  the macOS app-name menu when Help lacks it (matched by its catalog label). Roles a
  page cannot do (window, clipboard, services, quit) and Toggle Developer Tools are
  LEFT OUT, not greyed. An enabled item's accelerator fires in any of our windows when
  the page did not `preventDefault` the key (registered after `load`, so a page's own
  handler goes first — the order a native key equivalent takes). ⌘N/⌘W/⌘T never reach
  a page; the guide says so. Project Properties… was menu-only and has no web route.
- **One tab at a time** (a Web Lock = Electron's single-instance lock): a second tab
  shows a note and does NOT run main (main's `app.quit()` there would reload forever).
  The lock is `chiphippo-app`, origin-wide — so a tab still on the old /app build holds it
  too. Every such note (`host-entry.js` `stop`) HIDES `#app`: emptied, it kept its 100vh
  and pushed the note below the page — a blank dark tab (2026-10-26, how the live site
  first looked "broken").
- **Leaving**: `beforeunload` asks (the browser's own question) when the title starts
  `• ` (the project's dirty marker) or storage is still writing; the recovery stash
  and the boot rule restore the rest, as after a crash.
- **Boot path** (2026-10-26): the version is compiled in (`__CHIPHIPPO_VERSION__`, an
  esbuild `define`) — no `version.json` fetch before main; every page carries a
  `<link rel="modulepreload">` per module of its static import graph (`withModulePreloads`,
  312 for index.html), so a cold visit fetches the unbundled renderer in one wave instead
  of 19 sequential levels.
- **Updates**: `sw.js` caches ONE release (its `BUILD` — version, a content stamp,
  the shell list — is prepended by the build; docs, datasheets and non-PWA icons are
  cached on first fetch). A new deploy installs beside it and waits; `updater.js` maps
  that onto main's `updater:*` pushes (`downloaded` → the Restart toast;
  `quitAndInstall` → skip-waiting + reload, after the close guard). `distribution()`
  is `"web"` and `selfUpdates()` is true (`store-build.js`). `?nosw` skips registering
  (it does not unregister one already there).
- **Renderer gates are few, and in ONE module**: `web/scripts/web-flavour.js`
  (`isWeb`, `serialAvailable`, `grantSerialPort`), reading `window.chiphippoWeb` the
  web preload sets. Today: Data Sheets' Download row is not offered (CORS);
  Settings ▸ Serial I/O gains **Add Device…** (`navigator.serial.requestPort()` from the
  click) or a note when the browser has no Web Serial; Settings ▸ AI's stored-key line.
- **Release → live**: `release.yml` `web` builds the zip (no Electron download) and the
  `release` job attaches it; `refresh-site` dispatches `deploy-site.yml`, whose "Put the
  web app at /desktop" step unpacks the LATEST RELEASE's zip into `website/desktop/`
  (git-ignored) before uploading the Pages artifact. So a push to main republishes the
  site but never changes the app — only `make release` does. A latest release with no zip
  (anything before the web build) falls back to `make web` from the deploy's own commit —
  ONLY then: the step asks the release's asset list first, and a zip that fails to
  download fails the deploy rather than publishing main,
  so the homepage's **Open in Browser** link (`/desktop/`, held by `website-nav.test.js`)
  never 404s. **/app, where it first lived (2026-10-24 → 25), is COMMITTED**
  (`website/app/`): a redirect page (`redirect.js` keeps `?query#hash`; a meta refresh
  without script) and a tombstone `sw.js` — an earlier visit's worker there answers /app/
  from its cache, so the next visit's update check installs the tombstone, which
  skip-waits and unregisters (no fetch handler, no cache deletes — the `chiphippo-*`
  names are origin-wide and /desktop's worker clears them — and no forced reload of an
  open tab); the next visit in a NEW tab reaches the redirect (Chrome keeps serving an
  unregistered worker's own tab, reloads included, until that tab closes — verified
  2026-10-25 in Chrome on a localhost stage). Everything in the build is RELATIVE (pages, `web-host/`, `sw.js` scope `./`), so
  the same zip works at any path. GitHub Pages ignores `_headers` (harmless) and serves
  `max-age=600`; the worker's install fetches with `cache: "reload"` regardless.
  `ci.yml` runs `make web`.
- **Tests** (`web-host/tests/`, in `make test`): Node is the oracle for the `node/`
  stand-ins; `vfs.test.js` holds io.js's atomic-write sequence; `web-boot.test.js`
  boots the REAL bundle in jsdom over `fake-indexeddb.js` and drives main over IPC
  (boot, save to storage, a refused path, the Help menu under the book, a reload finding
  the project); `app-boot-web.test.js` reruns the renderer's boot test as the web build.
