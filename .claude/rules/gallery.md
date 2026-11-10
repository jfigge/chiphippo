---
paths:
  - "src/web/scripts/gallery/**"
  - "src/app/gallery/**"
  - "src/app/feature-flags.js"
  - "src/app/deep-link.js"
  - "src/web/scripts/feature-flags.js"
  - "src/web/scripts/components/gallery-links.js"
  - "src/web/scripts/components/gallery-open.js"
  - "src/web/scripts/components/settings-gallery-panel.js"
  - "src/web/scripts/components/gallery-share.js"
  - "services/gallery-worker/**"
  - "scripts/check-submission.mjs"
  - "src/web/scripts/gallery-window.js"
  - "src/web/gallery.html"
  - "scripts/build-gallery.mjs"
  - "scripts/render-gallery-thumbs.mjs"
  - "website/gallery/**"
  - "features/chiphippo-gallery-*.md"
---

## The gallery work

**Browsing and sharing** — no feature number; called "the gallery work" (Jason,
2026-10-31). **No challenges, competitions, teacher or paid tier** (Jason, 2026-11-02):
browse, pull a design in, or share one as a PR Jason reviews — Phase 5 is the last. Spec `features/chiphippo-gallery-spec.md`, plan + decisions
`features/chiphippo-gallery-plan.md` (Parts 2/2b hold every answer Jason gave). Built
phase by phase; **Phase 1 (format + validator + chip lineage) landed 2026-10-31,
Phase 2 (the site, Open in browser) 2026-11-01, Phase 3 (Browse Gallery in the app,
Settings ▸ Gallery, the checks on the way in) 2026-11-01, Phase 4 (`chiphippo://` links,
double-click `.chiphippo` files) 2026-11-01, Phase 5 (Share to Gallery, the submission
service, the submission repo) 2026-11-02**. **Unflagged 2026-11-05** (Jason): the
`gallery` feature flag is gone, so the next release ships browsing and sharing to
everyone.

- **No feature flag any more** (Jason, 2026-11-05). It hid the work from 2026-10-31
  until it shipped; `app/feature-flags.js`'s `FEATURES` is now EMPTY (a stored or typed
  `gallery` is ignored, as any retired flag is), and the machinery — `--features=`,
  `CHIPHIPPO_FEATURES`, settings.json's main-owned `features`, `app:features`, the
  renderer's `featureEnabled`, the web build's `?features=` — stays for the next
  unfinished feature. The gates that remain are the user's: Gallery access, Share
  consent, and main refusing every `gallery:*` call those don't allow — bar ONE, on
  purpose: `gallery:share-status` (Your shares ▸ Check status) asks whatever either
  says, since it is the user's own press about a share they already made and sends only
  `{id, number, key}` (2026-11-09). The chip lineage
  fields below were never flagged.
- **`gallery/` is pure and shared** by the app, the web build, the gallery's CI and the
  Worker: `entry-format.js` (entry.json v1; the sharer writes title/author/description/
  tags only, `checkEntryText`; `derived`, the id, the pin are CI's, never read from a
  client; reading is lenient `normalizeEntry`), `derive.js` (engine, counts, families,
  level, auto-tags from `TAG_RULES` — catalog groups/ids/kinds, held to exist by a
  test), `validate.js`, `index-format.js` (built at deploy, never committed).
- **`validateSubmission(text, {migrate})`** takes a `.desktop.chiphippo` snapshot and
  main's `migrateDeskDocument` (one copy of the migrations; the caller passes it). It
  refuses what the LOADER would drop silently: the document is normalized and every
  `CONTENT_KEYS` list's ids compared before/after (`dropped`, with the ids), never the
  values. The catalog is asked with the snapshot's own chips ONLY (`catalog/index.js`
  `withCustomChips`, which restores the registry however it ends), so a chip only the
  sharer's library held is `missingChip`, and a chip without a runtime is `brokenChip`.
  Every shipped example desktop validates clean (`gallery-validate.test.js`).
