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

// bundle.js — the app's own shipped content, where main looks for it.
//
// On the desktop main reads `web/demos/<ref>.json`, `web/docs/<page>.md`,
// `web/locales/<lang>.json` and checks `web/datasheets/<sheet>.png` from the
// app's folder. Here those files are on the site beside the page, so each is a
// LAZY node at the same path under `/web` (main's `__dirname` is `/app`): its
// name and size come from the build's manifest (web-host/files.json, written
// by scripts/build-web.mjs), its bytes from the site the first time anything
// reads it — asynchronously for `fs.promises`, which is how main reads a demo
// or a guide page, and synchronously only for the language catalogs, which
// host-entry.js fetches ahead so that path is never taken in practice.

const MANIFEST = "web-host/files.json";

/** A synchronous GET, for the one read main cannot wait for. */
function getSync(url) {
  const xhr = new XMLHttpRequest();
  xhr.open("GET", url, false);
  // Bytes, not text: every char code is one byte of the body.
  xhr.overrideMimeType("text/plain; charset=x-user-defined");
  xhr.send();
  if (xhr.status !== 200 && xhr.status !== 0) return null;
  const text = xhr.responseText;
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Register every bundled file the manifest lists.
 * @param {import("./vfs.js").Vfs} vfs
 * @param {string} baseUrl - the site's root, where index.html is.
 * @returns {Promise<string[]>} the paths registered
 */
export async function registerBundle(vfs, baseUrl) {
  const res = await fetch(new URL(MANIFEST, baseUrl), { cache: "no-cache" });
  if (!res.ok) throw new Error(`the build manifest is missing (${res.status})`);
  const { files } = await res.json();
  const paths = [];
  for (const [rel, size] of files ?? []) {
    const url = new URL(rel, baseUrl).href;
    const p = `/web/${rel}`;
    vfs.registerLazy(p, {
      size,
      loadSync: () => getSync(url),
      load: () => get(url),
    });
    paths.push(p);
  }
  return paths;
}

/** Fetch every language catalog now: main reads them synchronously (at
    startup, and again whenever the language setting moves), and a catalog
    already here is one that also works offline. */
export async function prefetchCatalogs(vfs, paths) {
  await Promise.all(
    paths
      .filter((p) => /^\/web\/locales\/[a-z]{2,3}\.json$/.test(p))
      .map((p) => vfs.readFile(p).catch(() => null)),
  );
}
