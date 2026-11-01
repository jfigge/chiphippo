---
paths:
  - "src/web/scripts/gallery/**"
  - "src/app/gallery/**"
  - "src/app/feature-flags.js"
  - "src/web/scripts/feature-flags.js"
  - "src/web/scripts/components/gallery-links.js"
  - "scripts/build-gallery.mjs"
  - "scripts/render-gallery-thumbs.mjs"
  - "website/gallery/**"
  - "features/chiphippo-gallery-*.md"
---

## The gallery work

**Sharing, browsing and (later) challenges** — no feature number; called "the gallery
work" (Jason, 2026-10-31). Spec `features/chiphippo-gallery-spec.md`, plan + decisions
`features/chiphippo-gallery-plan.md` (Parts 2/2b hold every answer Jason gave). Built
phase by phase; **Phase 1 (format + validator + chip lineage) landed 2026-10-31,
Phase 2 (the site, Open in browser) 2026-11-01**; the rest is plan.

- **Behind the `gallery` feature flag** (Jason, 2026-10-31). `app/feature-flags.js` is
  the one list (`FEATURES`) and the one resolver: `--features=gallery`
  (`make debug FEATURES=gallery`), `CHIPHIPPO_FEATURES`, or settings.json's `features`
  list edited by hand — MAIN_OWNED, so the renderer can never switch on a flagged feature
  that reaches the network. Resolved once per launch (main.js `features()`), answered on
  `app:features`; the renderer asks once at boot (`web/scripts/feature-flags.js`
  `loadFeatures`, then `featureEnabled(name)` synchronously). The web build's command
  line is the page's `?features=` (`web-host/node/globals.js` `launchArgs`). A flag
  HIDES the UI and main REFUSES the flagged IPC on its own — a renderer flag is no
  permission. **Data is never flagged**: the chip lineage fields below are read and kept
  in every build, or a flag-off build would strip them on save.
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
  `noindex` while flagged; its links carry `features=gallery`.
- **`scripts/render-gallery-thumbs.mjs`**: serve the staged site (desktop/ + gallery/),
  open each entry in headless Chrome the way a visitor does
  (`/desktop/?nosw&features=gallery&gallery=<id>`), each in a FRESH browser context, wait
  for `<html data-gallery-opened="<id>">` (app.js sets it when the open resolves; empty
  on a failure), zoom out one step with the desk's own − button, hide the tab strip, zoom
  and padlock, and capture `.desk-viewport` at half scale → `thumb.png`. Every picture is
  therefore a smoke test of the web app opening that entry. Stops after two timeouts with
  nothing made — a web build from before gallery links.
- **Deploy** (`deploy-site.yml`): only when the REPOSITORY variable `GALLERY_ENABLED` is
  `true` (an environment variable is not seen — the build job has no environment);
  otherwise `website/gallery` is removed from the artifact. The gallery repo is fetched
  by `git ls-remote` + clone, NOT `actions/checkout`, which fails on an empty repo and
  took the whole site deploy down with it (2026-11-01). Seeds are read from the RELEASE's
  demos (`website/desktop/demos`), the pin is the release's version, and thumbnails are
  rendered against the released web app — so until a release carries gallery links,
  cards show the striped placeholder.
- **Open in browser** (web build only): `components/gallery-links.js` reads
  `?gallery=<id>` once (then `replaceState`s it away so a reload does not reopen) and
  listens on the `chiphippo-gallery` BroadcastChannel; a second tab blocked by the
  one-tab Web Lock posts the id there instead (`host-entry.js`) and says
  `web.galleryHandedOff`. `ProjectWorkspace.openGalleryEntry(id)` → main's
  `gallery:open-entry` (`app/gallery/sources.js` — one host, ids only through
  `ENTRY_ID_RE`, a closed list of file names, the web build reading the gallery BESIDE
  its own page; `client.js` — size-capped at `MAX_SNAPSHOT_BYTES`, 15 s timeout, coded
  failures `missing`/`unavailable`/`invalid`/`tooBig`/`refused` → the
  `workspace.galleryError.*` sentences) → `desktopSnapshotOf` (the explicit desktop
  shape only) → `reseatImages`. It lands as an EXAMPLE does: a new desktop, framed,
  clean unless the project was dirty, switched to (by tab name) when already open; its
  chips join the PROJECT, never the library (D4). Refused on the desktop app until
  Phase 3's Gallery access setting.
- **`gallery/gallery-view.js`**: the grid written once — `source` (index, entry,
  thumbUrl), `say(key, params)` and `actions` handed in; `filterEntries`/`tagsOf` pure.
  The site's lint block treats `website/gallery/*.js` as modules; ESLint and Prettier
  skip the generated `website/desktop/` and `website/gallery/lib/`.
