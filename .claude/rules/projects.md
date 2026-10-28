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
  file-backed — run-volatile only — and forgets on a power loss mid-run too (2026-10-22:
  UNPOWERED or REVERSED, SimController `#forgetUnpowered` reseeds its image once).
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
  size warning; `mem-store.js` `readImage` reads only a regular file, and no more
  than `MAX_BYTES` of it — a size from `stat` is no cap for `/dev/zero` or a FIFO).
  An image is Intel HEX by its name (`.hex`/`.ihx`/`.ihex`) OR by what it holds
  (`hex-format.js` `looksLikeIntelHex`: a first record that parses whole), so SDCC's
  `.ihx` picked through "All files" is decoded, not programmed as its ASCII; one with no
  data records is refused (`requireHexData`), never flagged programmed with nothing in
  it (2026-10-14).
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
  on open (`app/store/project-images.js`). `hydrateImages` skips a sidecar that already
  holds the bytes and writes the rest `atomicWrite(…, {durable: false})` — atomic, no fsync,
  since the project file holds them (2026-10-26: the fsyncs were ~80 ms of an 8-ROM open).
- **The inspector** is a floating OS window per component (`web/memory.html` →
  `scripts/memory.js` → `components/memory-inspector.js`). Being its own sandboxed
  renderer it reaches the main renderer ONLY through main's `memory:*` relay
  (`open`/`to-inspector`/`to-host`, re-dispatched by preload as
  `chiphippo:memory-inbound` / `chiphippo:memory-host-inbound`). The grid is
  **virtualized** (a reused row pool — a 32 KiB image is ~30 rows in the DOM),
  **editable when stopped** for a ROM (Save writes its file) and a **read-only live
  viewer** for SRAM and any running chip (it mirrors the engine-owned image, never writes
  it). Intel HEX ⇄ bytes is the pure `model/hex-format.js`.
- **Unsaved edits show on the desk** (2026-10-12): the window reports each change of its
  `dirty` to the host (`to-host` `{kind: "edits", unsaved}`), and main reports a closed
  window (`{kind: "closed"}` — its edits went with it); `MemoryBridge` hands both to
  `DeskController.setMemoryUnsaved`, which keeps `#unsavedMemory` (cleared by
  `loadDocument`, re-applied by `#mountPart`) and lights the shared triangle
  (`part-chip--unsaved`) with `properties.warning.unsaved` — ahead of "unprogrammed" on
  the desk, beside it in the Properties card. Not a document change: the edits live only
  in the window, and the circuit reads the file.
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
  cpuBreakpoints?: { "<tabId>": { "<compId>": [addr, …] } },  // CPU monitor (ui-chrome.md)
  images: { "<rom-guid>": { "blob": "sha256-<hex>" } },  // programmed ROMs only
  blobs:  { "sha256-<hex>": "<base64>" } }               // stored once, shared
```

Code: `app/store/project-store.js` + `project-images.js` + `project-migrate.js` +
`model/project-doc.js` + `components/project-workspace.js` + `components/project-tabs.js`
+ `model/design-clip.js`. The whole file surface is
`project:boot`/`:new`/`:open`/`:open-recent`/`:save`/`:choose-path`/`:regrant`, plus
`desktop:export`/`:import`/`:duplicate`.

- **ROM bytes are part of `dirty`** (2026-10-11): `markImagesChanged` (MemoryBridge, after
  a programmer load, an inspector Save or a CPU monitor keep) counts `#imageEdits`, and the
  project is dirty until a FILE write takes that count (`#doWrite`; a recovery stash does
  not) — a chip already flagged programmed and edited re-saved left the document
  identical, so a quit did not ask and the next open copied the file's older bytes back.
