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

// How a gallery design reaches the web build from outside it
// (components/gallery-links.js): the address, once, and a second tab's handoff.
import test from "node:test";
import assert from "node:assert/strict";

import {
  GALLERY_CHANNEL,
  galleryIdFrom,
  listenForGalleryLinks,
} from "../components/gallery-links.js";

test("only an entry-shaped id is read off the address", () => {
  assert.equal(
    galleryIdFrom("?gallery=nand-bench-3fa9c1"),
    "nand-bench-3fa9c1",
  );
  assert.equal(galleryIdFrom("?ref=mail&gallery=a-000000"), "a-000000");
  for (const bad of [
    "",
    "?gallery=",
    "?gallery=../x-000000",
    "?gallery=x",
    null,
  ]) {
    assert.equal(galleryIdFrom(bad), null, String(bad));
  }
});

/** A stand-in BroadcastChannel that records itself. */
function channelClass() {
  const made = [];
  class Channel {
    constructor(name) {
      this.name = name;
      this.closed = false;
      made.push(this);
    }
    close() {
      this.closed = true;
    }
  }
  return { Channel, made };
}

test("the address is opened once and taken off the address", () => {
  const opened = [];
  const replaced = [];
  const location = {
    href: "https://chiphippo.com/desktop/?ref=mail&gallery=a-000000",
    search: "?ref=mail&gallery=a-000000",
  };
  const history = { state: null, replaceState: (_s, _t, url) => replaced.push(url) }; // prettier-ignore
  const { Channel } = channelClass();
  listenForGalleryLinks({ open: (id) => opened.push(id), location, history, Channel }); // prettier-ignore
  assert.deepEqual(opened, ["a-000000"]);
  assert.deepEqual(replaced, ["https://chiphippo.com/desktop/?ref=mail"]);
});

test("a second tab's handoff is opened; junk on the channel is not", () => {
  const opened = [];
  const { Channel, made } = channelClass();
  const stop = listenForGalleryLinks({
    open: (id) => opened.push(id),
    location: { href: "https://x/desktop/", search: "" },
    history: null,
    Channel,
  });
  assert.equal(made[0].name, GALLERY_CHANNEL);
  made[0].onmessage({ data: { open: "b-111111" } });
  made[0].onmessage({ data: { open: "../evil" } });
  made[0].onmessage({ data: "b-111111" });
  assert.deepEqual(opened, ["b-111111"]);
  stop();
  assert.equal(made[0].closed, true);
});

test("no BroadcastChannel: the address still works", () => {
  const opened = [];
  listenForGalleryLinks({
    open: (id) => opened.push(id),
    location: { href: "https://x/desktop/?gallery=c-222222", search: "?gallery=c-222222" }, // prettier-ignore
    history: null,
    Channel: null, // (undefined would take the default: Node's real one)
  });
  assert.deepEqual(opened, ["c-222222"]);
});
