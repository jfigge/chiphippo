---
paths:
  - "src/app/updater.js"
  - "src/app/store-build.js"
  - "src/app/store/bookmark-store.js"
  - "src/app/store/io.js"
  - "src/packaging/**"
  - "src/package.json"
  - ".github/**"
  - "STORE-PUBLISHING.md"
  - "APP_STORE_*.md"
  - "src/web/scripts/components/updater-monitor.js"
  - "scripts/asc-release.mjs"
  - "src/app/tests/packaging.test.js"
  - "src/app/tests/release-signing.test.js"
  - "src/app/tests/store-build.test.js"
  - "src/app/tests/bookmark-store.test.js"
  - "src/app/tests/io.test.js"
---

## Auto-update & the store gate

`app/updater.js` + `app/store-build.js` + `components/updater-monitor.js` + Settings ▸
About. A thin wrapper over `electron-updater`'s `autoUpdater`, pointed at the GitHub
Releases feed the Release workflow ALREADY publishes (`latest*.yml` has been uploaded
beside every installer since the workflow was written), so nothing about releasing changed
to turn this on.

- **Nothing restarts without consent**: an update downloads in the background and installs
  on a normal quit (`autoInstallOnAppQuit`) or through a clicked `quitAndInstall()`, which
  still runs main's ordinary before-quit guard, so an unsaved project is asked about first
  and a cancelled quit leaves the update for next time.
- **The updater ANSWERS; it does not decide what to say.** Every lifecycle event is a
  one-way `updater:*` push re-dispatched as `chiphippo:updater-*`, and the renderer owns
  every word: `UpdaterMonitor` (always-on toasts, session-long, ONE shared toast key so the
  stages of one update replace each other rather than stacking) and the About panel's
  inline status line (dialog-lifetime, hence its `dispose`). Each push carries **`manual`**
  — main's record of whether a human pressed the button — because the difference between
  "you're up to date" and silence is entirely whether it answers a question that was asked.
  A `reason` (`"store-build"`/`"dev-build"`) rides on not-available, so a build that CANNOT
  update reports a fact rather than an error. `download-progress` is deliberately never
  forwarded: there is no progress bar to feed.
