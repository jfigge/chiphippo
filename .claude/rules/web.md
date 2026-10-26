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
    `serialport.js` (the `serialport` package over Web Serial).
  - Bundle aliases are listed ONCE, in `bundleOptions`. `web-host/tests/build-web.test.js`
    builds both bundles: **main requiring a Node module with no stand-in fails there.**
- **The filesystem is in memory** (`vfs.js`), because main's stores are synchronous and
  every browser storage API is not. `persist.js` loads IndexedDB (`chiphippo` db,
  `files` + `records` stores) into it before main starts and writes each change back,
  coalesced; `mounts.js` mirrors the visitor's files. Paths:
  `/userData/…` (main's own — settings, the slot, ROM sidecars, credentials),
  `/web/…` (the shipped content main reads BY PATH — locales, demos, docs, datasheet
  crops — as LAZY nodes from `web-host/files.json`; all locales prefetched at boot
  since `i18n.js` reads them synchronously), `/Files/<id>/<name>` (a file picked
  through the File System Access API; persisted, written back to the real file),
  `/Files/<id>/<folder>` (a picked folder: listed, small files read, big ones lazy),
  `/Browser/<name>` (a project kept in a browser WITHOUT the API), `/Downloads/<id>/…`
  (written → downloaded; a folder → one `.zip`, `zip.js`), `/Uploads/…` (a one-shot
  read). **An IPC answer waits for `persist.idle()` and `mounts.idle()`**: a save the
  renderer is told succeeded has landed, and one the visitor's disk refused is
  answered as that error (`ipc.js` `settle`). `BEFORE` re-reads a recent project from
  disk before `project:open-recent`.
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
- **Leaving**: `beforeunload` asks (the browser's own question) when the title starts
  `• ` (the project's dirty marker) or storage is still writing; the recovery stash
  and the boot rule restore the rest, as after a crash.
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
  (anything before the web build) falls back to `make web` from the deploy's own commit,
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
