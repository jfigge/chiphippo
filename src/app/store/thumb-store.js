/*
 * Copyright 2026 Jason Figge
 *
 * This file is part of Chip Hippo.
 *
 * Chip Hippo is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free
 * Software Foundation, either version 3 of the License, or (at your option)
 * any later version.
 *
 * Chip Hippo is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with Chip Hippo. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * thumb-store.js — the picture of each RECENT project's board, for the Browse
 * window's Recent Projects grid.
 *
 * A CACHE in the app's own folder (`userData/thumbs/`), never in the project
 * file: a picture is not part of the design, would put ~50 KB on every save,
 * and would be one more thing a shared file carries that nobody asked to share.
 * The price is that a project moved on disk shows the striped placeholder
 * until it is next opened or saved, which takes a new one.
 *
 * Each project is keyed by the SHA-256 of its path, so no path is ever a file
 * name here and none ever crosses the bridge: `<key>.png` is the picture and
 * `<key>.json` what was true when it was taken (`{desktops}`). Only paths on
 * the MRU list are ever written (main checks), and `pruneThumbs` drops every
 * picture whose project has left it.
 */
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { atomicWrite } = require("./io");

/** The largest picture kept, in bytes — a capture is ~480 px wide. */
const MAX_THUMB_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // prettier-ignore
const KEY_RE = /^[0-9a-f]{64}$/;

/** The cache key of a project path. */
function thumbKey(filePath) {
  return crypto.createHash("sha256").update(String(filePath)).digest("hex");
}

/**
 * Keep `png` as the picture of the project at `filePath`. Not durable (no
 * fsync): it is a cache, and a lost picture is retaken at the next save.
 * @param {string} dir
 * @param {string} filePath
 * @param {Buffer} png
 * @param {{desktops?: number}} [meta]
 * @returns {boolean} whether it was kept.
 */
function writeThumb(dir, filePath, png, meta = {}) {
  if (!Buffer.isBuffer(png) || png.length > MAX_THUMB_BYTES) return false;
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  const key = thumbKey(filePath);
  const desktops = Number.isInteger(meta.desktops) && meta.desktops > 0 ? meta.desktops : null; // prettier-ignore
  atomicWrite(path.join(dir, `${key}.png`), png, { durable: false });
  atomicWrite(
    path.join(dir, `${key}.json`),
    JSON.stringify({ desktops, takenAt: Date.now() }),
    { durable: false },
  );
  return true;
}

/**
 * The picture of `filePath` as a `data:` URL, plus what was kept with it —
 * or nulls when there is none (never taken, or unreadable).
 * @returns {{thumb: string|null, desktops: number|null}}
 */
function readThumb(dir, filePath) {
  const key = thumbKey(filePath);
  let thumb = null;
  let desktops = null;
  try {
    const png = fs.readFileSync(path.join(dir, `${key}.png`));
    if (
      png.length <= MAX_THUMB_BYTES &&
      png.subarray(0, 8).equals(PNG_SIGNATURE)
    ) {
      thumb = `data:image/png;base64,${png.toString("base64")}`;
    }
  } catch {
    /* none taken yet */
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), "utf8")); // prettier-ignore
    if (Number.isInteger(meta?.desktops) && meta.desktops > 0) desktops = meta.desktops; // prettier-ignore
  } catch {
    /* none kept */
  }
  return { thumb, desktops };
}

/**
 * Remove every picture whose project is not in `keepPaths` (the MRU list
 * after a change). Anything in the folder that is not ours is left alone.
 * @returns {number} how many files were removed.
 */
function pruneThumbs(dir, keepPaths) {
  const keep = new Set((keepPaths ?? []).map(thumbKey));
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const m = /^([0-9a-f]{64})\.(png|json)$/.exec(name);
    if (!m || !KEY_RE.test(m[1]) || keep.has(m[1])) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

module.exports = {
  MAX_THUMB_BYTES,
  thumbKey,
  writeThumb,
  readThumb,
  pruneThumbs,
};
