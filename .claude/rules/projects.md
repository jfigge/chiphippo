---
paths:
  - "src/app/store/project-*.js"
  - "src/app/store/mem-store.js"
  - "src/app/store/recent-files.js"
  - "src/app/store/desk-store.js"
  - "src/app/close-guard.js"
  - "src/web/scripts/components/project-*.js"
  - "src/web/scripts/components/memory-*.js"
  - "src/web/scripts/components/desktop-exporter.js"
  - "src/web/scripts/model/project-doc.js"
  - "src/web/scripts/model/design-clip.js"
  - "src/web/scripts/model/hex-format.js"
  - "src/web/scripts/model/history-store.js"
  - "src/web/memory.html"
  - "src/web/scripts/memory.js"
  - "src/web/scripts/tests/project-*.test.js"
  - "src/web/scripts/tests/memory*.test.js"
  - "src/web/scripts/tests/mem-*.test.js"
  - "src/web/scripts/tests/design-*.test.js"
  - "src/app/tests/project-*.test.js"
  - "src/app/tests/mem-store.test.js"
  - "src/app/tests/close-guard.test.js"
  - "src/app/tests/recent-files.test.js"
---

## Memory chips

**Volatility decides everything** (`isVolatileMemory`).

- A **volatile SRAM** (`ram-8k`/`HM62256`/`AS6C1024`, flagged `volatile`) is never
  file-backed — run-volatile only.
- A **non-volatile ROM/EPROM/EEPROM** is backed by a real `.bin` **sidecar** in
  `userData/memory/<guid>.bin`. The document stores only `params.storage =
  { guid, source?, edited? }` (a `crypto.randomUUID()` minted on placement) plus a
  `programmed` flag — **never the bytes**. `source` is a LABEL, NEVER A PATH: nothing
  resolves it, opens it or hands it to `fs`, which is what makes it safe to keep an
  absolute path written on someone else's machine; `edited` marks bytes hand-changed in
  the inspector since.
- **The CIRCUIT can never write a file-backed chip.** EEPROM/EPROM are treated as ROMs
  (the app can't drive a write cycle), so `SimController` drops any reported write to a
  non-volatile chip and loads each ROM's file on Run (an async gate before the first
  tick), warning when a chip flagged `programmed` finds its file missing (the
  delete-then-undo data-loss case). A ROM is programmed only by the in-app **external
  programmer** (a menu action: pick a `.bin`/`.hex`, copy it to the file's start with a
  size warning).
- **All file I/O is in main**, over the GUID-keyed, parity-guarded `mem:*` IPC
  (`create`/`load`/`program`/`write`/`delete`/`path`/`pick-image`/`export`) — main alone
  maps a GUID → path and rejects a hostile one. `app/store/mem-store.js` is
  byte-oriented + atomic over `io.js`: `create` fills a fresh file with **random noise**,
  `program` copies an image to the file's start (short writes a prefix, long truncates,
  both warned), plus `writeAll`/`remove`. Lifecycle rides the DeskController:
  `#provisionMemory` on placement, `#releaseMemory` on removal, and a `programmed` chip
  whose file has gone is recreated as noise and warned.
- Since Feature 250 `userData/memory/` is a **cache**, not the source of truth: a
  programmed chip's bytes are collected into the PROJECT file on save and hydrated back
  on open (`app/store/project-images.js`).
- **The inspector** is a floating OS window per component (`web/memory.html` →
  `scripts/memory.js` → `components/memory-inspector.js`). Being its own sandboxed
  renderer it reaches the main renderer ONLY through main's `memory:*` relay
  (`open`/`to-inspector`/`to-host`, re-dispatched by preload as
  `chiphippo:memory-inbound` / `chiphippo:memory-host-inbound`). The grid is
  **virtualized** (a reused row pool — a 32 KiB image is ~30 rows in the DOM),
  **editable when stopped** for a ROM (Save writes its file) and a **read-only live
  viewer** for SRAM and any running chip (it mirrors the engine-owned image, never writes
  it). Intel HEX ⇄ bytes is the pure `model/hex-format.js`.
- The renderer-side **`components/memory-bridge.js`** answers a window's `ready` with its
  chip context (kind + GUID + display path + the image's source file and whether it has
  been edited, or the live bytes while running), runs the programmer + Save **through the
  controller** (so `programmed` and the source label ride undo/redo together), and
  streams `chiphippo:mem-state` byte writes out to open windows.

