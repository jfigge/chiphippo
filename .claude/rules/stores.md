---
paths:
  - "src/web/scripts/stores/**"
  - "src/app/stores/**"
  - "src/app/ipc/stores.js"
  - "src/web/scripts/components/store-*.js"
  - "src/web/scripts/components/settings-stores-panel.js"
  - "website/store/**"
  - "src/web/scripts/components/share-to.js"
  - "src/web/scripts/components/settings-gallery-panel.js"
  - "src/web/scripts/gallery-window.js"
---

## Private stores

**Private, user-owned galleries, shared with friends** (Jason, 2026-11-22; no feature
number). The `stores` feature flag was REMOVED 2026-11-22 (Jason): the stores are in
every desktop build, and never in the web build (`deps.enabled` = not web; the Private
side of Share To… is gated by `share-to.js` `privateEnabled`). Plan: `~/.claude/plans/i-d-like-to-expand-flickering-hartmanis-of-*.md`.

- **The user owns the storage; Chip Hippo runs no server for it** (Jason, 2026-11-22). He
  rejected a Jason-hosted D1/R2 service. A store lives on a platform the user already
  has, and that platform's own sharing decides who can get in:
  - **a FOLDER their sync client keeps in step** — Google Drive for desktop, Dropbox,
    OneDrive, iCloud Drive, Syncthing, a network share. No sign-in, and no network call
    from Chip Hippo at all.
  - **a PRIVATE GITHUB REPOSITORY** — the app makes it, invites friends and accepts the
    invitation on the friend's side.

  Google Drive by its API is a spike still to do: `drive.file` + the Picker in a
  chiphippo.com window. Until then Drive users go through the folder road.
- **The layout is APPEND-ONLY** (`web/scripts/stores/store-format.js`, pure, shared with
  main). Nothing is ever edited, only added, so a sync client never makes a "conflicted
  copy" and GitHub never needs a merge.
  - The files: `chiphippo-store.json` `{format, id: s-<16 hex>, name, created}`, then
    `entries/<entry>/entry.json` (written once), then
    `entries/<entry>/revs/<rev>.desktop.chiphippo` + `.png` + `.json`.
  - `<rev>` is `YYYYMMDDTHHMMSSZ-<10 hex>`, salted, so the same design saved twice is two
    revisions.
  - The meta is written LAST, as the commit mark. A design without one (still syncing, a
    save cut off) is no revision, and an entry without a revision is no entry.
  - `parseStorePath` is the only reader of names. Anything else in the folder is ignored
    (`.DS_Store`, `entry (1).json`, iCloud's `.icloud` placeholders, which means an
    evicted file is not seen until it downloads).
- **Collaboration is revisions, never live co-editing.**
  - A revision names its `base`. The head is the newest LEAF (`headOf`), and two leaves
    are a FORK. The Browse detail says so and lists every version.
  - A save from a revision someone has since built on is refused as `behind` (main
    re-reads the store before every save, `service.js`). The Save card then offers
    *Open theirs* or *Save mine alongside* (`fork: true`). A fork is never made without
    asking.
- **A desktop remembers where it came from**: `tab.storeFrom {store, entry, rev}`
  (`normalizeStoreFrom`), omitted when absent.
  - Kept by `project-doc.js` `makeTab`/`projectForFile` AND main's `project-store.js`
    write/`_normalize`.
  - Set on open (`openStoreEntry` → `importDesktop({storeFrom})`) and moved on by a save
    (`setStoreFrom`, a project change).
  - Duplicate drops it, since a copy is a new design.
- **The share link carries NO secret**: `https://chiphippo.com/store/#<b64url {v:1, id,
  name, kind, where}>`. The app scheme is `chiphippo://store/add#…`, and the page
  (`website/store/`) offers it.
  - `where` is `{repo}` for GitHub, or `{provider}` for a folder (only what the friend is
    told to look in). Never a path or a token.
  - The payload is in the FRAGMENT, so the server never sees it.
  - `deep-link.js` reads the app form into `{kind: "store", ref}`. Main PUSHES the
    ref on `store:link` (never on the web build), and app.js opens the Add Store guide in
    a card of its own. The same name is also an INVOKE: `store:link (id)` answers a
    store's own `{web, app}` link (app window only).
