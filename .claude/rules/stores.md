---
paths:
  - "src/web/scripts/stores/**"
  - "src/app/stores/**"
  - "src/app/ipc/stores.js"
  - "src/web/scripts/components/store-*.js"
  - "src/web/scripts/components/settings-stores-panel.js"
  - "website/store/**"
---

## Private stores

**Private, user-owned galleries, shared with friends** (Jason, 2026-11-22; no feature
number). The `stores` feature flag was REMOVED 2026-11-22 (Jason): the stores are in
every desktop build, and never in the web build (`deps.enabled` = not web; the Save action
is `desktopOnly` in the menu table). Plan: `~/.claude/plans/i-d-like-to-expand-flickering-hartmanis-of-*.md`.

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
  - `deep-link.js` reads the app form into `{kind: "store", ref}`. Main pushes
    `store:link` (never on the web build), and app.js opens the Add Store guide in a card
    of its own.
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
    A GitHub store reads its tree, then ONE GraphQL request for every unseen meta
    (`readMany`).
  - **Windows**: the Browse window may list/view/thumb/open; everything that writes,
    signs in or sets up answers the app window only (`appOnly`).
- **GitHub** uses an OAuth App with the **device flow**: a code the user types at
  github.com/login/device, so no password, no redirect and no client secret.
  - `GITHUB_CLIENT_ID` in `stores/sources.js` is Jason's registered "Chip Hippo" OAuth
    App, `Ov23lixgbUNY4hbDuwEo` (2026-11-22; device flow on, expiring tokens on).
    Until then the guide LEAVES GitHub OUT (no greyed "coming soon": App Review 2.1/2.2
    refuses placeholder features), and a friend's GitHub link says `notConfigured`.
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
    nothing is due, so handler order holds. A refused refresh clears the sign-in.
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

A two-reviewer pass graded the work B−. These are what it changed, each with a test:

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
  - `headOf` counts a base only when it was made no later than its child (`revTime`), and
    falls back to the newest revision. A cycle written into a shared store can no longer
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
  - Show Folder checks inside the bookmark.
  - `join.folderIntroOther` is used for "another synced folder".
  - Settings' main nav has `aria-controls`.
- **Third pass**:
  - Changing the store or mode puts a "behind" answer away and brings Save back.
  - A sign-in cancelled while its last poll is out keeps no token.
  - An unreadable `revs` folder is `denied`.
  - Show Folder checks and shows inside the bookmark.
  - GraphQL errors beside data fail the batch.
- **Still open**: `acceptInvitation` accepts before the manifest id can be checked
  (nothing can be read without accepting); the real GitHub run (needs the client id).

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