- **A desk swap is one thing at a time, and waits for its Stop** (2026-10-11).
  `#leaveActiveDesk` = `#stopForSwap` (dispatches `chiphippo:desk-leaving` with
  `{project, hold}`, Stops, awaits what was `hold()`-ed — the CPU monitor's kept ROM edits
  landing in the desk being left — at most `HOLD_MS`, 10 s) → THEN `#stash()` → close the
  aux windows. Every swap (add/select/duplicate/import/delete a desktop, an example, a
  project swap) runs through `#oneSwapAtATime`; a second click during a hold queues, so
  the write lands in its own desktop and the last click wins. Never call a public swap
  from inside one (deadlock): `#addExample` calls `#selectTab`. `#confirmLeaveProject`
  awaits the queue first, then every ROM write still under way (`chiphippo:writes-pending`
  `{hold}`, the same `HOLD_MS` wait — a plain Stop's keep, an inspector Save), so a
  quit's question and save see the kept edits. A PROJECT swap (`project: true`) keeps no
  edits — that project was saved or discarded. While a swap waits the strip shows
  `project-tabs--busy`; tab clicks made before a switch gets its turn are ONE switch to
  the last tab clicked (`#selecting` `{to, turn}`) — but only while that switch is the
  LAST thing queued (`#lastSwap`): a click after a queued add is its own switch, after
  it. A Run started during the wait is stopped too; a keep from an EARLIER Stop still
  writing is held by the next swap (the bridge's `#keeping`).
- **Every ROM write lands in the desktop it was made on** (2026-10-12). `MemoryBridge
  #landed` runs each one (Load/Program, the inspector's Save, `keepRunEdits`), tracked in
  `#writing` for `desk-leaving`/`writes-pending` to hold, stamped (`#stamp`, taken WITH
  the chip — Program's before its picker) with `ProjectWorkspace.deskWhere()`
  (`{project: #projectSerial, tab}`) and the file's GUID — only the chip naming that file
  is flagged (`setMemoryProgrammed`'s `{guid}`, `flagRomIn`'s), never one placed since
  under a reused id. A write that throws answers as a failed one; a
  flag that throws is logged. EVERY landing goes to `markRomKept(where, …)` (the bridge's
  `markKept`; its `#epoch` is only the fallback with no workspace), because a swap
  stashes the desk it leaves and THEN awaits the aux windows — main answers in order, so
  a write past `HOLD_MS` lands in exactly that gap. `markRomKept` flags BOTH copies: on
  the desk when that desktop is active (`setMemoryProgrammed`, its own undo step), and
  in the project's copy — plus, off the desk, that desktop's undo history's present
  entry AND redo future (`HistoryStore.syncForward`, no step added or dropped; the past
  is left), or an undo-then-redo — or a redo already waiting — drops the flag. It
  answers whether a chip was flagged — on the desk, the DESK's answer (the project's
  copy may be older: a chip deleted since) — false for another PROJECT open since, a
  deleted desktop or a gone chip; only true calls `onImagesChanged` (no stray •) and
  only true makes `keepRunEdits` "kept". `#duplicateTab` re-reads its source after
  main's copy returns and carries any flag landed meanwhile (`withRomFlagsOf`: only to
  chips whose GUID is still the one SENT — not one placed since under a reused id — the
  copy's own GUIDs kept). An inspector's Save is ANSWERED (`#savedReply`): `saved`
  `{source, edited}` updates its binding line (never a whole context, which would reload
  its bytes over newer typing), `save-failed` hands its edits back as unsaved. Program
  re-checks "running" after its picker. `#confirmLeaveProject` loops (≤3) until both
  the swap queue and the writes are quiet.
  The flag's rule is ONE function, `model/rom-binding.js` `programmedPatch`
  (`flagRomIn` in the workspace applies it to a document). `#awaitHolds` counts its
  waits (`#waiting`), so overlapping ones keep the strip busy until the last ends.
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
  - **A quiet tick signs nothing** (2026-10-28): `DeskDoc.revision` is bumped by every
    method not on `DESK_DOC_READS` (a static block wraps the prototype, so a NEW method
    bumps by default — a mistake costs a signature, never a stash; `desk-doc-revision
    .test.js` holds the list both ways), and `#signature` reuses the last one while
    `#project`, the revision and the chip-library identities all stand, trusted for at
    most `SIGNATURE_TRUST_MS` (30 s) against a change the revision cannot see. The web
    build's 2 s tick cost 1.8–3.9 ms on big projects for nothing; now 0.006 ms.
  - **A slot that THROWS on a read is never deleted** (`app/boot-slot.js`
    `keepUnreadSlot`, 2026-10-11): whichever read meets the I/O error first — the
    recovery PEEK, the recovery read or the untitled project's read — the slot is moved
    aside (`setAsideDefaultProject`, `default.unread-<ts>.chiphippo` — still a project
    file, for File ▸ Open) or, if even that fails, HELD for the session
    (`holdDefaultProject`: no write, no remove, a new project written nowhere; both
    `project:save` and `project:recovery:write` answer `{ok:false, code:"slot-held"}`,
    quiet for a background stash), and a startup note names where it is — as FACTS
    `{key, path}` (`workspace.slotAside`/`slotLeft`), worded by the renderer's `#warn`
    under `workspace.slotUnreadTitle`, apart from a project's own string warnings. A DAMAGED slot (bad JSON,
    or JSON that is not an object) is kept the SAME way (2026-10-26): `peekRecovery` reads it
    `{quarantine: false}` and throws `EDAMAGED`, so it is moved aside to a `.chiphippo` name
    with the `slotAside` note — io's silent `.corrupt-…` rename hid an untitled project's
    only copy from File ▸ Open. **A boot that THROWS
    anywhere is treated the same way** (`bootKeepingSlot`, 2026-10-14): the renderer
    answers a failed `project:boot` with `project:new`, which takes the slot over, so
    `project:boot` never throws — the slot is kept as an unread one is and a new project
    comes back; every bookmark `hold` on the boot/open road is a `safeCall` (a failed one
    is the next ⌘S's to report, not the boot's). A most-recent project that EXISTS but the
    sandbox refuses (store builds only; a Save-As bookmark stale with the launch) is not
    skipped in silence: the boot opens the next one and hands over `{deniedRecent: path}`,
    which `#warn` answers with Open Recent's re-grant offer.
  - **A restore is not a question.** `recoveryBoot` restores the stash outright and the
    renderer says so (`workspace.recovered*` — main hands over the FACTS
    `{name, path, homeless}`, since `m()` is for text MAIN renders). Restored work
    arrives UNSAVED (`#saved`/`#stashed` left null) so ⌘Z and close-without-saving both
    still work; a launch modal would ask for an irreversible-looking decision about a
    reversible thing with the destructive button one mis-click away. A recovery whose own
    file has gone restores as UNTITLED, so Save As re-homes it — and its slot is
    UNSTAMPED at boot (`unstampRecovery`), since it is now the untitled project's own
    file: left stamped, a quit that discarded it before the first tick kept the crash
    flag, and every launch after restored it again.
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
  - **The working slot is never a save target, however it is spelt**
    (`ProjectStore.isSlotPath`, 2026-10-14): `default.chiphippo` and v3's
    `default.project.chiphippo` in the saves folder, in any case (macOS and Windows
    volumes ignore it) or by file identity (a symlinked folder). A Save As to
    `Default.chiphippo` used to write the slot, judge it "a different file" by string,
    and delete it; one to `default.project.chiphippo` was swallowed as v3's slot at the
    next launch. `chooseSavePath` suggests `Default 2.chiphippo` for a project NAMED for
    the slot (`besideSlot`) and, picked anyway, says why (`dialog.reserved.*`, a native
    message box) and offers the panel again; `project:save` refuses one as INVALID_ARG,
    `project:recovery:write` likewise, and `read`/`adoptProject` treat any spelling as
    the slot (no location; never dropped as "the slot just left").
  - **Export Desktop never writes the open project's own file** (`saveClash`): the
    renderer passes it as `openProject` (a fact to steer clear of, compared and never
    opened), and the panel is offered again with `dialog.reserved.open` — exported over,
    the file held one desktop while the window still read it saved.
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
    too late to stop the update. Main calls `quitAndInstall` only after a yes. A page
    that goes while the question is out (`rendererGone` — a reload) takes the quit or
    install it was FOR with it (2026-10-14): left set, the next plain window close,
    asked of the page that replaced it, answered as an install.
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
  A tab's PATH is data from a file that may be shared, so (2026-10-26) only a regular file
  ≤ 32 MiB is read, and — unless the project is the app's own working slot — only one in
  the saves folder or beside the project (its folder or below), checked BEFORE the file is
  so much as stat'ed (a UNC path reaches the network) and again, links followed
  (`realpathSync`, 2026-10-27), once it passes — a symlink beside the project is held to
  where it points; anything else (a FIFO, `/dev/zero`,
  `\\server\share`, elsewhere) opens empty with a warning naming it.
- **The design clip** (`model/design-clip.js`, pure) is `paste-cluster.js` one level up:
  it carries the BOARDS too (plus everything seated on them — save a part with a lead
  reaching OFF them, a bend into an uncopied rail or one floating, which stays behind by
  the wire rule, since pasted its lead would land in mid-air (a refused paste after a
  green ghost) or in a stranger's hole — selected desk bricks, every
  wire with BOTH ends inside, and the buses / net names / anchored labels riding them),
  so a sub-assembly brings its own holes and its wiring survives the trip. Legality is
  per-board only and the drop is **all-or-nothing** — half a design would silently cut
  the wires that crossed to the board left behind. The ghost is built ONCE in the clip's
  own coordinates and then TRANSLATED (it is rigid), and `DeskDoc.pasteDesign` stamps it
  in one snapshot-guarded mutation that rolls itself back on any refusal.
