# Gallery, Sharing & Challenges — review and implementation plan

Plan for `features/chiphippo-gallery-spec.md` (2026-10-30). Part 1 reviews the spec
against the codebase as it stands. Part 2 lists the decisions, as Jason confirmed them on
2026-10-31. Part 2b covers shared custom chips: their identity and revisions. Part 3 is
the build, phase by phase. There is no feature number: refer to all of this as **the
gallery work** (Jason, 2026-10-31).

---

## Part 1 — Review of the spec

The direction holds up: static hosting, opt-in sharing, a human merge, seeding from the
examples, and challenges as a later layer on the same entry format. Below are the points
where the spec conflicts with the code or with itself, roughly most important first.

### 1.1 The Worker should not hold a write token to the app repo, and rejected PRs are public for good

§2 puts submissions in the ChipHippo repo, as PRs opened by a Worker holding a repo
token. That has two problems:

- **Blast radius.** A leaked Worker token can push branches to the repo that builds and
  signs the releases. Fine-grained tokens can't be limited to one folder.
- **A closed PR on a public repo stays visible, diff included.** Every rejected
  submission (spam, abuse, someone's real name typed by mistake) would stay public.
  GitHub has no owner-side delete for a PR. That contradicts "manual merge is the
  moderation".

Pages does tie the domain to this repo, but the *content* can live somewhere else.
`deploy-site.yml` already pulls in outside content at build time (the latest release's
web zip). **Recommendation:**

- `jfigge/chiphippo-gallery-inbox` (**private**). The Worker opens PRs here and nowhere
  else. Its token is fine-grained: contents + pull-requests on this one repo, no
  `workflows` permission.
- `jfigge/chiphippo-gallery` (**public**). Holds accepted entries only. Merging in the
  inbox runs a publish job that copies the entry here and dispatches `deploy-site.yml`
  (the same `repository_dispatch` shape `refresh-site` already uses).
- `deploy-site.yml` gains a "Put the gallery at /gallery" step beside "Put the web app
  at /desktop".

This also keeps submission PRs out of the app's PR list, so they don't trigger `ci.yml`'s
eight-minute `make test`.

### 1.2 Generate the index at deploy time; never commit it

§5 says to regenerate "a single generated data file" on merge. If it's committed, two
open submissions both edit `index.json` and conflict. Build it in the deploy step from
`entries/*/entry.json` and keep it out of git, as `versions.json` is built today.

### 1.3 Thumbnails are made twice, and the client's copy shouldn't be sent

§3 generates a thumbnail locally and sends it. §5 renders one in CI. A client-sent image
is free-form content that has to be moderated and re-validated (§9). The CI render is
canonical and doubles as a smoke test. **Recommendation:** render locally only as the
preview in the consent dialog ("this is what will be published"), and send circuit +
metadata only. The Worker then never parses an image. CI renders with the **released**
web build (the zip `deploy-site` already fetches) in headless Chrome, reusing
`.docs-build/cdp.mjs`.

### 1.4 "Validate locally" must also catch what `normalizeDocument` silently drops

§3/§5 say "schema check + every component exists". The loader goes further: it
**silently drops** an overlapping board, a part whose footprint doesn't fit, a wire to a
non-point, or the loser of two leads in one hole (CLAUDE.md → "Document model"). A
submission that loads with pieces missing is a broken gallery entry that still passes.
**The validator should normalize and compare**: if anything was dropped or coerced, the
circuit is rejected and the dropped items are listed. Other things a validator needs to
handle:

- **ROM bytes** travel in the file, content-addressed (`project-images.js`). Cap them.
- **Custom chips** travel as `meta.customChips` (Verilog). Opening a project hands any
  chip the library lacks *to the library* (`#joinLibrary`). For gallery browsing that is
  a side effect the user didn't ask for (see decision D4).
- **Schema version**: `migrations.js` returns a doc from a *newer* app untouched. An
  entry has to record the `docVersion`/app version it was built with, so an older app
  can say "needs Chip Hippo ≥ x.y" instead of loading something half-understood.
- **Spice-only parts** (speaker, load, meter, mains, transformer): the entry needs
  `engine: "spice"`, and Open has to say "turn on Spice Lite" when it's off.

### 1.5 "Speed" can't be measured on the digital engine

§14.2 puts max clock frequency, settle time and propagation delay on the **digital**
engine. That engine is **zero-delay**: a tick settles to a fixed point, and time comes
only from what `SimController` hands timed parts (`sim/timing.js`). Clocks reach
20 kHz at most, against gate delays in nanoseconds. A frequency sweep would never fail,
so it would rank nothing.

Gate delay exists only in **Spice Lite**: a pass is one quantum, the shortest gate delay
on the desk, and slower chips hold outputs for `round(delay/quantum)` passes
(`spice-lite.md` → "Time"). So:

- **Settle time / critical path (ns)** is a Spice criterion, read from passes per tick ×
  quantum. `opts.stats` already counts passes (`make bench`).
- **Max frequency** is *derived*: 1 / (worst settle + setup), labelled as an estimate.
  It is not swept.
- The digital engine can rank correctness, part/chip counts and "cycles to result" (for
  example, clock edges until a counter shows the answer), which is a good criterion in
  its own right.

### 1.6 Most of the headless engine already exists

§14.5 calls the headless engine "the largest new dependency", but much of it is built:

- the engine is pure (`sim/`);
- `SimController` already runs off the DOM, in the Worker (`sim-worker.js` gives it an
  EventTarget for `window`);
- `bench/drive-spice.js` drives Spice Lite headless *exactly* as `SimController` does;
- `scripts/engine-diff.mjs` already pins an engine to a git ref (`git archive <ref>
  src/web/scripts`), which is the version pinning §14.5 asks for.

What's missing is smaller:

1. a **virtual-time stimulus driver** for both engines (signals, switches and data buses
   at scheduled times — today each script has its own ad-hoc clock flipping);
2. a **metrics module** with a fixed vocabulary;
3. a **determinism guarantee** (the same run twice gives bit-identical results, and the
   Worker agrees with the main thread).

### 1.7 Opening in the app

- **Renderer CSP is `default-src 'self'`; `img-src 'self' data:`.** The "one gallery UI
  written once" can't `fetch` inside the app. It needs a data **adapter**: on the website
  that's `fetch`; in the app it's `window.chiphippo.gallery.*`, with main fetching and
  handing thumbnails back as data URLs.
- **Network posture.** CLAUDE.md and `privacy.html` both state there are "exactly three"
  outbound calls, all opt-in, each with a hard-coded statement of where it may go. The
  gallery adds a fourth (read) and a fifth (share). Each gets its own `app/gallery/`
  module with a hard-coded host table (the `datasheets/sources.js` pattern). The
  renderer asks for an *entry id*, never a URL.
- **The web build allows one tab at a time** (Web Lock). Clicking "Open in Chip Hippo"
  on chiphippo.com/gallery while the app is open in another tab would land on the
  "already open" note. That needs a `BroadcastChannel` handoff to the running tab.
- **There is no URL/file handling in main at all** today. There's no `open-url`, no
  `open-file`, `second-instance` only raises the window, and there are no
  `protocols`/`fileAssociations` in `package.json`. So `chiphippo://` is new work on
  every platform: macOS `open-url`, argv on Windows/Linux first launch and
  `second-instance`, MAS `CFBundleURLTypes`, the Linux `.desktop` `x-scheme-handler`.
- **What Open does** should be what `ProjectWorkspace.openExample` does: an *addition* (a
  new desktop, ROM guids re-minted through `desktop.duplicate`), left clean, never
  replacing the desk, never auto-running.
- A website can't reliably tell whether the desktop app is installed. Show **Open in
  browser** / **Open in desktop app** / **Download** and don't try to detect.

### 1.8 Privacy & store paperwork the spec doesn't mention

- `website/privacy.html` says, word for word, "We don't collect, receive, or store your
  circuit designs" and "exactly three features that reach the network". Both need
  rewriting. The Worker also sees IP addresses (rate limiting), and the page has to say
  that.
- The App Store privacy label has to change once sharing exists (User Content, plus a
  name if an author name is sent).
- Consent copy has to say a shared design is **public and permanent**: git history keeps
  it even after removal.

### 1.9 Smaller points

- **Seeding (§6).** `src/web/demos/` holds 112 per-chip benches. Seeding them all would
  bury everything else under "74LS00 bench". Seed the ~25 hand-built examples (CPU
  computers, 555, RC/LC, transformer, speaker, bench parts). Optionally add the chip
  benches as **one** "Chip benches" collection. The open question in §6 has a clean
  answer: neither copies nor links. Generate the seed entries at deploy time **from the
  same release zip** that serves /desktop. A small committed `seed.json` holds only the
  titles, descriptions and tags, so the circuit can't drift from the app version that
  opens it.
- **Unit of sharing.** The spec never says whether a share is a desktop or a project. The
  existing export unit is the `.desktop.chiphippo` snapshot (document + ROM bytes + the
  custom chips it places). Use that for v1. Multi-desktop examples (the speaker's four)
  can come later as "project" entries.
- **Turnstile (§9)** needs a challenge page. The app's CSP forbids its script, so it would
  need a separate window loaded from chiphippo.com. With a private inbox, spam costs the
  maintainer time but never reaches the public. Defer Turnstile and rely on the size cap,
  the open-PR cap and the per-IP rate limit.
- **Class codes Tier 1 (§12).** A "long random address" on a *public* repo is no secret,
  because anyone can browse the repo's tree. Tier 1 needs the lesson files *outside*
  any public repo listing, which in practice means the Tier 2 store. Treat Tier 1 as
  "unlisted", and say so in its UI.
- **Hidden test vectors (§14.6)** can't live in anything Pages serves. They belong in
  the private inbox repo (or a CI secret), which the 1.1 split provides for free.
- **Compare view (§14.4).** Component ids are re-minted on every import, so two
  submissions share no ids. A diff has to match parts by kind + ref + seat, and the
  diff that means something is the **netlist** (what connects to what). Put it in the
  app, where both documents load, rather than on the website.
- **i18n.** Every app-side string goes through `t()` into all seven locales, which the
  i18n guards enforce. The website gallery can stay English like the rest of the site.

---

## Part 2 — Decisions

All answered by Jason on 2026-10-31. D5 and D6 are to be looked at again: D5 when
submissions are reviewed, D6 visually in the final design.

- **D1 — Two gallery repos** (private inbox + public gallery) instead of folders in the
  app repo (1.1). *Confirmed.*
- **D2 — The share unit is one desktop** (`.desktop.chiphippo` snapshot); project entries
  come later. *Confirmed.*
- **D3 — The seed is ~25 curated examples, generated at deploy from the release zip.**
  *Confirmed.* Jason will add more with the AI circuit builder. Those are **maintainer
  entries**: committed straight to the public gallery repo (no Worker, no inbox), but
  held to the same `validateSubmission` + derive + thumbnail CI there, so a hand-added
  entry can't skip a check a shared one gets. No "Chip benches" collection for now.
- **D4 — Custom chips in a gallery design are allowed, but opening one doesn't add them
  to the library.** The imported desktop's project carries them (the existing
  `ownChips` path). A "Save chip to my library" action is offered on the chip instead.
  This needs a flag on the import path. *Confirmed.* Revisions are handled in Part 2b.
- **D5 — Thumbnails are rendered in CI only.** The client renders a preview and doesn't
  send it. *OK for now; revisit when submissions are reviewed.*
- **D6 — Speed criteria are Spice-only and derived** (1.5). *OK for now; needs a visual
  review in the final design.*
- **D7 — Scores are pinned to the version they were measured on, and re-scored only when
  a newer app opens them** (Jason, 2026-10-31, replacing "re-score everything on each
  release"):
  - **Pinned.** Every entry's metadata records `appVersion` (validated on), and every
    challenge submission's score records `{appVersion, date, correct, values}`.
  - **Checked before download.** When an app newer than the entry's pin opens or
    downloads it, the app first runs a **compatibility test** locally: validate, then
    load and compare with what was dropped. For a challenge submission it also runs the
    harness (Phase 6), giving pass/fail plus a fresh score. The user sees the result
    *before* the desktop is imported (for example "still passes on 1.7.0; settle time
    142 → 138 ns", or "no longer loads clean on 1.7.0: 2 wires dropped").
  - **Captured, then published.** The result is sent as a **report** to the Worker, only
    from a published release, never a dev build. A report is `{entryId, appVersion,
    result}`, with no circuit and no personal data. A client's numbers are still never
    published: the first report per (entry, version) **queues an inbox CI re-score** at
    that version. The trusted run then updates the entry's metadata (a new pin, new
    scores, or a compatibility flag) and dispatches `deploy-site`, so the gallery is
    updated then and there.
  - **The gallery shows the pin.** Rankings show each score with its version. A
    submission whose re-score fails correctness is flagged, not removed.
  - So re-scoring is **lazy**: only entries people actually open on a newer app are
    re-run, and no release job sweeps the whole gallery.
- **D8 — A Settings ▸ Gallery tab with two settings**, written by the Settings dialog and
  by the first-time prompts, and enforced in main (each `gallery:*` handler reads them):
  - **Gallery access: Yes | No** (`galleryAccess`, unset until first asked). Asked
    **once**, the first time the Gallery is opened, and stored. *No* makes main refuse
    every gallery fetch, including compatibility reports.
  - **Share consent: Yes | No | Ask** (`galleryShare`, default *Ask*):
    - *Ask* shows the explicit consent block on every Share;
    - *Yes* replaces it with one line saying what is sent (the Share publicly button
      is still pressed each time; nothing is sent without that press);
    - *No* disables Share to Gallery, showing a hint that points at Settings ▸ Gallery.
- **D9 — Everything is behind the `gallery` feature flag** (Jason, 2026-10-31) until
  the gallery is ready to ship. There was no flag mechanism before, so Phase 1 built
  one (`app/feature-flags.js`; see `.claude/rules/gallery.md`):
  - it's switched on by `make debug FEATURES=gallery`, `CHIPHIPPO_FEATURES=gallery`,
    a hand-edited `"features": ["gallery"]` in settings.json, or `?features=gallery` on
    the web build;
  - the renderer reads it with `featureEnabled("gallery")`;
  - every gallery menu item, window and Settings ▸ Gallery tab is hidden while it's
    off, and main refuses every `gallery:*` channel on its own;
  - the site's `/gallery` deploy step is held by a repository variable
    (`GALLERY_ENABLED`, like `AUR_ENABLED`), and the Worker isn't deployed until then;
  - data is never flagged: chip lineage is kept in every build.

---

## Part 2b — Shared custom chips: identity and revisions

**The problem, in today's code.** A chip's `id` (`custom-xxxxxxxx`, the catalog ref
every placed part carries) is minted once and survives edits. When a desktop arrives,
`mergeCustomChips` does this: if the id is unknown, the chip comes in; if it's known and
identical, the chip is reused; **if it's known and different, the chip is re-minted
under a new id**. So with no other change, every download of an edited "MY74" would add
another MY74 to the project, and every "Save to library" another to the library: the
pile of similarly named chips you described.

The local id can't be the lineage either:

- it has 32 random bits, so two users' chips can collide;
- nothing stops someone else publishing a chip under the same id and passing it off as
  an update.

### The rule

1. **The gallery assigns the identity.** The first time a chip is published, CI mints a
   gallery chip id (`gcid`) and stores the chip at `chips/<gcid>/r1.json`. Each later
   published change is `r2`, `r3`, …, each with a content hash. The hash covers the
   behaviour fields: everything except `id` and `origin`.
   - The published copy carries `origin: {gcid, rev, hash}`.
   - `normalizeCustomChip` and main's `sanitizeCustomChips` keep `origin` (today they
     drop unknown fields).
   - The design file still embeds the chip, so a download stays self-contained and
     works offline.
2. **Only the original sharer can publish a new revision. That needs no account: each
   install gets a publisher key.**
   - On the first Share, main generates a random secret and stores it with
     `credential-store.js`. The Worker records only the secret's hash as the owner of
     whatever that share creates.
   - A share whose chip carries an `origin` with a **changed hash** is a new revision
     if it comes from the owner's key.
   - From any other key it's flagged in the review comment ("claims to update X,
     published by someone else"), and the default is a **new** chip. A maintainer can
     still assign it to the existing chip by hand, for example when the owner has
     reinstalled.
   - The same key lets a sharer **update their own design entry** instead of creating a
     second one.
   - The key is pseudonymous (*accepted*, Jason 2026-10-31); the consent copy and the
     privacy page say so.
3. **On import, a chip is matched by `origin.gcid`, never by local id.** For a chip the
   project or library already holds:

   | Arriving chip | Result |
   |---|---|
   | Same gcid, same hash | Reuse the chip already there. Nothing added. |
   | Same gcid, newer rev, **package-compatible**¹ | Ask once: **Update** (*the default*, Jason 2026-10-31; every desktop in this project now uses rN, keeping the local id, so no part moves) or **Keep both** |
   | Same gcid, newer rev, package changed | Keep both. Parts placed for the old pinout can't safely be moved to the new one. |
   | Same gcid, *older* rev | The arriving desktop uses the project's newer copy if package-compatible; otherwise keep both |
   | Different gcid, same name | A different chip; shown with its author in the tray tooltip |

   ¹ Same `pinsPerSide`, `wide`, `vcc`/`gnd` and port → pin map: only the Verilog
   changed, so every placed part stays legal.

   "Keep both" doesn't make look-alikes. The second copy is marked as a revision of the
   same chip (`MY74 · r3`), and the tray groups revisions of one gcid under one entry, so
   a later **Update all** can merge them into one.
4. **The library holds one chip per gcid, the newest saved.** Saving a newer revision
   replaces the library's entry in place (same local id). Saving an older one over a
   newer one asks first.
   - This is safe because `chipRegistry` already lets a project's own copy override the
     library's. Projects built with r1 keep r1 until their owner updates them.
   - Designs shared with r1 keep opening with r1, so old entries and challenge
     submissions stay reproducible.
5. **A local edit forks.** Saving a chip that has an `origin` in the designer turns it
   into `forkedFrom: {gcid, rev}`. Updates no longer apply to it, so an incoming revision
   can't overwrite someone's own changes. Sharing a fork gets a new gcid with a `parent`
   link, which the gallery's chip page shows as "derived from".
6. **New revisions are found only while browsing.** The Browse Gallery window, which is
   already behind the gallery-access consent, can show "2 chips in your library have
   newer revisions". There's no background check, so the network posture stays as it is.

The gallery also gets a **chip page** for each gcid: its revisions, their changes (a code
diff) and the designs that use each one.

---

## Part 3 — Phases

Each phase can ship on its own. Pure logic sits in DOM-free modules with sibling
`node --test` suites. Every new IPC channel goes into `ipc-parity.test.js`'s scan.
Every new `.js` file gets the GPL header.

### Phase 1 — Entry format and validator (pure, shared) — *built 2026-10-31*

As built: `gallery/{entry-format,derive,validate,index-format}.js`, the chip lineage in
`model/custom-chip.js` + `store/custom-chips.js`, `catalog/index.js` `withCustomChips`,
and the feature flag (D9). Tests: `gallery-entry`, `gallery-validate`,
`custom-chip-lineage`, `feature-flags` (both halves), the web build's `?features=`.
`deriveEntry` currently tags the 555 as `timer` (its catalog group), not "clock/
oscillator" as the spec's example has it; `oscillator` is the crystal cans.

The foundation everything else reads. It goes in `src/web/scripts/gallery/`, so the app,
the web build, CI scripts and (via a copy step) the Worker all import the same code.

- `gallery/entry-format.js`
  - `entry.json` v1:
    - `{schema: 1, id, kind: "design" | "challenge", title, author, description,
      tags: [], created, appVersion, docVersion}`;
    - plus **derived** fields, which CI writes and never trusts from the client:
      `{engine, chips, parts, families, level, autoTags, featured}`.
  - The `id` is `<slug>-<6 hex of content hash>`. Text length limits live here.
- `gallery/validate.js` — `validateSubmission(bytes)`:
  - size cap (512 KiB);
  - JSON;
  - migrate + `normalizeDocument`, then **diff before/after** and reject anything that
    was dropped (1.4);
  - catalog refs exist;
  - custom chips go through `normalizeCustomChip` and must compile (`hdl/compile.js`);
  - ROM total ≤ cap;
  - no `newer docVersion`.

  It returns `{ok, problems[], derived}`.
- `gallery/derive.js`:
  - auto-tags from contents (CPU + ROM → `cpu`, a 555/4047/clock → `oscillator`,
    spice-only parts → `analog`, a seg7 → `display`, …), as a data table, not code
    paths;
  - `level` from chip count + CPU presence;
  - `engine` from `spiceOnly` parts.
- `gallery/index-format.js` — the index the site and the app read: a list of entry
  summaries, `collection` metadata, paginated past N.
- **Chip lineage, the pure half (Part 2b):**
  - `model/custom-chip.js` gains `origin` / `forkedFrom` in `normalizeCustomChip`, with
    the field-for-field twin in `store/custom-chips.js` `sanitizeCustomChips`;
  - `chipContentHash`;
  - `packageCompatible(a, b)`;
  - `mergeCustomChips` matches by `origin.gcid` before id and returns the "ask"
    cases (newer, compatible) instead of re-minting them.
  - Tests cover every row of the Part 2b table, and check that a fork drops
    `origin`.
- Tests:
  - every shipped example validates clean and derives sensible tags;
  - hand-made bad docs (overlap, double lead, unknown ref, oversized ROM) are each
    rejected with their problem named.

### Phase 2 — Static gallery site, seeded — *built 2026-11-01*

As built (`.claude/rules/gallery.md` → Phase 2), with two departures from the text
below: **`seed.json` lives in this repo** (`website/gallery/seed.json`) with an
integrity test, not in the gallery repo; and **thumbnails are PNGs rendered at every
deploy** against the released web app, not WebP committed by an inbox job. The
in-app half of Open in browser (`gallery:open-entry`, `openGalleryEntry`) landed here
too, web-only until Phase 3.


- New repo `chiphippo-gallery`: `entries/<id>/{entry.json, design.desktop.chiphippo,
  thumb.webp}`, plus `seed.json` (example → title/description/tags).
- `scripts/build-gallery.mjs`:
  - reads the gallery checkout + the release zip's demos;
  - validates each entry (Phase 1);
  - writes `website/gallery/` (git-ignored): `index.json`, per-entry files, thumbnails.
- `scripts/render-thumbs.mjs`:
  - boots the released web build headless (CDP, as `.docs-build/capture.mjs` does);
  - loads each entry lacking a cached thumbnail, frames it, captures a small WebP
    (≤ 40 KB);
  - caches by content hash.
- `deploy-site.yml`: checkout `chiphippo-gallery`, then build-gallery, then
  render-thumbs (with a cache) before "Upload site artifact".
- **Shared view** `gallery/gallery-view.js` (DOM, no framework):
  - cards, search, tag/level/engine filters, a detail pane;
  - constructed with `{source, strings, onOpen, onDownload}`; `source` is an adapter
    (`fetchIndex`, `fetchEntry`, `thumbUrl`).
  - The website wraps it with `fetch` and English strings.
  - `website/gallery/index.html` + `gallery.js`; a nav link; `website-nav.test.js`
    extended.
- **Open in browser**:
  - `/desktop/?gallery=<id>`. `host-entry.js` passes it to main as a launch request.
  - Main fetches `/gallery/entries/<id>/design.desktop.chiphippo` (same origin) and
    relays it to the renderer's `openExample`-style import (`importTab` with the read
    swapped for the fetched bytes).
  - If another tab holds the Web Lock, hand the request to it over a `BroadcastChannel`
    and show "Opened in your other Chip Hippo tab".