- **Custom chip lineage** (Part 2b): `origin: {gcid, rev, hash}` and `forkedFrom: {gcid,
  rev}`, each only when well formed and only when present (omit-when-default), kept by
  `normalizeCustomChip` AND main's `sanitizeCustomChips` (a parity test). The gallery
  id `gc-<12 hex>` is minted by the gallery's CI, never the app. `chipContent` is a
  chip minus its id and lineage (`sameCustomChip` compares it); `packageCompatible`
  means only the code may differ; `forkCustomChip` turns origin into forkedFrom.
  `mergeCustomChips` matches a gallery chip by gcid before id — same content → the one
  here, an older compatible revision → the newer one here, a newer compatible one →
  `revisions[gcid]` "update" (replaces under the existing local id, `updated`) / "keep"
  / unanswered (kept and listed in `asks`, so the caller can ask and call again). A
  chip with no origin merges exactly as before.

### Phase 2 — the site and Open in browser

- **Two repos** (D1). This one holds the CODE, the page (`website/gallery/index.html`,
  `gallery.js`) and the SEED (`website/gallery/seed.json`: 25 shipped example desktops by
  demo file + desktop name, each with a FIXED id so links outlive releases — kept here,
  not in the gallery repo, so `gallery-site.test.js` holds every seed to a real demo
  desktop that validates). The public **jfigge/chiphippo-gallery** holds DATA only:
  `entries/<id>/{entry.json, design.desktop.chiphippo, thumb.png?}`, its folder name the
  id, plus a `validate.yml` that runs this repo's `build-gallery.mjs` over it and (with
  the `DEPLOY_DISPATCH_TOKEN` secret) dispatches `deploy-site.yml` on a push to main.