- **A store build is gated at RUNTIME, never by branching the build** (`store-build.js`, the
  only place that reads Electron's `process.mas` / `process.windowsStore`). The MAS updates
  its own apps, electron-builder strips the feed from a MAS package, and the sandbox forbids
  an app replacing itself — so `checkForUpdates` short-circuits, the Help item is absent
  rather than disabled, and About hides its controls and says why. The renderer learns this
  from **`app:info:get`'s `distribution`** rather than a bridge flag of its own: main is the
  side where `process.mas` is unambiguous, and the panel already awaits that object.
- **The check is OPT-IN** (`autoUpdateCheck`, default false) — an outbound call, and Chip
  Hippo makes none unasked. Off still leaves both manual routes working; on adds one delayed
  check ~10 s after launch, off the busy launch path. **`require("electron-updater")` is
  deliberately LAZY** (inside the functions, not at module scope): reading the getter
  constructs the platform updater, which dereferences Electron's native `autoUpdater` —
  absent under `node --test`, where `main.js` is read but never run.

## Mac App Store packaging

`src/packaging/` + the `mas`/`masDev` blocks in `src/package.json` + `make mas` /
`make mas-dev` + `app/store/bookmark-store.js`. ONE codebase down every channel: a store
build is the same code with `store-build.js`'s runtime gate turning the updater off.
`make mas` signs a universal `.pkg` (Apple Distribution for the app, 3rd Party Mac
Developer Installer for the installer) and `make mas-dev` a locally-runnable sandboxed
build to try first; both SKIP with a message and exit 0 when their git-ignored
`src/packaging/*.provisionprofile` is absent, so a fresh clone still builds everything else.
See STORE-PUBLISHING.md for the submission itself.

- **The sandbox forgets every launch, and two features depend on remembering.** A sandboxed
  app may touch a path only if a native dialog handed it over in THIS process — which breaks
  Open Recent (`settings.recentProjects`, read again at `bootProject` and
  `openRecentProject`) and the external datasheet folder (`settings.datasheetDir`). The
  answer is **security-scoped bookmarks**: minted by the dialog that granted the path
  (`dialogOpts` + `captureOpen`/`captureSave` — note the save panel's SINGULAR `bookmark`
  against the open panel's array), redeemed through `withAccess` for a one-shot read or
  `hold("project", …)` for the open project's whole session, and stopped on `will-quit`.
  They live in a MAIN-ONLY sidecar (`userData/bookmarks.json`), never in `settings.json`
  (handed to the renderer whole on every read), and there is **no IPC channel and no preload
  export at all** — `ipc-parity.test.js` is untouched and the renderer never learns bookmarks
  exist. `knownPath` is unchanged and unbypassed: it answers whether the RENDERER may aim
  main at a path, a bookmark answers whether the KERNEL will allow it, and both must say yes.
- **A scope is PROVED, not assumed — and this was got wrong once, expensively.** Electron
  hands back a stop function, not a resolved path, so a dead blob and a live one are the same
  value at that line. The original reasoning was that every caller's next `existsSync` would
  answer false for anything unreachable. **IT DOES NOT**: the App Sandbox answers metadata
  questions about paths it refuses to open, so `existsSync` returns TRUE for a file that then
  raises `EPERM`. Worse, the commonest bookmark in the app is stale BY CONSTRUCTION — a SAVE
  panel with `securityScopedBookmarks` creates a blank file and mints a bookmark against it
  that never resolves again (**electron/electron#32544**, open upstream since 2022) — so
  every project created with Save As failed to reopen on the next launch with a raw `EPERM`
  in a dialog. So `_start` VERIFIES the scope it just obtained with the read the caller is
  about to do (`readable` — a `readdirSync` for a directory, an `openSync` for a file,
  because those are the calls actually made; `existsSync`/`accessSync` are the ones that
  lie), stops and drops a blob that fails, and `canAccess` lets a caller tell **gone** from
  **denied**. They need opposite offers, which is the whole point of splitting them: a file
  that moved is forgotten, a file merely out of reach is **re-granted** through
  `project:regrant` — an OPEN panel aimed at that exact path, whose bookmark does survive, so
  the repair is permanent and asked once per project rather than once per launch. The panel's
  answer is checked against the path asked about: picking a different file is refused, never
  reinterpreted, or a permission prompt would become an open-any-file gesture that skipped
  the MRU allowlist.
- **`atomicWrite` cannot be atomic in a store build, and that is not a bookmark problem.**
  `io.js` writes `<file>.chiphippotmp-N.tmp` beside its target and renames over it; a save
  panel's grant covers the chosen FILE, not the folder holding it, and that temp name is not
  in the same-basename form the sandbox forgives as a related item. So under `isMas()` ONLY,
  and only after a genuine `EPERM`/`EACCES`/`EROFS`, it falls back to a durable in-place
  write — a direct build's atomicity is byte-for-byte what it was. The cost is real and
  stated where it is paid: a store build's writes to USER-CHOSEN files are no longer
  crash-atomic. Everything the app owns is under `userData`, inside the container, where the
  atomic path still works — including the 30-second autosave slot, so the work is still
  recoverable.
- **`mas-dev` deliberately does not pin `CSC_NAME` the way `mas` does.** electron-builder
  applies one name qualifier to BOTH the `.app` and `.pkg` identity searches, so `mas` pins
  the substring common to *Apple Distribution: Jason Figge (2C564TQ2FY)* and *3rd Party Mac
  Developer Installer: …(2C564TQ2FY)* — anything more specific finds no installer certificate
  at all. The development profile embeds *Apple Development: Jason Figge (F457H24AUH)*, whose
  parenthetical is a per-developer identifier, NOT a team id and NOT a mismatch (both are
  under `2C564TQ2FY`, the cert's OU field) — but it is enough for the pin to filter out the
  one certificate that profile authorizes.
- The entitlements are six keys and no more (`entitlements.mas.plist`, committed and
  commented): `app-sandbox`, `cs.allow-jit`, `files.user-selected.read-write`,
  `files.bookmarks.app-scope` — **without which the dialogs return EMPTY bookmark strings and
  the two features above quietly stop working a launch after install** — `network.client`
  for the AI builder and the datasheet download, and `device.serial` for the Arduino
  integration (the sandbox refuses to open a `/dev/cu.*` without it). `app/tests/packaging.test.js` holds the
  config to them, and to their absences (`disable-library-validation` is forbidden under the
  sandbox; `network.server` would ask for something nothing listens on), on every platform
  and with no Apple material present.

## Release signing (the direct-download mac build)

`make dist-mac` signs and notarizes from the ENVIRONMENT, and must never pin either off:
`release.yml` exports `CSC_LINK`/`CSC_KEY_PASSWORD` (a Developer ID Application .p12)
only when that secret exists, and inside that branch the notarization credentials —
`APPLE_ID` + app-specific password + team id, or else the App Store Connect API key the
store job already holds (decoded to `$RUNNER_TEMP/*.p8` as `APPLE_API_KEY`). A
`-c.mac.notarize=false` on the recipe once shipped every release un-notarized however many
secrets were set, which made `website/code-signing-policy.html` untrue;
`app/tests/release-signing.test.js` now reads the recipe as well as `build.mac`. The store
job's temporary keychain needs electron-builder ≥ 26.16.1: before it, `importCerts` passed
the .p12's passphrase to `set-key-partition-list -k`, which macOS 15 ignored and macOS 26
(the `macos-latest` image the v1.1.0 release ran on) rejects.

## Linux packaging

The AppImage is built with electron-builder's **`toolsets.appimage: "1.0.2"`**: the legacy
toolset's arm64 launcher links the UNVERSIONED `libz.so` (only zlib's `-dev` package
provides it), so it did not start on a stock Raspberry Pi OS or Ubuntu; 1.0.2's launcher is
static, and needs no `libfuse2` either. The `.deb` states its **`depends`** in full — a
custom list REPLACES electron-builder's defaults — adding `libasound2t64 | libasound2` and
`libgbm1`, which Electron loads and the defaults omit (a minimal system installed the
package and then could not start it). Both are held by `app/tests/packaging.test.js`, and
were proved in fresh `ubuntu:24.04` containers (arm64 native, x64 emulated): the deb's
binary resolves every library, and both packages run the Mock loop under `xvfb`.