- Tests:
  - build-gallery over a fixture repo (bad entry excluded and reported);
  - gallery-view in jsdom (filter, search);
  - `web-boot.test.js` gains a `?gallery=` boot and a handoff case.

### Phase 3 — In-app Browse Gallery (desktop + web)

- Main `app/gallery/`:
  - `sources.js`: the hard-coded host table, `https://chiphippo.com/gallery/` only for
    now, with the comment block in the `datasheets/sources.js` style;
  - `client.js`: fetch the index/entry/thumbnail, size caps, timeouts;
  - IPC: `gallery:index`, `gallery:entry`, `gallery:thumb` (→ data URL),
    `gallery:open` (→ bytes for import).
  - The renderer passes ids only. Main refuses everything unless `galleryAccess` is
    *Yes*.
- **The gallery access prompt**, shown once on the first Browse Gallery…: what is
  fetched, from where, and that no circuit data is sent. Yes / No is stored as
  `galleryAccess`, and never asked again (D8).
- **Settings ▸ Gallery** (a new tab; `settings.md` gains it): Gallery access
  Yes | No, and Share consent Yes | No | Ask (*Ask* by default). The Share row arrives
  in Phase 5, but the tab is built here so there's one place for both. All its strings
  go into the seven locales.
- **The compatibility check before download** (D7). `gallery:open` answers with the
  entry's pin. When it's older than this app, the renderer runs the test (`gallery/
  compat.js`, pure: validate, then normalize and diff, comparing derived fields) and shows the
  result before importing. The harness half of the test arrives with Phase 7.
  `gallery:report` (main) posts `{entryId, appVersion, result}` to the Worker, only
  from a published release and only with gallery access on. The Worker side (queueing
  the trusted re-score) comes in Phase 5.