- **`scripts/build-gallery.mjs`** (`make gallery`, `GALLERY_ENTRIES=` for a gallery
  checkout) writes the GENERATED, git-ignored half — `website/gallery/index.json`,
  `entries/`, and `lib/` (a copy of `gallery-view.js`, `index-format.js`,
  `entry-format.js` for the page to import) — validating every design with main's
  migrations and RECOMPUTING `derived` (an entry's own claim is never read). `--strict`
  fails on any entry left out. The page is the site's chrome copied from releases.html,
  indexable (its `noindex` went with the flag); its links are plain
  `/desktop/?gallery=<id>`.
- **`scripts/render-gallery-thumbs.mjs`**: serve the staged site (desktop/ + gallery/),
  open each entry in headless Chrome the way a visitor does
  (`/desktop/?nosw&gallery=<id>`), each in a FRESH browser context, wait
  for `<html data-gallery-opened="<id>">` (app.js sets it when the open resolves; empty
  on a failure), zoom out one step with the desk's own − button, hide the tab strip, zoom
  and padlock, and capture `.desk-viewport` at half scale → `thumb.png`. Every picture is
  therefore a smoke test of the web app opening that entry. Stops after two timeouts with
  nothing made — a web build from before gallery links.
- **Deploy** (`deploy-site.yml`): no switch of its own — the `GALLERY_ENABLED` repository
  variable was removed (Jason, 2026-11-05: the release gate below already decides it).
  **The gallery is the RELEASE's** (Jason, 2026-11-01): the /desktop step outputs the tag it unpacked, "Check out
  the release's code" makes a `git worktree` of it (`.release-src`, shared with the
  guide's build — docs-assets.md), and the gallery step publishes ITS
  `website/gallery` page + seed, built by ITS `build-gallery.mjs` (`--out website/gallery`)
  and photographed by ITS thumbnail renderer — main's unreleased validator never judges
  an entry, and the page's buttons are the ones the live app answers. A tag with no
  gallery publishes none (a notice); only a /desktop built from the deploy's own commit
  (no release has a web zip) uses that commit's gallery. `gallery-site.test.js` holds
  the step to it. The gallery repo is fetched
  by `git ls-remote` + clone, NOT `actions/checkout`, which fails on an empty repo and
  took the whole site deploy down with it (2026-11-01). Seeds are read from the RELEASE's
  demos (`website/desktop/demos`), the pin is the release's version, and thumbnails are
  rendered against the released web app — so until a release carries gallery links,
  cards show the striped placeholder.
- **Open in browser** (web build only): `components/gallery-links.js` reads
  `?gallery=<id>` once (then `replaceState`s it away so a reload does not reopen) and
  listens on the `chiphippo-gallery` BroadcastChannel; a second tab blocked by the
  one-tab Web Lock hands the id there instead (`handOffGalleryLink`, from `host-entry.js`)
  and says `web.galleryHandedOff` ONLY when the holding tab answers `{received: nonce}`
  (2026-11-09) — sent again every 400 ms for 5 s, since a tab still booting holds the
  lock with no listener yet; the nonce keeps a repeat from opening twice; no answer →
  the ordinary `web.otherTab` card. `ProjectWorkspace.openGalleryEntry(id)` → main's
  `gallery:open-entry` (`app/gallery/sources.js` — one host, ids only through
  `ENTRY_ID_RE`, a closed list of file names, the web build reading the gallery BESIDE
  its own page; `client.js` — size-capped at `MAX_SNAPSHOT_BYTES`, 15 s timeout, coded
  failures `missing`/`unavailable`/`invalid`/`tooBig`/`refused` → the
  `workspace.galleryError.*` sentences) → `desktopSnapshotOf` (the explicit desktop
  shape only), handed back UNRESEATED with its ROM bytes as `images` — the renderer
  reseats it through `desktop:duplicate` only after every question (prepare, D7, Spice)
  said yes (2026-11-09: main reseated on the way out, so a refused, cancelled or
  already-open design left ROM files behind). It lands as an EXAMPLE does: a new desktop, framed,
  clean unless the project was dirty, switched to when already open — by the ENTRY ID
  (`#galleryTabs`: the desktop this session opened it as, in this project; 2026-11-09 —
  by tab name, two entries of one title, or the user's own desktop of that name, switched
  to the wrong desk) — and a published design is ALWAYS named for its entry title (seeds by `seedSnapshot`, shares by
  main's `shareToGallery` and, for those shared before it did, `build-gallery.mjs`
  `namedForEntry`): a sharer's "Desktop 1" switched every visitor to their own; its
  chips join the PROJECT, never the library (D4). Refused on the desktop app until
  Phase 3's Gallery access setting.
- **`gallery/gallery-view.js`**: the grid written once — `source` (index, entry,
  thumbUrl), `say(key, params)` and `actions` handed in; `filterEntries`/`tagsOf` pure.
  The site's lint block treats `website/gallery/*.js` as modules; ESLint and Prettier
  skip the generated `website/desktop/` and `website/gallery/lib/`.

### Phase 3 — Browse Gallery in the app

- **The Browse window** (2026-11-07; it was Help ▸ Browse Gallery… until then): File ▸
  **Browse Projects…** ⇧⌘B and the File pill's grid segment push `menu:project-browse` →
  `ProjectWorkspace.browseProjects` (a fresh picture of the open project first) →
  `gallery:show("recent")`. The ONE window (`openGalleryWindow(tab)`, a singleton like the
  guide's, not closed by `closeAuxWindows`; `?tab=` on open, the `browse:tab` push when
  brought forward) has two tabs (`gallery-window.js`): **Recent Projects** — the MRU list as
  cards (`components/recent-projects-view.js`, the gallery's own `.gallery-card` + a ×;
  main's `project:recent:details` → `{path, name, savedAt, missing, thumb, desktops}`; a
  click → `browse:open-recent`, which relays an MRU path ONLY as File ▸ Open Recent's own
  push) — and **Gallery**. It opens WHATEVER the access answer: the Recent tab never
  touches the network, and every gallery read is still gated, so a refused `gallery:index`
  makes the tab show an Allow… card → `browse:ask-access` → the app window runs
  `browseGallery` (`components/gallery-open.js`): the desktop app asks ONCE (Allow / Not
  now, both stored as `galleryAccess` "yes"/"no" — D8), a stored no answers with a card
  pointing at Settings ▸ Gallery; the web build never asks; then `gallery:show("gallery")`
  reloads the tab.
- **The recent projects' pictures** (`app/store/thumb-store.js`): a CACHE in
  `userData/thumbs/<sha256(path)>.png` + `.json` (`{desktops}`), never in the project file
  and no path in a file name. `project:thumb:capture {path, rect, desktops}` (app window
  only) photographs the visible view with `webContents.capturePage` (rect × zoom factor,
  resized to 480 px) — only for a path ON the MRU list. app.js's `captureBoard` crops the
  rect clear of the tab strip/padlock and zoom cluster (nothing hidden, so no flicker) and
  skips while a `dialog[open]` is up; the workspace asks only for a project with a file
  that is CLEAN (`captureBoard()`): after a save to a real path, after an open (boot
  included), and before leaving one. `forgetProject`/`rememberProject` prune pictures off
  the list. The web build has no `capturePage` → the striped placeholder.
- **MAIN IS THE GATE** — its rules in `app/gallery/gate.js` (2026-11-09, pure, as
  close-guard.js is; `app/tests/gallery-gate.test.js`): `galleryAllowed`/`galleryAnswer`,
  `prepareShare`, `onRecentList` (the MRU-only test of Recent opens and board pictures)
  and `createOpenQueue` (below); main.js keeps the wiring (`galleryAllowed`: on the desktop
  `galleryAccess === "yes"`; the web build is always allowed), checked by every handler: `gallery:index`, `:entry`,
  `:thumb` (a PNG checked by its signature, handed over as a `data:` URL — the window's
  CSP has no connect-src), `:open` (the window's Open → `gallery:host-inbound`
  to the app window, the example button's relay), `:open-entry` (the design, plus
  entry.json's `pin` and `engine`, best-effort) — `:show` alone is NOT gated (the Browse window above). Every read is capped by kind
  (`client.js`: index 2 MiB, entry 64 KiB, thumbnail 512 KiB, design 512 KiB).
  `ipc-guard.js` gives the Browse window (`isGallery`) those four reads, Open, and the Recent tab's `project:recent:details`/`:remove`, `browse:open-recent` and `browse:ask-access` — nothing that opens a path itself.
- **A developer can point the desktop app at a local site**: `CHIPHIPPO_GALLERY_URL`,
  honoured only in a dev launch and only for a loopback `http://127.0.0.1|localhost`
  address (`sources.js` `devBase`) — `node scripts/serve-web.mjs website --port 8099` +
  `CHIPHIPPO_GALLERY_URL=http://127.0.0.1:8099/gallery/ make debug`.
- **`gallery-window.js`** draws `gallery-view.js` over the bridge with `t("gallery.*")`;
  the styles are app.css's `gallery-*` block (tokens only).
- **Every way in asks the same questions** (app.js `openFromGallery` →
  `openGalleryEntry(id, {prepare, chooseRevisions})`): a document NEWER than this build
  is refused (`workspace.galleryError.newer`); `galleryPrepare` runs D7's compatibility
  check — an entry pinned to ANY OTHER release, newer as much as older (2026-11-09: every
  entry is pinned to the release it is PUBLISHED from, so "older only" never fired for
  anyone — a user a release behind meets only newer pins) is put through `validate.js` `loadCheck`
  (the validator's own verdict, extracted for this) and anything lost is named before it
  lands (Open Anyway / Cancel); and a Spice-only design on the logic engine offers Turn On
  Spice Lite / Open Without. `galleryRevisions` asks Update / Keep Both per newer chip
  revision as a CONFIRM (Update takes the focus — Jason's default); an update replaces
  the chip under its existing local id as the PROJECT's copy and leaves the project dirty
  (it changes every desktop that places it). The report back to the gallery waits for the
  Worker (Phase 5).
- **Settings ▸ Gallery** (`settings-gallery-panel.js`, a tab between AI and About): Gallery access Yes | No (absent reads No; left out on the web) and
  Share consent Yes | No | Ask (default Ask; read by Share to Gallery — Phase 5).
- **Still to come from the plan's Phase 3**: the tray grouping a gcid's revisions, "Save
  to my library", the designer forking a gallery chip on save, and the "newer revisions"
  list — none is reachable until shared chips exist (Phase 5).

### Phase 4 — `chiphippo://` links and double-click files

- **`app/deep-link.js`** (pure, `cli-args.js` style): `parseDeepLink` reads ONLY
  `chiphippo://gallery/<id>` (any case, an optional trailing slash, nothing after — by
  regex, not `URL`, whose split of a non-special scheme varies) for an `ENTRY_ID_RE` id;
  `launchRequests(argv, {cwd})` yields links and `.chiphippo` paths (resolved against the
  launch's OWN cwd — a second instance's), skipping argv[0] and every `-` flag.
- **Main's hand-over queue** (`handOver` → gate.js `createOpenQueue`, at most 16): macOS
  `open-file`/`open-url` (registered in `bootstrap`, so before `ready`), the first
  launch's argv (not the web build's), and `second-instance`'s argv. Held until the app
  window's page calls **`app:opens-ready`** (the END of app.js `init`, so the workspace
  exists); reset on `did-start-loading`/`render-process-gone` and when the app window
  closes (2026-11-09 — it also closes the Browse window, which kept the app alive with
  dead buttons and swallowed a hand-over sent to the next window's loading page). A running app is brought
  forward; a starting one shows its window itself.
  - A **file** → `app:open-file` `{path, kind}`: main reads only what it holds
    (`ProjectStore.kindOf` — "project" | "desktop" | null) because a project replaces
    the one open and its leave question must come first. The path joins `handedFiles`,
    the ONLY list `project:open-file` (→ `adoptProject`, Open Recent's answers) and
    `desktop:import-file` (→ `snapshotForImport`, Import's reseat) accept. Renderer:
    `workspace.openFile` (the open project's own file is left alone, nothing asked) /
    `workspace.importFile` (Import with no dialog) / an unreadable notice. It reaches
    no network.
  - A **link** → `gallery:link` `{id}`. The renderer asks `galleryAccess` (Browse Gallery…'s question, factored out of
    `browseGallery`) and then `openFromGallery`, so every check of Phase 3 applies;
    main's `gallery:open-entry` checks the answer again.
- **Registration**: `build.protocols` (`chiphippo`) and `build.fileAssociations`
  (`chiphippo`, `application/x-chiphippo`, Editor) — electron-builder writes the mac/MAS
  `CFBundleURLTypes` + `CFBundleDocumentTypes` (checked in a `make build` Info.plist
  2026-11-01), the deb/rpm `.desktop` `MimeType` (x-scheme-handler + the MIME type, with
  a shared-mime-info file) — so the AUR package, repackaging the deb, has both — and
  NSIS's file association. NSIS has NO protocol support, so Windows' link is
  `registerLinkScheme` (`setAsDefaultProtocolClient`, a packaged `direct` copy only;
  never a portable or store copy). The AppImage registers nothing. `packaging.test.js` holds the config.
- **The site**: `website/gallery/gallery.js` adds **Open in desktop app**
  (`chiphippo://gallery/<id>`) between Open in browser and Download; a page cannot tell
  whether the app is installed, so it doesn't try. Published from the release (above),
  so it appears with the release that registers the link.

### Phase 5 — Share to Gallery

- **Three repos**: this one (code), the public **chiphippo-gallery** (accepted entries),
  the PRIVATE **chiphippo-gallery-submission** (shares arrive as PRs; a turned-down one
  is never public — GitHub has no way to delete a PR). Scaffold in
  `../chiphippo-gallery-submission`: `check.yml` (one added `entries/<id>/` with only the
  two files → `scripts/check-submission.mjs` from the LATEST RELEASE, main's until a
  release has it → a PR comment, red when it would be left out), `publish.yml` (a merge →
  copy the added entries into chiphippo-gallery with `PUBLISH_TOKEN`; that push runs the
  gallery's `validate.yml` → site deploy), `tidy.yml` (deletes `share/<id>` on close).
- **The app** (desktop AND web since 2026-11-05 — the web page's CSP already allows
  `https:` for the AI builder; the Worker answers CORS for chiphippo.com): Desktop ▸ Share
  to Gallery… and a tab menu's row (`onShare`; both off while
  running — the menu item follows `canDuplicate`) → `components/gallery-share.js`. The
  design is judged first with `validateSubmission` (identity migrate: the live doc is
  this build's); Share consent (`galleryShare`) ask → the block, yes → one line, no → a
  card to Settings ▸ Gallery; `galleryAuthor` remembers the name. **Share Publicly** is
  the only thing that sends. The payload is `ProjectWorkspace.portableDesktop(id)` (the
  Export shape — `exportTab` uses it too) + `entry`.
- **Main** `gallery:share` (`shareToGallery`): refuses when consent is
  "no"; `checkEntryText`; builds the snapshot with `ProjectStore.buildDesktopSnapshot`
  (what `writeDesktopSnapshot` writes, ROMs included) NAMED for the entry;
  `MAX_SNAPSHOT_BYTES`; the ROM bytes against `MAX_ROM_BYTES` → `romTooBig` (only main
  holds them — the Share dialog's `validateSubmission` sees no ROMs; `snapshotRoms` in
  entry-format.js is the one count both use) — all gate.js `prepareShare`; then
  `app/gallery/share.js` → `SHARE_URL` (`sources.js`, `https://share.chiphippo.com/v1/share`;
  `CHIPHIPPO_SHARE_URL` loopback in a dev launch — `--dev`/`make debug`). Sends
  `{entry, design, appVersion}` and nothing else.
- **The Worker** (`services/gallery-worker/`, README = the Cloudflare setup): cheap checks
  only — size, `checkEntryText`, `wording.js`, a desktop snapshot's SHAPE. Limits
  (2026-11-09), keyed by `sha256(salt:addressBlock(ip))` (an IPv6 address by its /64):
  Cloudflare's **rate-limiting binding** `SHARE_BURST` (3 a minute per address — it cuts
  off a parallel volley, which KV's read-then-write can't), 5 an hour in KV, then
  `SHARE_ALL` (10 a minute for the whole service → "busy", guarding the GitHub token's
  quota); an attempt is COUNTED before GitHub is asked anything (a refused duplicate
  still spent calls). 50 waiting at most; id `entryIdFor(title, sha256(design))`, and
  `alreadyShared` refuses it while its PR is OPEN or its entry is on main; a
  `share/<id>` branch with no open PR is a leftover and is deleted (as `openShare`
  deletes its branch when the PR can't be opened), so a retry is never told "duplicate"
  for good. The binding's `period` is 10 or 60 s only (hence KV for the hour), counts
  are per Cloudflare location and approximate; wrangler ≥ 4.36. The full validation lives in the
  submission repo's CI on released code (the free plan's 10 ms CPU, and no catalog bundle
  in a Worker). PR body: sharer text through `inert()` (no mentions, links, headings).
  Linted, formatted, licence-stamped and tested by `make` like `scripts/` (its own
  `package.json` is `type: module`; it imports `entry-format.js` by relative path, which
  wrangler bundles).
- **Your shares + the reviewer's note** (Jason, 2026-11-05). A share's answer carries
  the PR `number` and a status `key` = HMAC-SHA256(`status:<salt>`, `<id>#<number>`)
  (`statusKey`), so the Worker stays stateless; the card keeps `{id, number, key, title,
  at, status, note}` in `galleryShares` (`rememberShare`, newest first, ≤ 50; an
  older Worker's keyless answer is not kept). Settings ▸ Gallery ▸ **Your shares**
  (`settings-gallery-panel.js` `buildShares`) asks main's `gallery:share-status` →
  `share.js` `shareStatus` → `POST /v1/status` one share at a time, ONLY when Check
  status is pressed, and saves the answers. A share's × (`settings-gallery-share-remove`,
  shown on hover/focus) drops it from `galleryShares` — the LIST only, never the share;
  one removed mid-check stays removed (the check's result is filtered by what is left).
  Nothing else ages an entry out but the 50 cap: a closed PR keeps its head ref, so
  its status answers for good. The Worker: key checked in constant time
  before GitHub is asked; the PR's head must be `share/<id>`; merged → accepted, open →
  waiting, closed → declined; `reviewerNote` = the LATEST comment by the repo owner
  (`owner`, from SUBMISSION_REPO — the check's bot comments never count), ≤ 2000
  chars, shown as TEXT; answers cached 5 min in Cloudflare's cache (`edgeCache`, keyed
  on the service's own host — no KV write per question). 403/404 read as "Not found".
  CORS: `ALLOWED_ORIGINS` (chiphippo.com, www) on every answer + a 204 preflight.
- **Still open**: the Cloudflare account, DNS (chiphippo.com's nameservers are whois.com's
  — `share.chiphippo.com` needs them on Cloudflare, else the workers.dev address in
  `SHARE_URL`), the two tokens, and pushing the submission scaffold (the Worker branches
  off its `main`) — all done 2026-11-05: the Worker is live at `share.chiphippo.com`.
- **Before the first release that carries it**: privacy.html (the gallery and the
  share service send data off the machine) and a user-guide page.
