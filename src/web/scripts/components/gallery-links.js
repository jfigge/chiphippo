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

// gallery-links.js — how a gallery design reaches the app from OUTSIDE it, on
// the web build (the gallery work; app.js wires this on the web build only).
// Two doors, one action — `open(id)`,
// ProjectWorkspace.openGalleryEntry:
//
//   · the ADDRESS: the gallery's "Open in browser" is /desktop/?gallery=<id>.
//     Read once at boot and taken OFF the address (replaceState), so a reload
//     — which the web build does to update itself — does not open it again;
//   · a SECOND TAB: only one tab may run the app (a Web Lock), so a link
//     opened while another tab has it cannot boot. web-host/host-entry.js
//     hands the id across on GALLERY_CHANNEL instead (`handOffGalleryLink`),
//     and the tab that holds the app opens it here — and ANSWERS, so the
//     second tab says "Opened in your other tab" only when one did. A tab
//     that holds the lock but is still booting has no listener yet, so the
//     hand-off is sent again until it is answered or gives up; the `nonce`
//     makes a repeat that crossed an answer open nothing twice.
//
// An id is checked against the entry-id shape at both doors; main checks it
// again before it is ever part of an address.

import { ENTRY_ID_RE } from "../gallery/entry-format.js";

/** The query parameter the gallery links with. */
export const GALLERY_PARAM = "gallery";
/** The BroadcastChannel a second tab hands an entry over on. */
export const GALLERY_CHANNEL = "chiphippo-gallery";

/** The entry id an address asks for, or null. */
export function galleryIdFrom(search) {
  const id = new URLSearchParams(search ?? "").get(GALLERY_PARAM);
  return id && ENTRY_ID_RE.test(id) ? id : null;
}

/**
 * Open what the address asks for, and listen for what another tab hands
 * over. Returns the teardown.
 * @param {{open: (id: string) => unknown, location?: Location,
 *   history?: History, Channel?: typeof BroadcastChannel}} opts
 */
export function listenForGalleryLinks({
  open,
  location = globalThis.location,
  history = globalThis.history,
  Channel = globalThis.BroadcastChannel,
}) {
  const asked = galleryIdFrom(location?.search);
  if (asked) {
    const url = new URL(location.href);
    url.searchParams.delete(GALLERY_PARAM);
    history?.replaceState?.(history.state, "", url.href);
    void open(asked);
  }
  if (typeof Channel !== "function") return () => {};
  const channel = new Channel(GALLERY_CHANNEL);
  const seen = new Set();
  channel.onmessage = (e) => {
    const id = e?.data?.open;
    if (typeof id !== "string" || !ENTRY_ID_RE.test(id)) return;
    const nonce = typeof e.data.nonce === "string" ? e.data.nonce : null;
    if (nonce) channel.postMessage({ received: nonce });
    if (nonce && seen.has(nonce)) return; // a repeat: answered, not reopened
    if (nonce) seen.add(nonce);
    globalThis.focus?.();
    void open(id);
  };
  // Node's BroadcastChannel holds its process open while it listens, so a
  // test that boots the web app would never exit; a browser has no unref.
  channel.unref?.();
  return () => channel.close();
}

/**
 * The second tab's half: hand `id` to the tab that holds the app, sending it
 * every `everyMs` until that tab answers (true) or `timeoutMs` has passed
 * (false — no tab took it, and the caller must not say one did).
 * @param {string} id
 * @param {{Channel?: typeof BroadcastChannel, timeoutMs?: number,
 *   everyMs?: number, nonce?: string}} [opts]
 * @returns {Promise<boolean>}
 */
export function handOffGalleryLink(
  id,
  {
    Channel = globalThis.BroadcastChannel,
    timeoutMs = 5000,
    everyMs = 400,
    nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  } = {},
) {
  if (typeof Channel !== "function" || !ENTRY_ID_RE.test(String(id))) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const channel = new Channel(GALLERY_CHANNEL);
    let timer = null;
    let deadline = null;
    const done = (answered) => {
      clearInterval(timer);
      clearTimeout(deadline);
      channel.onmessage = null;
      channel.close();
      resolve(answered);
    };
    channel.onmessage = (e) => {
      if (e?.data?.received === nonce) done(true);
    };
    const send = () => channel.postMessage({ open: id, nonce });
    send();
    timer = setInterval(send, everyMs);
    deadline = setTimeout(() => done(false), timeoutMs);
  });
}
