---
paths:
  - "src/web/scripts/gallery/**"
  - "src/app/feature-flags.js"
  - "src/web/scripts/feature-flags.js"
  - "features/chiphippo-gallery-*.md"
---

## The gallery work

**Sharing, browsing and (later) challenges** — no feature number; called "the gallery
work" (Jason, 2026-10-31). Spec `features/chiphippo-gallery-spec.md`, plan + decisions
`features/chiphippo-gallery-plan.md` (Parts 2/2b hold every answer Jason gave). Built
phase by phase; **Phase 1 (format + validator + chip lineage) landed 2026-10-31**, the
rest is plan.

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
