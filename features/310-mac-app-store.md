# Feature 310 — Mac App Store packaging

## Context

Chip Hippo ships direct downloads and nothing else. Three places in the tree already
promise otherwise: `src/app/store-build.js` describes "the Mac App Store package
`make mas` builds", `features/ROADMAP.md` carries the channel as backlog, and Feature
280's own plan cites `make mas` as the reason its store gate exists. None of it was
there — no `mas`/`masDev` electron-builder blocks, no entitlements, no `make mas`.

Feature 280 landed the RUNTIME half: `store-build.js` reads Electron's `process.mas`,
the self-updater switches itself off, the Help item disappears and Settings ▸ About
says the store manages updates. This feature is the BUILD half, plus the two things
the App Sandbox breaks that no amount of build configuration can fix.

Rest Hippo has shipped a Mac App Store build since its own store work, so — as with
Feature 280 — this is a **port**, not a design. It diverges in three places, each
argued below.

## Goal

`make mas` produces a signed, universal `.pkg` ready for Transporter, and `make mas-dev`
produces a locally-runnable sandboxed build to try first. The sandboxed app is not a
lesser one: Open Recent and the external datasheet folder keep working, which they
cannot do without deliberate work.

## Design decisions (settled)

**The targets are `mas` and `mas-dev`, not Rest Hippo's `dist-mas`.** Two comments in
the tree already promise `make mas`; honouring a promise the code makes beats matching
the sibling's name.

**The sandbox forgets every launch, and TWO features depend on remembering.** A
sandboxed app may touch a path only if a native dialog handed it over in THIS process.
Chip Hippo re-reads `settings.recentProjects` (Open Recent, and `bootProject`'s startup
fallback) and `settings.datasheetDir` (read when a pin-assignments window opens) in
later sessions. The fix is security-scoped bookmarks — `app/store/bookmark-store.js`,
the ONE place that mints, stores and redeems them — rather than switching the two
features off in the store build. A bookmark is a capability, so it lives in a main-only
sidecar (`userData/bookmarks.json`) and not in `settings.json`, which is handed to the
renderer whole on every read; there is no IPC channel and no preload export, so
`ipc-parity.test.js` is untouched and the renderer never learns bookmarks exist.

**Staleness is not a new failure mode.** Electron hands back a stop function, not a
resolved path, so nothing can ask whether a bookmark still points where it did. It does
not need to: every caller's next step is already an `existsSync` on the stored path,
which answers false for a file that moved — and `{ok:false, code:"missing"}`, the
renderer's "that file is gone, forget it?" prompt, is already what happens then.

**`atomicWrite` cannot be atomic in a store build, and that is not a bookmark problem.**
`io.js` writes `<file>.chiphippotmp-N.tmp` beside its target and renames over it. A save
panel's grant covers the chosen FILE, not the folder holding it, and that temp name is
not in the same-basename form the sandbox forgives as a related item — so saving a
project to the user's own file, exporting a desktop and exporting a ROM would all fail
at the temp create. Under `isMas()` only, and only after a real `EPERM`/`EACCES`/`EROFS`,
`atomicWrite` falls back to a durable in-place write. The cost is stated where it is
paid: a store build's writes to USER-CHOSEN files are no longer crash-atomic. Everything
the app owns is under `userData`, inside the container, where the atomic path still
works — including the 30-second autosave slot, so the work remains recoverable.

**`mas-dev` must not pin `CSC_NAME` the way `mas` does.** electron-builder applies one
name qualifier to both the `.app` and `.pkg` identity searches, so `mas` pins the
substring common to *Apple Distribution: Jason Figge (2C564TQ2FY)* and *3rd Party Mac
Developer Installer: Jason Figge (2C564TQ2FY)*. The development profile embeds *Apple
Development: Jason Figge (**F457H24AUH**)*, and that parenthetical is neither a team ID
nor a mistake — Apple names development certificates after a per-developer identifier
where the distribution ones carry the team, and both certs are in fact under team
`2C564TQ2FY` (the certificate's OU). Only the STRING differs, which is enough: the same
pin would filter out the only certificate that profile authorizes.

**No `entitlements.mac.plist`.** Notarizing the Developer ID build is a separate backlog
item; shipping a hardened-runtime plist now would imply it works.

## Implementation steps

1. `app/store/bookmark-store.js` + `app/tests/bookmark-store.test.js` — pure, no call
   sites touched.
2. `app/store/io.js` — the in-place fallback + its two tests in `io.test.js`.
3. `app/main.js` — dialogs (`dialogOpts`/`captureOpen`/`captureSave`), later-session
   reads (`withAccess`), the session `hold` in `adoptProject`, `releaseAll` on
   `will-quit`, `prune` on the MRU list changing.
4. `src/packaging/` (two entitlements plists, committed; two profiles, git-ignored),
   the `mas`/`masDev` blocks in `src/package.json`, `app/tests/packaging.test.js`, and
   the `mas`/`mas-dev` Makefile targets.
5. `STORE-PUBLISHING.md`, `APP_STORE_TODO.md`, CLAUDE.md, this file.

## Acceptance criteria

- `make mas` → a universal `.pkg` signed by Apple Distribution, its installer signed by
  3rd Party Mac Developer Installer.
- `make mas-dev` → an app that launches sandboxed rather than being AMFI-killed.
- Both skip with a message and exit 0 when their profile is absent.
- The signed bundle's entitlements are exactly the five in `entitlements.mas.plist`,
  plus the application-identifier / team-identifier / application-groups keys
  electron-builder injects from the profile.
- In a store build: Save As, quit, relaunch, Open Recent re-opens the file; the same
  round trip for the datasheet folder; a moved file reports "missing".

## Constraints

- The renderer gains no new surface: no IPC channel, no preload export, no new string.
- Off a Mac App Store build, every bookmark method is inert and `atomicWrite` is
  byte-for-byte what it was.
- The provisioning profiles are never committed (`*.provisionprofile` is git-ignored).

## Verify

`make test` (the packaging and bookmark guards run everywhere), then `make mas-dev` and
the relaunch round trips above, then `make mas` and `pkgutil --check-signature` /
`lipo -archs`. See STORE-PUBLISHING.md for the submission itself.
