# Feature 280 — Auto-update, and the store gate

## Context

The Release workflow already builds signed installers on three native runners and
attaches them — **`latest*.yml` and the `.blockmap`s included** — to a GitHub Release.
That is a complete `electron-updater` feed, published on every tag since the workflow
was written. Nothing consumed it: `src/package.json` had no `dependencies` block at all,
no `autoUpdater` anywhere, and every packaging target passes `--publish never`. So a
release was a manual re-download, and a user who installed once ran that build until
they happened to visit the site again — indefinitely, including past a fix.

Rest Hippo solved exactly this in **its** Feature 36 and has shipped it since. The
sibling projects share an engineering setup on purpose, so this is a **port**, not a
design: the same `electron-updater` wrapper, the same push-channel shape, the same
opt-in stance, the same runtime store gate. Where the two apps differ the port follows
Chip Hippo's own vocabulary (see the design decisions below), never Rest Hippo's.

The gate matters now rather than later because the **Mac App Store** channel is being
stood up alongside the direct downloads (`make mas`, `src/build-resources/`). A
sandboxed MAS build cannot replace itself, the App Store updates it anyway, and
electron-builder strips the feed from the package — so shipping a self-updater without
the gate is a rejection, and an app that quietly fails to update is worse than one that
says it does not.