- Renderer: Help or File ▸ **Browse Gallery…** opens the shared `gallery-view.js` in an
  auxiliary window (`gallery.html`, its own CSP, the `ui-chrome.md` window pattern),
  using the IPC adapter and `t()` strings.
- Open = import as a new desktop, clean, not running. On the way in:
  - an entry with `engine: "spice"` while Spice Lite is off offers to switch it on;
  - a newer `docVersion` gives "needs Chip Hippo ≥ x.y" and the import is refused;
  - custom chips follow D4 + Part 2b: there's an Update / Keep-both question, the tray
    groups revisions of one gcid, a chip's menu has "Save to my library" (one per gcid,
    newest wins), the designer forks on save, and the Browse window lists library chips
    with newer revisions.
- `privacy.html`, `src/web/docs/` (a "Gallery" guide page) and CLAUDE.md's network
  statement are updated in this phase, because this is the release where the app first
  reaches a fourth host.
- Tests:
  - main client against a stub server (caps, timeouts, the consent gate, an id with
    `../` refused);
  - ipc-parity;
  - i18n guards;
  - an import test (ROM guids re-minted, desktop clean, chips not joined to the
    library).

### Phase 4 — `chiphippo://` links

- `chiphippo://gallery/<id>` only. The handler parses an **id**, never a URL, so a link
  can't make main fetch anything off the host table. `app/deep-link.js` is a pure
  parser with tests, in the `cli-args.js` style.
