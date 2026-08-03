# Feature 330 — One copy of an image, and the file it came from

## Context

Feature 250 put every programmed ROM's bytes inside the project file, so a design
carries its memories with it. It keyed them by the chip: `images: { <guid>:
<base64> }`, one entry per chip, and the only dedup in the whole path was
`Object.hasOwn(images, guid)` — which can only ever fire for a document that
mentions one chip twice.

That leaves two gaps, and they are the same gap seen from either end.

**Nothing in the file looks at the BYTES.** Put the same 32 KiB ROM image on four
desktops of one project and the file holds four full base64 copies of identical
bytes — measured at 47 688 bytes where 14 916 would do. A bench design with a
monitor ROM on several desktops is exactly the shape that pays for it.

**And nothing records where an image came from.** `mem:pick-image` returned the
picked file's basename, `MemoryBridge.program()` used it for one `/\.hex$/i` test
and threw it away. The document kept a GUID and a `programmed` boolean, so the only
thing the memory inspector could show was `…/userData/memory/<guid>.bin` — which,
since Feature 250 demoted that folder to a CACHE the app rebuilds on every open,
names a file the user did not choose, cannot find twice, and gains nothing from
knowing. Asked "which ROM image is in this chip?", the app had no answer.

## Goal

A project file that stores each distinct image ONCE however many chips and desktops
hold it, restores every one of them on open, and remembers the file each was loaded
from — shown in the memory inspector and on the chip's Properties card.

## Design decisions (settled)

**THE BYTES ARE THE KEY, so both halves of the requirement fall out of one rule.**
`blobs` is content-addressed by `sha256-<hex>`; `images` is one small reference per
chip. Two chips holding identical images name one blob because they hash the same;
the same file re-read after being edited on disk hashes differently and becomes a
second blob. Nothing has to track which file a chip was loaded from to decide
this — asking the bytes is both cheaper and more honest than remembering.

```jsonc
{ version: 5, name, description?, activeTab, nextIndex,
  tabs: [ { id, name, description?, doc } ],
  images: { "<rom-guid>": { "blob": "sha256-<hex>" } },
  blobs:  { "sha256-<hex>": "<base64>" } }
```

**THE PER-CHIP ENTRY IS AN OBJECT, AND THAT IS THE LOAD-BEARING DETAIL.** With a
flat `images: { <guid>: "sha256-…" }` an OLDER build reading a v5 file runs its own
`hydrateImages`, which does `Buffer.from(value, "base64")` on every string — and a
hash string decodes to **53 non-zero bytes**, sailing past the `length === 0` guard
and `atomicWrite`ing junk over a good sidecar; a save from that build then collects
the junk and the real image is gone from the file too. Silent, permanent loss on a
downgrade, which is a realistic thing for an auto-updating app used on two machines.
An object value is not a string, so the old loop's `typeof encoded !== "string"`
check SKIPS it, the sidecar is untouched, and the chip's existing "programmed, but
its data file is missing" warning explains itself. Honest degradation instead of
corruption. (Renaming the map would have worked too, at the cost of churn
everywhere; the object also leaves room for another per-chip field without a second
version bump.)

**THE HASH IS MAIN'S, COMPUTED AT SAVE TIME FROM THE REAL SIDECAR — never stored in
the document.** A hash in the document would have to be re-derived on every
hand-edit in the inspector, and a stale one restores the WRONG BYTES, which is the
worst failure this code could have. Main hashing the file it is about to read cannot
go stale by construction. The corollary is that it is a DEDUP KEY and not a
checksum: the read path must never verify it and skip on a mismatch, because the
only useful response to a mismatch is to write the bytes anyway.

**DEDUP LIVES IN THE FILE, NEVER IN THE CACHE.** `userData/memory/` stays one `.bin`
per chip. That is what keeps `DeskController#releaseMemory`'s unconditional
delete-by-GUID correct with no reference counting — a chip's file is its own,
however many other chips happen to hold the same bytes. Sharing sidecars would have
turned deleting a chip into a question about every other chip on every desktop.

**BACK-COMPAT IS ONE FUNCTION AT THE READ BOUNDARY.** `imagesOf(raw)` flattens
either shape into the `guid → base64` map every consumer already speaks, so
`hydrateImages`, `reseatImages` and `copyImage` are untouched and `_asSnapshot`'s
documented `images: object|null` contract survives. It dispatches on the structural
tell (`raw.blobs` present) rather than the stored version, the rule
`project-migrate.js` already follows. Flattening does NOT undo the dedup: `flat[guid]
= blobs[key]` aliases one JS string, so eight chips sharing a 16 MiB image still hold
one copy in memory.