- **Main** (`app/ipc/stores.js`, `stores/{registry,folder,github,service,sources}.js`):
  - The **registry** is main-owned settings `stores` (plus `githubLogin`, MAIN_OWNED).
    A folder's `path` is an allowlist, like `recentProjects`. `grant` is the folder the
    dialog handed over, and a MAS bookmark is kept for it (`pruneBookmarks` adds
    `storeGrants`).
  - The renderer names stores by **id** only. Main's own dialog picks folders, inside the
    handler.
  - A backend only LISTs, READs (capped) and ADDs (never over: the folder checks, and
    GitHub's contents PUT without a `sha` refuses).
  - **`StoreService` caches every file read** for the session, since files never change.
    A GitHub store reads its tree, then its unseen metas through GraphQL in batches of
    `READ_BATCH` (50) a request (`readMany`).
  - **Windows**: the Browse window may list/view/thumb/open; everything that writes,
    signs in or sets up answers the app window only (`appOnly`).
- **GitHub** uses an OAuth App with the **device flow**: a code the user types at
  github.com/login/device, so no password, no redirect and no client secret.
  - `GITHUB_CLIENT_ID` in `stores/sources.js` is Jason's registered "Chip Hippo" OAuth
    App, `Ov23lixgbUNY4hbDuwEo` (2026-11-22; device flow on, expiring tokens on).
    A build with the id emptied LEAVES GitHub OUT of the guide (no greyed "coming soon":
    App Review 2.1/2.2 refuses placeholder features), and a friend's GitHub link says
    `notConfigured`.
    App Store notes: `features/private-stores-app-store.md`. User guide:
    `src/web/docs/private-stores.md`.
    `CHIPHIPPO_GITHUB_CLIENT_ID` overrides it in a dev launch.
  - The scope is `repo`, the only one that reaches a private repo for an OAuth App. The
    copy says so.
  - **Expiring tokens** (Jason ticked "Expire user access tokens" on the OAuth App): a
    sign-in is an 8-hour token plus a 6-month, single-use refresh token. Main keeps a JSON
    record `{token, refreshToken, expiresAt, refreshExpiresAt}` (a bare token from before
    still reads). `ensureFresh` trades the refresh token within 5 minutes of expiry, ONCE
    however many requests ask (rotation: a second trade with the old one signs the user
    out). The trade needs no client secret, because the token came from the device flow.
    It runs in the `appOnly`/`reader` wrappers, and synchronously does nothing when
    nothing is due, so handler order holds. A refused refresh clears the sign-in; one
    that never reached GitHub (offline) keeps it: `refreshable()` is still signed in,
    and a backend's `backendToken` throws `unavailable`, never `signedOut` (which
    `failedHere` turns into forgetting the 6-month refresh token).
  - The token is `credential-store`'s new `github` kind, bound to `https://api.github.com`.
    `AI_PROVIDERS` keeps the AI key handlers off it.
  - A friend's join calls `acceptInvitation`, then `repoAccess` (a repository not
    shared with you answers 404, as a missing FILE does, so it is asked first:
    `notInvited` names the account to invite), then checks that the manifest id
    matches the link.
  - **A new repository, or a folder in one already there** (Jason, 2026-11-22). The
    GitHub step offers *A new private repository* (`createRepo`, the store at its root)
    or *A folder in one of my repositories*:
    - `store:github-repos` → `listRepos`, PRIVATE repositories the account can push to
      only. A public one is never offered, since a store there publishes every design.
    - `store:add-github {mode: "existing", repo, dir}` re-checks `repoAccess`
      (`pickPublic`, `noPush`). A folder already holding a store is that store,
      ADDED, not made twice.
    - The store's `dir` (`githubDir`/`GITHUB_DIR_RE`: up to 4 plain names, never
      `.`/`..`; `badFolder`) rides the registry record, the share link
      (`where.dir`, omitted at the root) and `GitHubBackend({dir})`. Every store path
      is relative to it: contents/GraphQL paths are prefixed, and `list` reads the
      folder's OWN tree (its sha from the parent's listing). Nothing outside the
      folder is read or written.
    - `repoPage({dir})` opens the folder.