## Projects, files & desktops

**THE PROJECT IS THE DOCUMENT.** ONE file — `<name>.chiphippo` — holds every desktop's
desk document AND every programmed ROM's bytes, so there is one dirty marker, one Save,
one Save As, one recent list and one File menu.

```jsonc
{ version: 5, name, description?, wheelLocked?, activeTab, nextIndex,
  tabs:   [ { id, name, description?, doc } ],
  customChips?: [ { id: "custom-<8hex>", name, ports, units, code, … } ], // placed ones
  images: { "<rom-guid>": { "blob": "sha256-<hex>" } },  // programmed ROMs only
  blobs:  { "sha256-<hex>": "<base64>" } }               // stored once, shared
```

Code: `app/store/project-store.js` + `project-images.js` + `project-migrate.js` +
`model/project-doc.js` + `components/project-workspace.js` + `components/project-tabs.js`
+ `model/design-clip.js`. The whole file surface is
`project:boot`/`:new`/`:open`/`:open-recent`/`:save`/`:choose-path`/`:regrant`, plus
`desktop:export`/`:import`/`:duplicate`.

- **A tab is a DOCUMENT, not a second desk.** There is exactly one `DeskView` /
  `DeskController` / `SimController` / palette / guide / analyzer; switching desktops
  SWAPS THE DOCUMENT in place through `DeskController.loadDocument` — the same
  `restore` + `#rebuildScene` path undo/redo has used since Feature 200. **Nothing in the
  app reloads the window any more**: `#rebuildScene` is the in-process teardown that made
  `window.location.reload()` unnecessary. The ACTIVE desktop's document lives in the
  shared `DeskDoc`; `#stash()` folds it back into the meta whenever the WHOLE project is
  needed (save, switch, export, dirty test), and every other desktop's sits in
  `meta.tabs[].doc`. `ProjectWorkspace` keeps PER TAB only the camera and its own
  `HistoryStore`, so ⌘Z after switching back undoes THAT desk's last edit. A camera is
  deliberately not in the file (panning must never mark a design dirty, and neither must
  switching tabs — `projectSignature` drops `activeTab`). A switch stops the sim and
  closes the aux windows (`c3` on one desktop is a different chip from `c3` on another);
  the copy buffers deliberately survive it, which is what makes a cross-desktop paste
  work.
- **There is always a project**, from first launch: `project:boot` always answers with
  one, so `app.js` has no project/no-project branch. An unsaved project — blank `name`,
  blank `location` — lives in the ONE fixed working slot `saves/default.chiphippo`, which
  is to a project what `desk.json` used to be to a schematic. **Startup**
  (`bootProject`) is that read backwards: the working slot if it exists, else the head of
  `settings.recentProjects` still on disk, else a new project. The slot's file exists
  exactly while the open project is unsaved (`project:save` to a real path drops it —
  `dropDefault` — and so does opening another project). **A new project is always exactly
  one desktop**, numbering restarted at 1; `addDesktop` mints the next `Desktop N`
  (`nextIndex` only counts up) with no dialog at all.
- **Nothing is written to the user's file until you save.** Adding, renaming,
  duplicating, importing and deleting a desktop are plain unsaved changes, so "close
  without saving" is a complete, honest revert of the session.
