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
 * that one file is meant to BE the design. So a project file carries an
 * `images` block — `{ <guid>: <base64> }` — and `userData/memory/` demotes to
 * a working CACHE that a project open can rebuild in full:
 *
 *   · `collectImages` — on save, read each programmed ROM's file into the
 *     block. Only a chip flagged `programmed` is collected: an unprogrammed
 *     ROM holds random noise, and noise does not need to travel.
 *   · `hydrateImages` — on open, write the block back into the cache before
 *     the renderer sees the project, so the SimController's Run-time load and
 *     the inspector both find real files exactly as they always did.
 *   · `reseatImages` — a desktop being COPIED (Import, Duplicate) must not
 *     share backing files with the original, or two chips would write one
 *     file. Every storage-bearing component gets a fresh GUID and a fresh
 *     file, sourced from the snapshot's own `images` when it has one and
 *     copied from the old GUID's cached file when it does not.
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
const { randomUUID } = require("crypto");
const io = require("./io");

/** A crypto.randomUUID() the renderer minted for a memory chip. Anchored so a
    value carrying path separators / `..` can never reach the filesystem. */
const MEM_GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same ceiling mem-store enforces: far above any modelled memory part. */
const MAX_BYTES = 1 << 24; // 16 MiB

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
 * The `images` block for a project (or a desktop snapshot): every PROGRAMMED
 * chip's cached bytes, base64-encoded, keyed by GUID.
 *
 * A file that is missing, unreadable, or absurdly large is skipped rather than
 * failing the save — a save that refuses to write because one sidecar went
 * missing would lose the whole design over a recoverable ROM.
 *
 * @param {object} meta - a project meta (`tabs[].doc`) or a `{doc}` snapshot.
 * @param {string} memDir - the memory cache directory.
 * @returns {Record<string,string>} guid → base64 (omitted entirely when empty).
 */
function collectImages(meta, memDir) {
  const images = {};
  for (const doc of documentsOf(meta)) {
    for (const { comp, guid } of storageChips(doc)) {
      if (comp?.params?.programmed !== true) continue; // noise stays home
      if (Object.hasOwn(images, guid)) continue;
      const file = guidPath(memDir, guid);
      if (!file) continue;
      try {
        const buf = fs.readFileSync(file);
        if (buf.length > MAX_BYTES) continue;
        images[guid] = buf.toString("base64");
      } catch {
        // Missing or unreadable: the chip keeps its `programmed` flag, and the
        // renderer's own "was programmed but its file is gone" warning is what
        // tells the user (memory-bridge.js). Not a reason to fail a save.
      }
    }
  }
  return images;
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
 * @param {Record<string,string>|null} [images] - the snapshot's own block.
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
  hydrateImages,
  reseatImages,
  MEM_GUID_RE,
  MAX_BYTES,
};
