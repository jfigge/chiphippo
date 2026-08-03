/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * project-images.js — the ROM bytes that travel INSIDE a project file.
 *
 * A non-volatile memory chip (Feature 180) keeps its bytes in a `.bin` sidecar
 * under `userData/memory/<guid>.bin`, and the document stores only the GUID.
 * That was fine while a design never left this machine; it is not fine now
 * that one file is meant to BE the design. So a project file carries its ROM
 * bytes, and `userData/memory/` demotes to a working CACHE that a project open
 * can rebuild in full.
 *
 * THE BYTES ARE CONTENT-ADDRESSED, IN A TABLE EVERY DESKTOP SHARES (v5):
 *
 *   images: { "<guid>": { "blob": "sha256-<hex>" } }   // whose bytes are whose
 *   blobs:  { "sha256-<hex>": "<base64>" }             // stored once, shared
 *
 * Keyed by GUID alone — as v4 was — the same 32 KiB ROM on two desktops cost
 * two full copies, because nothing in the file looked at the BYTES. Hashing
 * them answers both halves of the question at once and keeps nothing in sync:
 * two chips holding identical images name one blob, and the same file re-read
 * after being edited on disk hashes differently and becomes a second one.
 *
 * THE HASH IS MAIN'S, COMPUTED AT SAVE TIME FROM THE REAL SIDECAR — never
 * stored in the document. A hash in the document would have to be re-derived
 * on every hand-edit in the inspector, and a stale one restores the WRONG
 * BYTES, which is the worst failure this code could have. It is also a DEDUP
 * KEY and not a checksum: `hydrateImages` must never verify it, because the
 * only response to a mismatch would be to write the bytes anyway.
 *
 * THE PER-CHIP ENTRY IS AN OBJECT, AND THAT IS LOAD-BEARING. An older build
 * reading a v5 file runs its own `hydrateImages` over `images`, and a bare
 * `"sha256-…"` string decodes as base64 to 53 bytes of junk — past the
 * zero-length guard, straight over the sidecar, and collected back into the
 * file by the next save from that build. An object value is not a string, so
 * the old loop SKIPS it and the chip's existing "programmed, but its data file
 * is missing" warning explains itself. Honest degradation, not corruption.
 *
 *   · `collectImages` — on save, read each programmed ROM's file, hash it, and
 *     record chip → blob. Only a chip flagged `programmed` is collected: an
 *     unprogrammed ROM holds random noise, and noise does not need to travel.
 *   · `imagesOf` — on read, flatten either shape (v5's two tables, or a v4
 *     file's inline `{ <guid>: <base64> }`) into the flat map everything
 *     below already speaks. Aliasing a shared blob string costs nothing, so
 *     the dedup survives in memory as well.
 *   · `hydrateImages` — on open, write that map back into the cache before
 *     the renderer sees the project, so the SimController's Run-time load and
 *     the inspector both find real files exactly as they always did.
 *   · `reseatImages` — a desktop being COPIED (Import, Duplicate) must not
 *     share backing files with the original, or two chips would write one
 *     file. Every storage-bearing component gets a fresh GUID and a fresh
 *     file, sourced from the snapshot's own images when it has one and
 *     copied from the old GUID's cached file when it does not.
 *
 * DEDUP LIVES IN THE FILE, NEVER IN THE CACHE. One `.bin` per chip is what
 * keeps `DeskController#releaseMemory`'s unconditional delete-by-GUID correct
 * with no reference counting: a chip's file is its own, however many other
 * chips happen to hold the same bytes.
 *
 * This is the second place in main with document knowledge, after
 * migrations.js, and like it the knowledge is deliberately narrow: it reads
 * (and, in `reseatImages`, rewrites) `components[].params.storage.guid` and
 * reads `params.programmed`. Nothing else about a desk document is understood
 * here.
 *
 * The cache is never SWEPT. A `.bin` left behind by a deleted chip or a
 * deleted desktop is dead weight in userData and nothing more — it can never
 * re-enter a project file, because a save collects only what the live
 * documents still reference.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { randomUUID, createHash } = require("crypto");
const io = require("./io");

/** A crypto.randomUUID() the renderer minted for a memory chip. Anchored so a
    value carrying path separators / `..` can never reach the filesystem. */
const MEM_GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same ceiling mem-store enforces: far above any modelled memory part. */
const MAX_BYTES = 1 << 24; // 16 MiB

/** A blob's content-addressed name. The digest IS the key, so identical bytes
    name one blob and a file edited between two loads names two — the whole
    dedup rule, with nothing to keep in step. The `sha256-` prefix makes the
    file self-describing and leaves room to change digest without ambiguity. */
function blobKey(buf) {
  return `sha256-${createHash("sha256").update(buf).digest("hex")}`;
}

/** A chip GUID resolved to its cached backing file, or null for a bad GUID. */
function guidPath(memDir, guid) {
  if (!MEM_GUID_RE.test(String(guid ?? ""))) return null;
  return path.join(memDir, `${guid}.bin`);
}

/** Every file-backed memory chip in one desk document. */
function* storageChips(doc) {
  for (const comp of doc?.components ?? []) {
    const guid = comp?.params?.storage?.guid;
    if (typeof guid === "string" && guid) yield { comp, guid };
  }
}

/** Every desk document in a project meta (or the one in a desktop snapshot). */
function* documentsOf(meta) {
  if (meta?.doc) yield meta.doc;
  for (const tab of meta?.tabs ?? []) if (tab?.doc) yield tab.doc;
}

/**
 * The two image tables for a project (or a desktop snapshot): every PROGRAMMED
 * chip pointed at a content-addressed blob, and each distinct set of bytes
 * base64-encoded exactly once however many chips or desktops hold it.
 *
 * A file that is missing, unreadable, or absurdly large is skipped rather than
 * failing the save — a save that refuses to write because one sidecar went
 * missing would lose the whole design over a recoverable ROM.
 *
 * @param {object} meta - a project meta (`tabs[].doc`) or a `{doc}` snapshot.
 * @param {string} memDir - the memory cache directory.
 * @returns {{images: Record<string,{blob:string}>, blobs: Record<string,string>}}
 *   `images` is guid → blob reference, `blobs` is key → base64. `images` is
 *   non-empty exactly when `blobs` is, so one guard covers both.
 */
function collectImages(meta, memDir) {
  const images = {};
  const blobs = {};
  for (const doc of documentsOf(meta)) {
    for (const { comp, guid } of storageChips(doc)) {
      if (comp?.params?.programmed !== true) continue; // noise stays home
      if (Object.hasOwn(images, guid)) continue;
      const file = guidPath(memDir, guid);
      if (!file) continue;
      try {
        const buf = fs.readFileSync(file);
        if (buf.length > MAX_BYTES) continue;
        const key = blobKey(buf);
        if (!Object.hasOwn(blobs, key)) blobs[key] = buf.toString("base64");
        images[guid] = { blob: key };
      } catch {
        // Missing or unreadable: the chip keeps its `programmed` flag, and the
        // renderer's own "was programmed but its file is gone" warning is what
        // tells the user (memory-bridge.js). Not a reason to fail a save.
      }
    }
  }
  return { images, blobs };
}

/**
 * A parsed project or snapshot file's images as the flat `guid → base64` map
 * every consumer below already speaks — from either v5's two tables or a v4
 * file's inline block.
 *
 * The shape is told apart STRUCTURALLY (does it carry a `blobs` table?) rather
 * than by the stored `version`, the same rule project-migrate.js follows: the
 * tell is the thing that actually decides how to read the bytes.
 *
 * Flattening does not undo the dedup — `flat[guid] = blobs[key]` aliases one
 * JS string — so eight chips sharing a 16 MiB image still hold one copy.
 *
 * @param {object} raw - the parsed file, NOT a normalized meta.
 * @returns {Record<string,string>|null} null when the file carries no images.
 */
function imagesOf(raw) {
  const images = raw?.images;
  if (!images || typeof images !== "object") return null;
  const blobs = raw?.blobs;
  if (!blobs || typeof blobs !== "object") return images; // v4: inline base64
  const flat = {};
  for (const [guid, entry] of Object.entries(images)) {
    const encoded = blobs[entry?.blob];
    // A dangling reference is dropped rather than written as nothing: an empty
    // sidecar reads back as a programmed chip full of zeros, which is a lie.
    if (typeof encoded === "string") flat[guid] = encoded;
  }
  return flat;
}

/**
 * Write an `images` block back into the memory cache — the other half of a
 * project open. Existing files are OVERWRITTEN: the project file is the
 * source of truth for a non-volatile chip, and a stale cache entry from
 * another session must not win.
 *
 * @param {Record<string,string>|null} images
 * @param {string} memDir
 * @returns {number} how many files were written.
 */
function hydrateImages(images, memDir) {
  if (!images || typeof images !== "object") return 0;
  let written = 0;
  for (const [guid, encoded] of Object.entries(images)) {
    const file = guidPath(memDir, guid);
    if (!file || typeof encoded !== "string") continue;
    let buf;
    try {
      buf = Buffer.from(encoded, "base64");
    } catch {
      continue;
    }
    if (buf.length === 0 || buf.length > MAX_BYTES) continue;
    try {
      io.atomicWrite(file, buf);
      written += 1;
    } catch (err) {
      console.error("[store] memory hydrate:", err && err.message);
    }
  }
  return written;
}

/**
 * Give a COPIED desktop its own memory. Every storage-bearing component in
 * `doc` gets a freshly minted GUID (rewritten in place) and its own backing
 * file, so an imported or duplicated desktop can never share bytes with the
 * original — two chips writing one file is the bug this exists to prevent.
 *
 * The new file's contents come from `images[oldGuid]` when the snapshot
 * carried one (Import, from a file), and otherwise from the old GUID's cached
 * file (Duplicate, from the live desk). A chip with neither is left with no
 * file at all, which is exactly the un-programmed case the controller already
 * provisions as noise on placement.
 *
 * @param {object} doc - MUTATED in place (it is main's own parsed copy).
 * @param {string} memDir
 * @param {Record<string,string>|null} [images] - the snapshot's own bytes, as
 *   `imagesOf` flattens them: guid → base64, whichever shape the file used.
 * @returns {Map<string,string>} old GUID → new GUID.
 */
function reseatImages(doc, memDir, images = null) {
  const remap = new Map();
  for (const { comp, guid } of storageChips(doc)) {
    let next = remap.get(guid);
    if (!next) {
      next = randomUUID();
      remap.set(guid, next);
      copyImage(guid, next, memDir, images);
    }
    comp.params.storage = { ...comp.params.storage, guid: next };
  }
  return remap;
}

/** One reseated chip's bytes: from the snapshot's block, else the cache. */
function copyImage(from, to, memDir, images) {
  const target = guidPath(memDir, to);
  if (!target) return;
  const encoded = images && typeof images === "object" ? images[from] : null;
  if (typeof encoded === "string") {
    hydrateImages({ [to]: encoded }, memDir);
    return;
  }
  const source = guidPath(memDir, from);
  if (!source) return;
  try {
    const buf = fs.readFileSync(source);
    if (buf.length > MAX_BYTES) return;
    io.atomicWrite(target, buf);
  } catch {
    // No source file: the copy is simply un-programmed, and the controller
    // provisions it as noise the first time the chip is seen.
  }
}

module.exports = {
  collectImages,
  imagesOf,
  hydrateImages,
  reseatImages,
  blobKey,
  MEM_GUID_RE,
  MAX_BYTES,
};
