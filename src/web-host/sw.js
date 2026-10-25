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

// sw.js — the web build's service worker: it holds ONE release of the app,
// whole, so a repeat visit opens from the cache (and offline), and a new
// release arrives as a new worker that installs beside the old one and waits
// for the tab to say "restart" (web-host/updater.js).
//
// scripts/build-web.mjs prepends `const BUILD = {version, stamp, shell}`:
// `shell` is every file the app needs to start, fetched at install; anything
// else of the release (the guide's pages and pictures, the datasheet crops,
// the example circuits) is cached the first time it is fetched.

const CACHE = `chiphippo-${BUILD.version}-${BUILD.stamp}`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // `reload`: from the network, never an HTTP cache's older copy.
      cache.addAll(
        BUILD.shell.map((url) => new Request(url, { cache: "reload" })),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("chiphippo-") && key !== CACHE)
          await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const msg = event.data ?? {};
  if (msg.type === "skip-waiting") self.skipWaiting();
  else if (msg.type === "version")
    event.ports[0]?.postMessage({ version: BUILD.version });
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // The release's own manifest files are asked for fresh, to learn of a new
  // one; they are the only things not answered from the cache first.
  if (url.pathname.endsWith("/version.json")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // A page is cached by its path: pinout.html?ref=74LS00 is pinout.html.
      const key = req.mode === "navigate" ? url.origin + url.pathname : req;
      const hit = await cache.match(key, {
        ignoreSearch: req.mode === "navigate",
      });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.type === "basic") cache.put(key, res.clone());
      return res;
    })(),
  );
});