- **And nothing is lost to a crash, because those are different questions.** Every
  `AUTO_SAVE_MS` (30 s) the open project is stashed in the app's own WORKING SLOT — never
  the user's file — so the • still means "not in your file". The slot means one of two
  things, and a `recoveryFor` stamp is the difference:
  - **unstamped** — an untitled project's actual home. A stash IS a save, so it goes
    through the ordinary `#writeProject` and the • CLEARS. A clean quit keeps it.
  - **stamped** — a copy of a project that HAS a file, holding work that file does not.
    Dropped by any save to a real path (main enforces that, so a call site cannot forget)
    and by a clean quit — so "a stamped slot exists at startup" means exactly "the last
    session did not finish". That is the whole crash detector: no timestamps, which cloud
    sync and a corrected clock will both lie about.
  - **Two baselines** follow: `#saved` is the project as its FILE holds it and drives the
    •; `#stashed` is it as the SLOT holds it and is what the tick compares. They part
    company the moment a stash gets ahead of the file — the normal state for a titled
    project, and why the tick cannot just watch `dirty` (true from the first edit until
    ⌘S, so it would rewrite the same bytes forever).
  - The tick does NOT listen for `chiphippo:doc-changed`: that event is wrong in both
    directions — `#setTabProperty`/`#setProjectProperty` never dispatch it (a rename
    would never be stashed) and it fires on load and on every undo/redo restore (nothing
    to write). `#imagesTouched` is the one change no signature can see (a ROM's bytes
    live in a sidecar; `setMemoryProgrammed` writes `true` over `true`, and for a re-load
    of the SAME file an identical `storage` too), so `MemoryBridge` reports it through an
    injected `onImagesChanged`.
  - **A restore is not a question.** `recoveryBoot` restores the stash outright and the
    renderer says so (`workspace.recovered*` — main hands over the FACTS
    `{name, path, homeless}`, since `m()` is for text MAIN renders). Restored work
    arrives UNSAVED (`#saved`/`#stashed` left null) so ⌘Z and close-without-saving both
    still work; a launch modal would ask for an irreversible-looking decision about a
    reversible thing with the destructive button one mis-click away. A recovery whose own
    file has gone restores as UNTITLED, so Save As re-homes it.
  - Guards: `#busy` (a leave/quit question is out, or a swap is mid-flight — a stash then
    would preserve the very work being discarded), `#inFlight` (a tick SKIPS, a manual ⌘S
    QUEUES, since `#askUnsaved` reads a `false` as a cancel), `#autoStopped` (a STATE,
    not merely a cleared interval, because `autoSaveNow` is public) and `#autoSaveFailed`
    (one quiet failure RETIRES the tick rather than reopening the same modal every 30 s).
    `#writeProject`'s baseline is **the bytes that went** (`projectSignature(written)`),
    never `#project` after the await — every META edit reassigns `#project`, so the old
    code folded an unwritten rename into the baseline and lost it. `visibilitychange`
    flushes on the way out of sight; the interval `unref?.()`s (a real `Timeout` under
    `node --test` would keep the runner alive per constructed workspace);
    `autoSaveMs: 0` is the harness's off switch.
- **Save vs Save As.** `save()` on an untitled project writes the working slot SILENTLY —
  designing something and keeping it must never require choosing a file — and `saveAs()`
  is what gives it a home, taking the project's NAME from the file picked (so there is no
  name prompt in front of the save panel). Replacing an existing file is the NATIVE
  dialog's question and only its question (`properties: ["showOverwriteConfirmation"]` is
  how the Linux panel is told to ask); `choosePath` returns a path or null, so declining
  a replace reads back as a cancel.
- **ROM bytes travel in the file, content-addressed** (`project-images.js`). `write`
  COLLECTS every chip flagged `programmed`, HASHES its bytes and records chip → blob
  (noise does not need to travel); `read` HYDRATES them back before the renderer sees the
  project; `reseatImages` gives a COPIED desktop (Import, Duplicate) fresh guids and
  fresh files so two chips can never share one. `desktop:duplicate` takes an optional
  second argument, `images` (guid → base64), for a bundled CPU example whose ROM's program
  arrives in its payload (generated-circuits.md); a plain Duplicate passes none and copies
  from the cache. An Import taken from a whole PROJECT file
  reads it `{hydrate: false}` and hands the bytes to the reseat as `images`: hydrating
  wrote the file's guids — the OPEN project's own, when the file is a copy or backup of
  it — straight over the live sidecars. This is the second place in main with
  document knowledge after `migrations.js`, and equally narrow — it reads
  `components[].params.storage.guid` + `params.programmed` and nothing else.
  - **The bytes are the key**: identical images name ONE blob however many chips or
    desktops hold them (four desktops sharing an 8 KiB ROM: 14 916 bytes against v4's
    47 688), and a file re-read after being edited on disk hashes differently and becomes
    a second blob. **The hash is main's, taken at save time from the real sidecar** —
    never stored in the document, where it would have to be re-derived on every hand-edit
    and a stale one would restore the WRONG BYTES. It is a DEDUP KEY, not a checksum: the
    read path must never verify it and skip on a mismatch, since the only useful response
    to one is to write the bytes anyway.
  - **The per-chip entry is an OBJECT, and that is load-bearing**: an OLDER build runs
    `Buffer.from(value, "base64")` over `images`, and a bare hash string decodes to 53
    non-zero bytes — past the zero-length guard, over a good sidecar, and collected back
    by that build's next save. An object is not a string, so the old loop SKIPS it and
    the existing "programmed, but its data file is missing" warning explains itself.
    Honest degradation, not corruption.
  - **Dedup lives in the file, never in the cache** — one `.bin` per chip is what keeps
    `#releaseMemory`'s unconditional delete-by-guid correct with no refcounting. A v4
    file (inline base64, no `blobs`) still reads: `imagesOf` flattens EITHER shape into
    the `guid → base64` map every consumer already speaks — dispatching on the structural
    tell, and aliasing rather than copying a shared blob — so `hydrateImages`,
    `reseatImages` and `copyImage` are untouched. The cache is never SWEPT.