- Main:
  - `app.setAsDefaultProtocolClient("chiphippo")`;
  - `open-url` (macOS, including before `ready`: queue it);
  - argv on first launch and in `second-instance` (Windows/Linux);
  - the request goes through the same `gallery:open` path, behind the same consent.
- Packaging:
  - `package.json` `build.protocols`;
  - MAS `CFBundleURLTypes` (check it survives `mas` signing);
  - the Linux `.desktop` `MimeType=x-scheme-handler/chiphippo` (deb, rpm, AUR template);
  - NSIS registers it on Windows.
- **`fileAssociations` for `.chiphippo`** (*confirmed*), so a downloaded entry, or any
  project, opens on double-click. `open-file` (macOS) and argv (Windows/Linux) take the
  same queue as `open-url`. A path arriving this way becomes a dialog-established path
  for `knownPath`, the same as one picked in File ▸ Open. The MAS build needs
  `CFBundleDocumentTypes`.
- The website detail page gets **Open in desktop app** (`chiphippo://…`) beside Open in
  browser and Download.

### Phase 5 — Share

- **Renderer Share dialog** (desktop tab menu ▸ Share to Gallery…):
  - title, author name, description, tags;
  - a local preview thumbnail (D5);
  - the validator's verdict (Phase 1) shown *before* consent;
  - the consent block follows Settings ▸ Gallery ▸ Share consent (D8):
    - *Ask*: the explicit block (public, permanent, what is sent: the design and the text
      fields, plus the server seeing an IP address and a pseudonymous publisher key);
    - *Yes*: one line saying the same;
    - *No*: Share to Gallery is disabled, with a hint pointing at the setting.
  - The button reads "Share publicly", and pressing it is always what sends. It's
    disabled while the circuit runs.