- **The UI**:
  - **Settings ▸ Gallery** is two tabs in the desktop app, **Public** (Gallery
    access, Share consent, Your shares) | **Private** (`settings-gallery-panel.js`
    `galleryTabs`; the tab last shown is kept for the session). The web build: no tabs, no Private.
  - **Settings ▸ Gallery ▸ Private ▸ Private stores** (`settings-stores-panel.js`): one line per
    store with Copy link, Invite (GitHub), Browse, Show folder / Open on GitHub, and a
    two-step Remove that forgets the store HERE only.
  - **Add Store…** draws `store-setup.js` IN the panel (a card cannot open over
    Settings). It has four choices (a synced folder — a NEW store; GitHub; a link from
    a friend; a store folder already on this computer — RESTORED, no link), plain
    per-provider steps, and guide pages
    opened by KEY (`GUIDE_PAGES`).
  - The **Browse window** gives **each store its own tab** after Recent Projects and
    Gallery (Jason, 2026-11-22: few stores are expected, so no picker). Tabs are keyed
    `store:<id>`, labelled with the store's name, in the registry's order: the order the
    stores were added. Nothing reorders them; a manual order may come later.
    - `syncStoreTabs` adds, removes and relabels them at boot, on every focus, and
      before a `stores:<id>` push.
    - The strip is one row that scrolls sideways (`.browse-tabs` `overflow-x: auto`,
      the tabs `flex-shrink: 0`, at most 18em with an ellipsis), and `show` scrolls the
      chosen tab into view.
    - Each tab is a Refresh button over GalleryView, with its `detail(entry)` hook
      listing the versions. It is read again each time it is shown.
  - **Desktop ▸ Share To… ▸ Private** (Jason, 2026-11-23: Save to Private Store… and
    Share to Gallery… became ONE item, `desktop-share`, and ONE form; "the title, Your
    Name, Description and Tags … don't move", the switch "enables the private repos
    list"). `share-to.js`, top to bottom: a Public | Private SWITCH (`buildSegmented`,
    `.share-to-switch` — not tabs) with the Store picker at the row's end, greyed while
    Public is on; Save as (a desktop with a `storeFrom` in a store here only — greyed
    likewise); ONE set of fields, gallery-share.js `buildEntryFields` (Title · Your
    name · Description · Tags; flipping keeps what was typed); then each side's notes
    and its button, BOTH in one grid cell (`.share-to-stack`, the off side
    `share-to-side--off`: invisible + `inert`), so the card keeps the taller side's
    height and nothing moves when it flips. No intro sentence on the combined card (it
    changed the height). Halves: `buildGalleryShare` (`after`: check, consent; `send`)
    and store-save.js `buildStoreSave` (`store`, `modes`, `after`: What changed?, the
    private line, "someone saved first"; `send`); unable to share,
    `buildGalleryShareOff` (consent No) / `buildStoreSaveEmpty` (no store: a greyed
    "No private store yet" picker) grey the four fields (`usesFields: false`) and make
    Open Settings the button. A new version (only while Private is on, `active`) shows
    the entry's own title/description/tags in the fields, greyed, and puts the typed
    values back when it stops; another store flips Save as to A new design (and back).
    Opened on: Private for a linked desktop (the name takes `data-autofocus`), else
    `galleryTabShown()` — Settings ▸ Gallery's remembered tab, which the switch also
    sets. The switch is disabled while either side sends (`onBusy`). The web build
    (`privateEnabled` false) gets `shareToGallery`'s own card, intro and all. The
    picture is taken before the card opens (`loadStoreSave` → `store:capture-thumb` → a
    token, using main's `captureBoardPng`), only when there is a store. The table's
    `desktopOnly` key has no user now; the machinery stays.

### Review fixes (2026-11-22)

A two-reviewer pass graded the work B−. These are what it changed (the `busy` and
list-read fixes got their tests in the 2026-11-24 rounds):

- **GitHub**
  - Raw file reads are never JSON-parsed (`isJsonAccept`). Pictures used to fail this way.
  - Limits are said as limits: a `retry-after` is a secondary limit, and GraphQL's
    `RATE_LIMITED` is `rateLimited`.
  - A renamed repository is `moved` (redirects are `manual`, so a token never follows
    one).
  - A truncated tree is `tooLarge`.
  - `readMany` keeps the batches it already read.
- **Privacy**: joining or SAVING to a GitHub store re-checks the repository is private
  (`storePublic`). Picking a public repository is `pickPublic`, and one you can only read
  is `noPush`. "A folder in one of my repositories" refuses an empty folder.
- **The format**
  - `headOf` counts a base only when it sorts before its child (since 2026-11-24, by id:
    `r.base < r.rev`; it was `revTime` to the second), and falls back to the newest
    revision. A cycle written into a shared store can no longer
    leave an entry headless and crash the view.
  - `saveVerdict` is "next" from ANY leaf, so the other side of a fork is not "behind".
- **The service**
  - The manifest is `normalizeManifest`-ed (`newer` really guards).
  - A parse failure is not cached, so a half-synced meta is read again.
  - A new entry id steps round an orphan `entry.json` and an `exists` race.
  - A folder is read 8 files at a time.
- **The folder backend**
  - Symlinks are refused everywhere. A file must `lstat` as a plain file, and the deepest
    existing folder on the way must `realpath` inside the root (`_contained`).
  - `list` skips links and stats `entry.json` directly.
  - Revisions are sorted newest-first BEFORE the cap.
  - `EACCES`/`EPERM` is `denied`.
- **Finding and showing a store folder**: `findStoreFolder` is async, at most 200 folders,
  never a package (`isPackage`: `.app` and friends) or a link. Show Folder uses
  `shell.showItemInFolder` on the manifest, never `openPath`, which would run a package.
- **Sign-in**: one at a time (a superseded press answers `cancelled`), a network blip is
  polled again, and the wait between polls can be injected (`deps.sleep`).
- **The guide**
  - Answers that arrive after their step has gone are dropped (`stillOn`).
  - Focus goes to the step's first field or heading.
  - Back and close cancel a waiting sign-in, and the Sign In button disables on press.
  - The repository list fails ONCE, with Try again, and never loops.
  - Restoring a folder asks which service keeps it in step.
  - `spellcheck` is really off.
  - Settings disposes the Gallery panel on close (`buildGalleryPanel().destroy`).
- **The Save card**
  - It waits for the linked entry before saving, and SAYS when it cannot be read
    (`linkLost`).
  - Cancel during a save lets it land, says so, and closes nothing else.
  - "Behind" is an alert: Save steps aside and focus goes to Open Theirs.
  - "Open Settings" lands on the Private tab (`preferGalleryTab`).
- **Settings and Browse**
  - Copy link copies, with hints worded for "another synced folder".
  - The list reads are race-safe, and Sign out is hidden during the guide.
  - Store tabs keep their state until Refresh, and version buttons say which version.
  - Settings' tabs have `aria-controls` and `aria-labelledby`.
  - Re-opening a revision after its desktop moved on opens it afresh (`setStoreFrom`
    drops the stale `#galleryTabs` key).
- **Second pass**:
  - A failed fork keeps the "behind" choice standing, rather than leaving only Cancel.
  - `folderNameFor` turns a package-like name ("Synth.app") into a findable one
    ("Synth app").
  - A sign-in cancelled while GitHub is still answering its START stands down: the
    renderer counts its tries, and cancel moves main's `signInSeq` on.
  - `readMany` throws on a failed batch, carrying `err.partial`, which the service keeps;
    the view never shows half the metas.
  - A nested store folder is found by GraphQL `HEAD:<dir>`, with no 1,000-item cap.
  - Folder `list` requires real `entries`/`revs` folders and says an unreadable one is
    `denied`.
  - `join.folderIntroOther` is used for "another synced folder".
  - Settings' main nav has `aria-controls`.
- **Third pass**:
  - Changing the store or mode puts a "behind" answer away and brings Save back.
  - A sign-in cancelled while its last poll is out keeps no token.
  - An unreadable `revs` folder is `denied`.
  - Show Folder checks and shows inside the bookmark.
  - GraphQL errors beside data fail the batch.
- **Still open**: `acceptInvitation` accepts before the manifest id can be checked
  (nothing can be read without accepting); the real GitHub end-to-end run.

### Review after the flag came off (2026-11-22)

Graded B+; fixed the same day:
- `stillOn` asks `root.contains`, not `isConnected`. A guide queued behind another card
  (a friend's link arriving over Settings) had dropped its status answer and left Join
  dead.
- A refresh GitHub REFUSES (any OAuth `error`) is `signedOut`, and clears the sign-in.
  `token()` gives no expired access token, and any `signedOut` answer clears the
  sign-in (`failedHere`, which also covers a token revoked on GitHub).
- `BookmarkStore.withAccess(path, fn, {keep: true})` keeps a store folder's bookmark
  when the folder is briefly unreadable (an unmounted File Provider) instead of
  dropping it for good.
- `remember` refuses a store id this computer already has somewhere ELSE
  (`alreadyAdded`), so a copied manifest id can't re-point a store.
- Make the Store / Choose Where… stay off while a make is under way (`busy`).
- `full` is said before a folder or repository is made.
- Each store line's buttons name their store (`stores.actionFor`), and the panel
  toggles carry `aria-expanded`/`aria-controls`.
- Privacy page and guide: GitHub calls beyond the store, a joined repository being a
  friend's, the app version stored, and no picture for a non-active tab.

### Review 2026-11-24 (graded B+)

Fixed the same day; every fix of the six rounds below has a test (a later round added
the ones an earlier left out), checked by reverting each fix and seeing a test fail. The
only untested pieces are hub wiring — app.js `takePicture`'s tab and project checks,
main.js `pruneBookmarks` feeding `storeGrants` (itself tested) — and the win32 lstat
re-checks running 32 at a time, which changes speed, not behaviour:
- A revision is never stamped before its `base` (`service.js` `_saveWith`: `at` ≥
  `revTime(base)` + 1 s, the second round): a friend whose clock ran ahead made a false fork, the wrong head and
  a later silent fork.
- A new entry's id is salted, so two friends saving one untouched design into a synced
  folder never write the same `entry.json`.
- Offline after the 8-hour token ran out no longer forgets the sign-in (see Expiring
  tokens); `store:status` counts a refreshable sign-in as signed in.
- A device-flow poll GitHub ANSWERS with an error ends the wait (`device_flow_disabled`/
  `incorrect_client_credentials` → `notConfigured`; any other → github.js `refused`,
  which main answers as `signInDenied`); only no answer is `unavailable`, polled again
  — a timeout too (its AbortError's numeric `code` 20 is no store code: `request` keeps
  only STRING codes).
- Saving to a GitHub store the account can only read is `noPush`.
- `store:open-entry`'s meta is `normalizeRevMeta`-ed (a friend's file is untrusted).
- A store save landing after Cancel, once another project is open, links nothing
  there: `setStoreFrom(id, from, project)` with `deskWhere().project` taken as the card
  opened (tab ids restart per project).
- Share To…: a press on the Private side already on keeps the linked version's fields
  greyed; `linkLost` follows the store pick (said again after it moves away and back).
- The guide: the sign-in's in-place redraws move focus (`refill`); every bridge call
  is caught, so a rejection never leaves Make/Sign In disabled or "Loading…" for good;
  Join's folder button is off while its dialog is up. The Settings list read is caught.
- `STORE_OPEN_ERRORS` names every code `store:open-entry` can answer.
- The share page holds the link to the app's own id/kind/repo rules.
- `gallery/Bench Club/` (a manual-test store) untracked and `/gallery/` ignored.

Second round, the same day:
- **The folder backend's check-then-use gap is closed**: a read opens `O_NOFOLLOW |
  O_NONBLOCK` and the open file must be the very one (`dev`/`ino`) found at a path
  `_contained` in the store; a write goes to a temp file and is HARD-LINKED in (atomic,
  never over anything — `EEXIST` is `exists`), or, on a filesystem with no hard links,
  an exclusive `wx` create at the name; both re-check containment after and undo a
  write that landed outside.
- `entries` past `MAX_DIR_ITEMS` keeps the NEWEST folders by mtime (`newestEntries`),
  never the filesystem's listing order.
- A repository `createRepo` made whose manifest PUT then failed is used again for the
  same name this session (`madeEmpty`), and adopted if the manifest landed after all.
- `listRepos` says `more: true` when every page came back full; the picker says so
  (`stores.setup.github.repoMore`).
- A refresh that lands after a NEW device-flow sign-in neither overwrites nor clears it
  (`stillSignIn`).
- `headOf` counts a base only when it SORTS BEFORE its child (`r.base < r.rev`), so a
  same-second cycle can never hide both sides; `_saveWith` stamps a revision at least one
  second after its base so a real link always counts.
- A GitHub meta that can never be one (binary, past the cap) is cached as null.
- Refusals are typed (`appOnly(fn, {refused, github})`: false for the boolean handlers,
  which also never wait on a GitHub refresh); `optsOf` guards a null options argument;
  `store:link` is app-window only, as ipc-guard.js has it; a refused folder pick prunes
  its bookmark; sign-out and a revoked token forget `githubLogin` too (`forgetSignIn`).
- Text is cut on code-point boundaries (`cut`), the share page's dead CSS is gone, the
  segmented picker (Share To…'s switch, and every other) is one tab stop with arrow
  keys, and two stale "Desktop ▸ Save to Private Store…" strings now say Share To… ▸
  Private in all 7 languages.
- `registry.renameStore` (unused) removed.

Third round (an independent regrade's findings), the same day:
- Only handlers that can reach GitHub wait on a refresh: `fresh`'s `github` is a
  predicate (`githubStore(id)` for a store's handlers, false for folder-only, sign-in and
  local ones), so browsing a FOLDER store makes no network call however due the sign-in.
- `full` is said before a manifest is written into an existing repository; a 422 that is
  not GitHub asking for a `sha` (`err.shaWanted`) is `invalid`, not `exists`; the
  device flow's START refused by the OAuth App is `notConfigured`.
- A refresh the keychain will not keep is held for the session (`heldSignIn`), since
  GitHub has already spent the old refresh token; a NEW sign-in it will not keep is
  `noKeychain`, never held. `refreshable()` needs a client id.
- `revs` is read name by name and stops at `MAX_REV_NAMES`; the app's own temp files
  older than an hour are swept from the folder a write lands in (nothing else is ever
  deleted from a store).
- `groupPaths` caps only COMPLETE revisions (design + meta) and entries with an
  entry.json, so junk can never push a real revision out of view.
- UI: Share To… refreshes Private before Public (Public judges the typed values, not a
  linked entry's); a make or join answering `signedOut` re-asks the sign-in block
  (`signInBlock(...).recheck`); a save or share that FAILS after Cancel is said
  (`stores.save.notSaved`, `gallery.share.notSentTitle`); a lost link ticks *A new
  design*; Remove / Sign out / the guide's close put focus on Add Store…; every panel
  and Browse call is caught; the Browse tabs carry ids + `aria-labelledby`, and both tab
  strips take Home/End; `takePicture` checks the project too.
- The share page holds `where.dir` to the app's rule, shows the folder, never shows a
  non-text name, and hides the "press Open in Chip Hippo" step on a broken link.

Fourth round (the third regrade), the same day:
- github.js `request` keeps only STRING codes (a timeout is `unavailable`, polled
  again); a 422 carries its body as `err.detail` — `createRepo` steps to the next name
  only on "already exists", an invite's 422 is `invalid`, not `noUser`; a 403 with
  `x-github-sso: required` is **`sso`** (a sentence in all 7 languages, and the guide's
  "If something goes wrong").
- A 401 while the refresh token still stands marks the access token due and answers
  `unavailable` — the next request trades the refresh token; the sign-in is forgotten
  only when GitHub refuses THAT. `keepSignIn` treats a keychain that throws as one that
  refused (held for the session).
- The stamp is capped at 9999-12-31T23:59:59 (`LAST_REV_TIME`), and only a revision
  of an existing entry takes it from its base.
- Folder: a whole view or save holds the bookmark grant ONCE (`FolderBackend.within`,
  service.js `held`); `EISDIR`/`EINVAL`/`UNKNOWN` (FAT32, exFAT, Google Drive's drive on
  Windows) fall back to the exclusive create; a file that grew while read is null (not
  whole yet); a failed `wx` create removes its partial file; a drive-root store
  (`withSep`); `makeFolderStore` MAKES its folder (`mkdirSync` without `recursive`, a
  taken name stepped past) and writes the manifest `wx`; the temp sweep runs inside the
  write's grant, capped; `newestEntries` stats 32 at a time.
- ipc-guard.js answers a refused yes/no channel (`BOOLEAN_CHANNELS`) with `false`.
- Renderer: Browse no longer loads the GALLERY when a store tab is shown again
  (`show`'s last branch is the gallery tab's only); every remaining bridge call is
  caught; Show folder on a missing folder says "could not be found" in the store's line
  (`reveal` in settings-stores-panel.js); the people list's reads are numbered; Back
  from a pasted link's join goes to the paste step; bidi controls are stripped from
  every one-line and paragraph field (`CONTROL_RE`); `stores.save.noStore` names
  Settings ▸ Gallery ▸ Private ▸ Private stores in all 7 languages.
- The share page reads `where.dir` exactly as `githubDir` does and cuts the name as the
  app does; `store-page.test.js` holds the page and `normalizeStoreRef` to one verdict
  on every case.

Fifth round (the fourth regrade: renderer A/A−, main A− bar the folder backend's B+, docs
A), the same day:
- **Windows reparse points**: a listing marks every reparse point a link, and OneDrive
  Files On-Demand / Dropbox online-only files are reparse points that `lstat` reads as
  plain files. `isLinkHere` asks `lstat` again on win32 before dropping a "link"
  (`readdirCapped`, `findStoreFolder`). Not yet run on a real Windows machine.
- `_contained` treats a root whose `realpath` cannot be resolved at all (`NO_REALPATH`:
  EISDIR etc., some Windows cloud drives) as lexically contained.
- The folder listing caps COMPLETE revisions only (design + meta), as `groupPaths` does.
- `isPrivateRepo`: an Enterprise `visibility: "internal"` repository is no private store
  (`listRepos`, `repoAccess`, `createRepo`).
- An invite GitHub refuses with 403 is **`notAdmin`** ("Only the store's owner can
  invite…", 7 languages); SSO answered through GraphQL errors (`graphqlRefusal`) is `sso`.
- `acceptInvitation` pages (5 × 100); `folderNameFor` steps round Windows device names
  (`WINDOWS_RESERVED_RE` → "CON store").
- Renderer: Back is off while a GitHub make or join is out; `STORE_OPEN_ERRORS` names
  `sso`/`notStore`/`wrongStore`; Open Theirs never reads a missing `head`; U+061C joins
  the stripped bidi controls; the share page cleans the name as the app does and caps
  the payload at 995 (the app's 1024-character link).
- Tests added for what had none: `storeFrom` through a project file, `stores` and
  `githubLogin` as MAIN_OWNED, `storeGrants`, Duplicate dropping the link, the people and
  list read races, `busy`, the `wx` partial removal, a drive-root store, every store-open
  error's sentence.
- Left as is: a Mac App Store build proves the bookmark per thumbnail/design read
  (`within` covers view and save; minor, MAS only); `failedHere` cannot tell a late 401
  from an older token (one needless refresh); folder errors like ENOSPC say
  `unavailable`.

Sixth round (the fifth regrade: folder backend A−, test coverage A−, rules B+ for one
wrong claim about tests), the same day:
- `findStoreFolder` takes only a real FOLDER as a candidate (`isDirAt`): on Windows a
  placeholder FILE is listed as a link, neither file nor folder, and 200 of them filled
  the scan. The win32 lstat re-checks run 32 at a time; `COM¹²³`/`LPT¹²³` are reserved
  names too.
- Tests for the fixes a revert-sweep found untested: invitation paging, Back held during
  a GitHub make/join, Open Theirs with no `head`, U+061C, the page's 995 cap (agreeing
  with `parseStoreLink`), a lost link ticking *A new design*, the read's `dev`/`ino`
  re-check, the 200-folder scan.
- (The sixth regrade, rules B+:) the Windows join test named its store "Zed", which an
  APFS listing put FIRST, so it passed without `isDirAt`; it is now "zed" with the
  listing put in name order, and fails without the fix. Tests added for `COM¹`/`LPT³`
  and for U+061C in a paragraph field (`CONTROL_BUT_NEWLINE_RE`). Each of the three was
  checked by reverting its fix.