- **Changing projects or quitting** runs through `#confirmLeaveProject`, which on "save"
  LETS THE ACTION GO AHEAD (the user is not made to ask twice). Quitting is the silent
  case (no Save button was clicked, so nothing is asked about WHERE). Changing projects
  differs in one way: an UNTITLED project **that holds something** is asked about dirty
  or not, because it lives in the one working file the incoming project is about to claim
  and there is nowhere else for it to go — so "save" there means `saveAs`. The exception
  is the state the app BOOTS INTO: a **pristine** project (`#isPristine` — no name, no
  description, ONE desktop, `isEmptyDocument`, not dirty) is let go silently, or the very
  first New or Open of a session would open with a save-or-discard question over a blank
  desk. Both halves are load-bearing: an unsaved change is caught by `dirty`, one already
  ⌘S'd into the slot by the project still holding something. `isEmptyDocument` reads only
  the CONTENT lists (derived from `emptyDocument()`, so a list added later can't be
  forgotten) and never the `next*Id` counters — those say what a desk has ever held. A
  SAVED project has a file nothing is claiming, so it is asked about only when dirty.
- **Every path resolves `false` for a cancel**, and a save that never landed IS a cancel:
  `save`/`saveAs`/`exportTab` all return `Promise<boolean>` and every dialog is
  promise-wrapped, since PopupManager fires its callbacks on EVERY dismissal path (mask
  click included) so an awaiting caller can't hang. The converse: a file that was PICKED
  but holds no project answers `{ok:false, code:"invalid"}` (Open, Open Recent, re-grant)
  and is SAID, never read back as a cancel — and it is left where it is. `io.readJSON`'s
  quarantine (rename a corrupt file aside) is for the app's OWN files only; the project
  store passes `{quarantine: false}` for any path but the working slot, since renaming a
  user's truncated project out of its folder with nothing said is a disappearance.
- **The guard must ANSWER, and answering is three separate promises** — main waits on
  `confirmClose()` with NO TIMEOUT and LATCHES `closePending` until the reply lands, so
  anything less than an answer is an app that can never be closed again:
  - **it settles** — PopupManager fires a callback and DISCARDS what it returns, so an
    `async onChoose` that rejected skipped its own `resolve` and left the promise pending
    for the life of the process. `#askUnsaved` now catches and resolves FALSE.
  - **it never rejects** — `confirmClose()` reads the live document (the dirty test),
    which can throw before any dialog is up. It catches, reports through `#fail`, and
    answers false.
  - **it never answers TRUE by accident** — `app.js`'s handler used to default `ok` to
    `true` on a throw, trading the user's unsaved project for an unwedged app. Main's
    latch is per-attempt, so blocking costs ONE refused ⌘Q while proceeding costs the
    work. **A failed guard is never permission to discard.**
  - Underneath, `#doWrite`/`#writeRecovery` put their WHOLE body in the try (`#stash()`
    and `projectForFile()` included) so "a write answers, it doesn't throw" is enforced
    rather than asserted, and `#serialize` awaits its predecessor as
    `prior.catch(() => {})` so one failed write can't reject the chain behind it.
    `PopupManager` routes every callback through `fire()`, which reports a throw or
    rejection instead of dropping it. Main's backstop is `watchRendererForClose`: a
    renderer that CRASHES mid-question releases the latch. A renderer that is alive and
    silent is invisible from there, which is why the guarantee lives on the renderer
    side.
  - **Main's half is `app/close-guard.js`** — the three flags and their transitions with
    no Electron in them, so `main.js` keeps only the event wiring. **The confirmation
    authorises ONE close and no other**, which is what `closed()` is for: it used to be a
    one-way latch, and on macOS (where closing the last window does not quit) that was
    silent data loss — close, answer "discard", click the dock icon, and the fresh window
    inherited a set latch, so every later close and ⌘Q skipped the guard entirely.
  - **Whether there is anybody to ask is the renderer's to SAY** (`app:close-ready`, sent
    once app.js has registered its handler → `closeGuard.rendererReady`; cleared by
    `render-process-gone`, `destroyed` and `did-start-loading`). It was guessed from
    `webContents.isDestroyed()`, which stays false after a renderer CRASH — so a crashed
    window re-asked a dead page, latched, and could neither be closed nor quit; likewise a
    page that failed to load. Until the page is ready it holds nothing unsaved, so a close
    proceeds. A reply with no question pending, or from any window but the main one,
    authorises nothing.
  - **Restart-to-update is a close-guard question too** (`ask({installing})` → reply
    `"install"`): electron-updater's `quitAndInstall` spawns the installer BEFORE it quits
    on Windows and Linux, so leaning on the ordinary before-quit question made "Cancel"
    too late to stop the update. Main calls `quitAndInstall` only after a yes.