- **Main `app/gallery/share.js`**: the fifth network call. It POSTs the
  `.desktop.chiphippo` snapshot (built by the existing export path) plus metadata to the
  one hard-coded Worker URL and returns `{ok, ticket}` or a coded refusal (too big, rate
  limited, invalid, service down).
- **The Worker** (`services/gallery-worker/`, in this repo so it shares
  `gallery/validate.js` through a build copy; deployed with `wrangler`):
  - size cap; open-PR cap (it counts inbox PRs); per-IP rate limit (KV, a hashed IP
    with a TTL, no raw IP stored);
  - re-runs `validateSubmission`; text limits + a basic profanity list on the text
    fields;
  - then commits `entries/<id>/…` on a branch in the **inbox** and opens a PR.
- **Inbox Actions** (`pull_request`, `permissions: contents: read`, no secrets):
  - check the PR touches only `entries/<id>/`;
  - validate with the **released** app's code (the `engine-diff.mjs` git-archive
    pattern, pinned to the latest tag);
  - render the thumbnail;
  - write derived fields;
  - post a review comment with thumbnail, tags, level and problems.

  On merge, a publish job copies the entry to the public gallery repo and dispatches
  `deploy-site`.
- **Compatibility reports (D7).**
  - The Worker accepts `POST /report` `{entryId, appVersion, result}`, rate-limited
    like a share.
  - The first report per (entry, version) for a **published** version (checked against
    `versions.json`) dispatches an inbox job. That job runs `validateSubmission` (and,
    for a challenge submission, `gallery-score.mjs`) at that tag.
  - The job commits the new pin, the scores or a compatibility flag to the entry's
    metadata in the public repo, with no human merge (it changes derived fields only,
    never content), and dispatches `deploy-site`.
  - Later reports for the same pair are dropped.