Prerequisites: the Release workflow (already publishing a feed) and the Settings dialog
(Feature 10 onward, as extended by 260's AI tab). Independent of everything else.

## Goal

The app finds a newer published release, downloads it in the background, and lets the
user restart into it when they choose. **Settings ▸ About** is where you check on
demand, see what happened, and decide whether it ever checks by itself. A store build
offers none of it, and says why.

## Design decisions (settled)

**Nothing restarts without consent, and consent is not the last word either.** An update
installs on a normal quit (`autoInstallOnAppQuit`) or through an explicitly clicked
`quitAndInstall()` — and even then the quit runs main's ordinary `before-quit` guard, so
an unsaved project is asked about first and a cancelled quit simply leaves the update
for next time. This is why declining the Restart button costs the user nothing: there is
no deadline, and no path where a design in progress is traded for a version bump.

**The updater answers; the renderer decides what to say.** Every lifecycle event is a
one-way `updater:*` push that preload re-dispatches as `chiphippo:updater-*`, and
`updater.js` owns no wording and no UI. Two surfaces consume them, deliberately
different in lifetime: `UpdaterMonitor` (session-long toasts) and the About panel's
inline status line (dialog-lifetime, hence the `dispose` its builder hands back). It is
a push rather than an invoke result because **a check can start in the Help menu**,
which never touches the window — so its outcome cannot come back as anybody's return
value, and one channel to one status line beats two paths that must agree.

**`manual` rides on every push, because silence is a design decision.** A check the user
asked for reports itself: up to date, downloading, failed. A silent startup check reports
only a find. "You're up to date" unasked is a nag, and an error nobody requested and
nobody can act on is worse. electron-updater's events carry no caller context, so main
captures it when a check starts; checks are effectively sequential, so one flag suffices.

**A build that cannot update reports a FACT, not an error.** `updater:not-available`
may carry `reason: "store-build" | "dev-build"`. Both are answers — the toast suppresses
them (a notice over the desk saying "not from here" explains nothing) and Settings ▸
About shows them, where the answer sits beside the version it is about.

**The check is OPT-IN** (`autoUpdateCheck`, default **false**). An update check is an
outbound call, and Chip Hippo makes none unasked — the same stance the AI builder and
the datasheet download already take, and the reason the app can honestly say a copy
nobody has configured never reaches the network. Off still leaves both manual routes
working; on adds one check ~10 s after launch, off the busy launch path.

**The store gate is RUNTIME, in one file** (`store-build.js`, reading Electron's
`process.mas` / `process.windowsStore`). One codebase down every channel; a
store-incompatible feature gates at runtime rather than forking the build, so there is
exactly one place to look and no second artifact to keep in step. `isMas()` stays
distinct from `isStoreBuild()` even though only the latter is used today: the two stores
are not interchangeable (MSIX is full-trust where MAS is sandboxed), so the next gate
can be scoped to the one that needs it.

**The renderer learns it is a store build from `app:info:get`'s `distribution`**, not
from a bridge flag of its own. Main is the side where `process.mas` is unambiguously
true, and the About panel already awaits that object before it draws anything — so this
costs no new bridge surface and does not depend on what the sandboxed preload's `process`
shim happens to expose. (Rest Hippo exposes `hippo.isStoreBuild` because it has other
consumers; Chip Hippo has exactly one.)

**In the Help menu the item is ABSENT, not disabled** — with its separator, so the menu
never ends on a rule. A greyed item says "not now"; there is no now in which a store
build checks. Elsewhere in this app an inapplicable item stays present and disabled (the
part context menu's fixed three), and that rule holds because those items apply
*sometimes*. This one never does.

**`require("electron-updater")` is lazy**, inside the functions rather than at module
scope. Reading the getter constructs the platform updater, which dereferences Electron's
native `autoUpdater` — absent under `node --test`, where `main.js` is read as text but
never run. Deferring it keeps `require("./updater")` inert in tests.

**On/Off is a segmented picker, not a checkbox.** The Settings card has no checkbox
anywhere; its either/or control is `segmented-picker.js` (Theme, Wire layout, AI
provider). A new control shape for a third state of the same kind would be a second
vocabulary in one dialog.

**One toast key, replaced not stacked.** The stages of a single update are one running
commentary, so they share a key — but the stack's de-dupe deliberately keeps the FIRST
toast's content and only refreshes its timer (that is what makes a standing sim warning
stable while it re-settles every tick), which would freeze the message at "Downloading…".
So the monitor dismisses before it notifies. The "ready" toast is the one that OFFERS
something, so it is sticky and carries the single action button `NotificationStack`
grew for it; that button `stopPropagation()`s, since the whole toast is a dismiss target
— the same discipline the toolbar pill readouts follow, for the same reason.

**No download-progress forwarding.** There is no progress bar to feed, so a per-chunk
IPC hop plus a DOM dispatch would be work with nothing to show for it. Milestones are
what a corner of the desk can usefully carry.

## Implementation steps

1. `src/app/store-build.js` — `isMas` / `isAppx` / `isStoreBuild` / `distribution`,
   plus `tests/store-build.test.js` pinning the truth table (strict-`true` only: Electron
   sets these or leaves them undefined, and anything else must not disable the updater).
2. `src/app/updater.js` — `initUpdater(resolveWindow)` / `checkForUpdates({manual})` /
   `quitAndInstall()`; lazy `getAutoUpdater()`, the five `updater:*` pushes, the
   store/dev short-circuits, electron-updater's own logger routed to the console.
3. `main.js` — `updater:check` / `updater:install` handlers; `distribution` on
   `collectAppInfo()`; the gated **Help ▸ Check for Updates…** item (calling
   `checkForUpdates` directly — the result comes back on the push channels regardless of
   who asked); `initUpdater` + the delayed opt-in check in `bootstrap()`.
4. `preload.js` — the five pushes in the payload-carrying loop, and
   `updater: { check, install }`.
5. `store/settings-store.js` — `autoUpdateCheck: false`.
6. `components/notification-stack.js` — optional `actionLabel` / `onAction`, plus
   `.toast-action` in `app.css`.
7. `components/updater-monitor.js` — the always-on toasts (same shape as
   `net-name-monitor.js`).
8. `components/settings-dialog.js` — `buildAboutPanel(settings)` → `{ rows, dispose }`,
   the fourth nav tab, and `dispose()` from `onClose`.
9. `src/package.json` — `electron-updater` in a new `dependencies` block (a RUNTIME
   dependency: electron-builder packs production deps, and it must ship).

## Acceptance criteria

- A packaged build finds a newer published release, downloads it in the background, and
  offers a restart; declining keeps the current version and installs on the next quit.
- **Help ▸ Check for Updates…** and Settings ▸ About's button both report up-to-date,
  progress, or an error visibly; a silent startup check reports only a find.
- With `autoUpdateCheck` off (the default) no check is made at launch; both manual
  routes still work.
- A dev build answers "only available in installed builds" rather than erroring.
- In a store build the Help item is absent, the About tab shows only the version and
  says updates come from the App Store, and `checkForUpdates` makes no outbound call.
- `ipc-parity.test.js` covers `updater:check` / `updater:install`; the five push
  channels are not scanned and need only their preload `.on` entries.

## Constraints

- No change to how a release is cut — the feed is what the workflow already publishes.
- No telemetry: the update check is the only outbound call this feature adds, and it is
  the app's third overall.
- One codebase for every channel; the store difference is runtime, never a build fork.
- `main.js` and `preload.js` stay in lockstep.

## Verify

```bash
make fmt && make lint && make test
make debug
```

Settings ▸ **About**: the version reads, **Check for updates** answers "only available
in installed builds" (proving renderer → `updater:check` → main's guard → push → status
line), and **Restart to update** is hidden until something is downloaded. Toggle **Check
automatically** and confirm the patch persists. Then, against a real published release,
confirm the download and the restart end to end.

Two checks worth doing over CDP rather than by eye, since neither is reachable from the
UI of a direct dev build: dump `Menu.getApplicationMenu()` from the main-process
inspector to confirm the Help submenu, then set `process.mas = true` in that same
process and confirm `checkForUpdates({manual:true})` pushes
`{manual:true, reason:"store-build"}` and nothing leaves the machine.