- **Export / Import replaced a desktop's Save As / Open.** A `.desktop.chiphippo` is a
  SNAPSHOT (the document plus its ROM bytes, no link retained), so it can never dangle.
  Import is always an ADDITION (no file operation can replace the desk on screen) and
  re-mints the snapshot's ROM guids, so importing twice leaves two independent copies.
  Opening a bare `.desktop.chiphippo` (or a loose `.chiphippo` design) wraps it in a new
  one-desktop project with NO location.
- **Every desktop is a peer**: any can be renamed, duplicated, exported or deleted; the
  ONE rule is that a project keeps at least one, mirrored by the strip disabling Delete
  on the last tab. A tab's context menu is the **board's** shape — Properties… ·
  Duplicate · Export… · rule · Delete Desktop — not the part menu's, since a desktop has
  no pins. There is no per-tab dirty dot (a desktop cannot be saved on its own, so a
  marker no action could clear would be a lie). **Properties…** opens the shared
  `PartPropertiesDialog` with the universal Name/Description pair alone (the description
  shows in the tab's tooltip); the PROJECT has the same dialog (File ▸ Project
  Properties…) plus one `"readonly"` **Location**, blank until saved — a desktop has
  none, because it is not a file.
- **The strip is always on screen** (there is always a project), and the `+` beside it
  splits the way a TAB does: a PRIMARY click adds a desktop with no menu and no
  questions, a SECONDARY click drops **New Desktop** · **Import Desktop…**. Those are the
  two ways a desktop ARRIVES and neither belongs to a particular tab; both land on the
  new desk, and both mirror the Desktop menu's leading pair, so the wordings must stay in
  step. A THIRD way — a chip's **example circuit** — deliberately lives on that part's
  pin-assignments window, because it belongs to a PART.
- **v3 → v4** (`project-migrate.js`): a project that listed desktop PATHS has them
  inlined on read, NON-DESTRUCTIVELY — a desktop file the user saved somewhere of their
  own is read and left where it is. A tab whose file has gone opens EMPTY with a warning
  naming it. `upgradeLegacyDefault` is the one destructive case: it rewrites the old
  working slot as v4 and only THEN removes the v3 file and the app-kept desktops it alone
  pointed at — only those whose document was actually READ into the project
  (`migrateLegacyTabs`' `inlined`; an unreadable one is all that is left of that
  desktop and stays) — returning its warnings for `bootProject` to carry out on the meta.
  A slot that already exists is never overwritten: the v3 file is kept as `.v3-backup`.
- **The design clip** (`model/design-clip.js`, pure) is `paste-cluster.js` one level up:
  it carries the BOARDS too (plus everything seated on them, selected desk bricks, every
  wire with BOTH ends inside, and the buses / net names / anchored labels riding them),
  so a sub-assembly brings its own holes and its wiring survives the trip. Legality is
  per-board only and the drop is **all-or-nothing** — half a design would silently cut
  the wires that crossed to the board left behind. The ghost is built ONCE in the clip's
  own coordinates and then TRANSLATED (it is rigid), and `DeskDoc.pasteDesign` stamps it
  in one snapshot-guarded mutation that rolls itself back on any refusal.