- **Chip revisions (Part 2b):**
  - main mints the publisher key on the first share (`credential-store.js`) and sends
    it with each share; the Worker keeps only its hash, as the owner of the entries and
    chips that share creates;
  - inbox CI mints `gcid`s for new chips, decides new-chip vs new-revision, and puts a
    flag in the review comment for a revision from a key that isn't the owner's;
  - on merge, `chips/<gcid>/r<n>.json` is written to the public repo;
  - a share from the owner's key that names an existing entry updates that entry.
- Tests:
  - the Worker's request handler under `node --test` with a mocked GitHub API (caps, rate
    limit, a bad payload, profanity);
  - the main share client against a stub;
  - the dialog in jsdom.

### Phase 6 — Headless harness and metrics

Smaller than the spec expects (1.6). It's needed before challenges, and also useful for
the existing benches.

- `sim/harness.js` (pure). A **virtual-time driver** for either engine:
  - a document + a stimulus schedule (`[{at, signal | switch | data, value}]`, clock
    rates) run to `seconds`, with no wall clock;
  - observations sampled at chosen times on **named nets / signals** (Feature 120 names,
    so they survive rearrangement).
  - It **replaces** the ad-hoc drivers in `bench/drive-spice.js` and
    `scripts/engine-diff.mjs`, so there's one statement of "how a run is driven" and
    `make bench` / engine-diff keep their numbers (gate: engine-diff passes, bench within
    noise).