**THE SOURCE FILE IS PER-CHIP DOCUMENT STATE**, `params.storage = { guid, source?,
edited? }` — per chip rather than per blob because two chips can dedup to one blob
having been loaded from differently-named files, so a blob has no single right answer
and a chip does. Being document state it travels renderer → `project:save` → file
with no main-side work at all, and `reseatImages`' existing `{ ...comp.params.storage
}` spread carries it through Export/Import and Duplicate for free. `design-clip.js`
already deletes `copy.storage` wholesale, so a pasted chip correctly forgets it.

**`source` IS A LABEL, NEVER A PATH.** Nothing resolves it, opens it, or hands it to
`fs` — which is what makes it safe to keep an absolute path written on somebody
else's machine. It is capped at 1024 characters, because a hand-edited document could
otherwise put a megabyte of text through a `title` attribute.

**A HAND-EDIT KEEPS THE FILE AND MARKS IT.** `edited: true` rather than clearing
`source`: the file is still where the bytes came from, which is what was asked for —
they have simply moved on from it since. Loading again clears the mark, because those
ARE that file's bytes once more. Un-programming drops both, since a chip holding
noise came from nowhere.

**THE SOURCE FILE LEADS THE INSPECTOR'S BINDING LINE**, with the sidecar path moved
to the hover. Naming a cache the app rebuilds on every open as THE binding, while a
file the user actually chose exists, answers the wrong question. Copy path copies
whatever is on the line — the bare path, never the "(edited)" decoration.

## What is deliberately unchanged

**`ProjectWorkspace#imagesTouched` survives.** Programming from a NEW path now moves
`projectSignature` (`storage.source` changed), but re-programming from the SAME path
— the case this feature exists for — and every inspector Save after the first are
byte-identical documents. So the signature still cannot see ROM bytes, and the flag
is still the only thing between a re-programmed ROM and a lost auto-save.

**Two known behaviours, stated rather than fixed.** Undo of a "program memory" step
restores the previous `storage` but not the previous BYTES (the cache is not in the
history) — which is exactly what the `programmed` flag alone already did, so this is
consistent rather than new. And `get dirty()` remains signature-only, so
re-programming the same file still shows no •; folding `#imagesTouched` into it needs
a baseline that can absorb a boolean, which is a separate change.

Untouched and verified safe: `project-migrate.js` (keys off `tabs`, never images),
`upgradeLegacyDefault` (a v3 file yields `imagesOf → null`, then re-collects into v5
with no special case), `peekRecovery`, `mem-store.js`, `migrations.js`, the demo
generators, and every `storage.guid` reader.

## Implementation

| # | Where | What |
|---|-------|------|
| 1 | `app/store/project-images.js` | `blobKey(buf)`; `collectImages` returns `{images, blobs}`; new `imagesOf(raw)`; rewritten header |
| 2 | `app/store/project-store.js` | `PROJECT_VERSION = 5`; both write sites emit `{images, blobs}`; both read sites route through `imagesOf` |
| 3 | `web/scripts/model/project-doc.js` | the renderer's version mirror |
| 4 | `web/scripts/catalog/index.js` | `normalizeStorage` keeps `source` (capped) + `edited` |
| 5 | `app/main.js` | `pickMemoryImage` returns `path` instead of `name` (one consumer, and the `.hex` test reads a full path identically) |
| 6 | `components/desk-controller.js` | `setMemoryProgrammed(id, programmed, binding)`; `#memorySourceLabel`; the `imageSource` readonly row |
| 7 | `components/memory-bridge.js` | records `{source}` on program, `{edited:true}` on save, carries both on the context |
| 8 | `web/scripts/memory.js` | `bindingLabel()`, the hover, and Copy path |
| 9 | `locales/*.json` | `properties.field.imageSource`, `memory.sourceEdited` — all seven |

`storage` is patched WHOLE in `setMemoryProgrammed` because
`DeskDoc.setComponentParams` merges shallowly, so a partial patch would erase the
guid. The invariant lives in that one method rather than in `normalizeParams`, where
key-handling order would become significant and any `setComponentParams({programmed:
false})` in the app would silently drop the label.

## Acceptance

- Two desktops programmed from one file → **one** blob, two `images` entries pointing
  at it; the file is 69% smaller than v4 for four such desktops.
- The file edited on disk and one chip re-programmed → **two** blobs.
- Reopened with an empty cache, each chip gets **its own** bytes back.
- A v4 project still opens, and saves forward to v5.
- Export → Import re-mints the guid, copies the bytes, and keeps the label.
- Copy/paste gives an unprogrammed chip with no label.
- The inspector and the Properties card both name the file, marked `(edited)` after a
  hand-edit; an SRAM has no row and no label at all.