- `sim/metrics.js` — a fixed vocabulary, each with `{engine, direction, unit}`:
  - `chips`, `parts`, `wires` (static);
  - `correct` (pass/fail against expected samples);
  - `cyclesToResult` (logic);
  - `settleNs` (Spice: passes × quantum, worst over the run);
  - `fmaxEstimate` (derived);
  - `supplyMaxmA`, `supplyAvgmA`, `powermW` (Spice `supply.js`);
  - `netVoltage`, `riseNs` (Spice).

  A new criterion is one entry here.
- `scripts/gallery-score.mjs`: a CLI around harness + metrics, with a wall-time limit
  and a simulated-seconds cap (per the §14.5 budget).
- Determinism tests:
  - the same run twice is bit-identical, in both engines;
  - the harness agrees with the SimController in the Worker for an identical schedule
    (the Worker-vs-main parity tests the project already has).

### Phase 7 — Challenges

- `challenge.json` beside `entry.json` (`kind: "challenge"`):
  - the base design;
  - `io`: the named signals/nets a submission **must keep**, which is the "required I/O"
    constraint and what the harness binds to;
  - `stimulus` + `expect` (the correctness vectors);
  - `criteria`: metric ids from Phase 6 + direction;
  - `constraints`: max chips, allowed families, Spice required or not;
  - `status`: open/closed, optional close date.

  Hidden vectors live in the inbox repo only.
- A submission is a Share with `challenge: <id>`. The Worker validates; inbox CI runs
  `gallery-score.mjs` on the latest release and writes `scores.json` (`{appVersion,
  date, correct, values}`), the version it is pinned on. There is no release-wide
  re-score: a newer app opening a submission runs the harness locally as part of the
  compatibility check (D7). Its report queues one trusted inbox re-score at that version,
  which updates the scores, the pin and the ranking.
- **Score locally first.** The Share dialog runs the same harness in the app (the
  simulation Worker runs it off the main thread) and shows the numbers before consent. A submission that
  fails `correct` isn't sendable. That saves most round trips.
- The challenge page (website + in-app view):
  - grid of base + accepted submissions, Sort By driven by `criteria`, rank per
    criterion;
  - best-per-criterion badges and a Pareto toggle;
  - separate rankings only in v1, with no weighted overall (ties broken by date).
- **Compare** (in app): open two entries as desktops. A diff tints parts in B absent
  from A, matched by kind + ref + seat (the board turns red as the spec asks, using the
  existing `board--` state classes), with a netlist-diff list beside it. Website compare
  is a later item.

### Phase 8 — Collections and Tier 1 class codes

- The collection convention: any repo publishing `index.json` in the Phase 1 format.
- Main's host table widens to `https://<user>.github.io/<repo>/…` and
  `raw.githubusercontent.com/<user>/<repo>/…`, which serve CORS, so the web build can
  reach them too.
- The directory is a curated `collections.json` in the public gallery repo (paged
  50 at a time, searchable).
- "Join a class": a code maps to a collection URL kept on a local shelf
  (`userData/gallery-shelf.json`), never listed. Labelled *unlisted, not private*
  (1.9).

### Deferred (unchanged from the spec)

Ratings, Tier 2 class codes (D1/R2 behind the Worker), the paid teacher service,
Turnstile, website-side compare, project (multi-desktop) entries.

---

## Rough sizing

| Phase | Size | Risky part |
|---|---|---|
| 1 Format + validator | M | the normalize/diff pass covering every drop rule; gcid matching in `mergeCustomChips` |
| 2 Static site + seed | M | headless thumbnail render in CI; the one-tab handoff |
| 3 In-app browse | M | consent + network-posture paperwork; the import flags |
| 4 Deep links | S–M | platform packaging (MAS, Linux, NSIS) |
| 5 Share | M–L | the Worker + inbox Actions; keeping CI secret-free |
| 6 Harness + metrics | M | bit-for-bit parity with the existing drivers |
| 7 Challenges | L | harness definition UX; compare diff |
| 8 Collections | S–M | host-table widening |

Phases 1–3 give a working read-only gallery with zero server code. Phase 5 is the first
one with a running service.
