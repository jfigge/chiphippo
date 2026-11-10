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

// Main's gallery decisions (gallery/gate.js): the access gate every read
// passes, Share to Gallery before a byte leaves, the MRU-only test, and the
// queue that holds what the OS hands over until a page is listening.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createOpenQueue,
  galleryAllowed,
  galleryAnswer,
  onRecentList,
  prepareShare,
} = require("../gallery/gate");
const {
  MAX_ROM_BYTES,
  MAX_SNAPSHOT_BYTES,
} = require("../../web/scripts/gallery/entry-format.js");

const ENTRY = { title: "Blinker", author: "Ada", description: "A 555.", tags: ["555"] }; // prettier-ignore
const DOC = { version: 15, boards: [], components: [{ id: "c1" }], wires: [] };
/** ProjectStore.buildDesktopSnapshot's shape, ROMs as v5 blobs. */
const build = (images = null) => {
  const seen = [];
  const fn = (s) => {
    seen.push(s);
    return { version: 5, kind: "desktop", name: s.name, ...(s.description ? { description: s.description } : {}), doc: s.doc, ...(images ?? {}) }; // prettier-ignore
  };
  return Object.assign(fn, { seen });
};

// ── The gate ──

test("the desktop app reads the gallery only on a stored yes; the web build always", () => {
  for (const [facts, want] of [
    [{ distribution: "direct", galleryAccess: "yes" }, true],
    [{ distribution: "direct", galleryAccess: "no" }, false],
    [{ distribution: "direct", galleryAccess: undefined }, false],
    [{ distribution: "mas", galleryAccess: "YES" }, false],
    [{ distribution: "web", galleryAccess: "no" }, true],
  ]) {
    assert.equal(galleryAllowed(facts), want, JSON.stringify(facts));
  }
});

test("a refused read never runs; a failure answers its code", async () => {
  let ran = false;
  assert.deepEqual(
    await galleryAnswer(false, null, async () => ((ran = true), {})),
    { ok: false, code: "refused" },
  );
  assert.equal(ran, false, "nothing is fetched without access");
  assert.deepEqual(await galleryAnswer(true, { web: true }, async (w) => ({ index: w })), { ok: true, index: { web: true } }); // prettier-ignore
  const coded = Object.assign(new Error("x"), { code: "tooBig" });
  assert.deepEqual(await galleryAnswer(true, {}, async () => { throw coded; }), { ok: false, code: "tooBig" }); // prettier-ignore
  assert.deepEqual(await galleryAnswer(true, {}, async () => { throw new Error("boom"); }), { ok: false, code: "unavailable" }); // prettier-ignore
});

// ── Share to Gallery ──

test("consent No refuses before anything is built", () => {
  const fn = build();
  assert.deepEqual(prepareShare({ doc: DOC, entry: ENTRY }, { consent: "no", buildSnapshot: fn }), { ok: false, code: "refused" }); // prettier-ignore
  assert.equal(fn.seen.length, 0);
  for (const consent of ["ask", "yes", undefined]) {
    assert.equal(prepareShare({ doc: DOC, entry: ENTRY }, { consent, buildSnapshot: build() }).ok, true, String(consent)); // prettier-ignore
  }
});

test("the fields are checked, and junk is invalid, not a throw", () => {
  for (const payload of [
    null,
    {},
    { doc: DOC },
    { doc: DOC, entry: { ...ENTRY, title: "" } },
    { doc: DOC, entry: null },
  ]) {
    assert.deepEqual(prepareShare(payload, { consent: "ask", buildSnapshot: build() }), { ok: false, code: "invalid" }); // prettier-ignore
  }
  const throws = () => {
    throw new Error("a desktop needs a document");
  };
  assert.deepEqual(prepareShare({ entry: ENTRY }, { consent: "ask", buildSnapshot: throws }), { ok: false, code: "invalid" }); // prettier-ignore
});

test("the snapshot is named for the entry, never the sharer's tab", () => {
  const fn = build();
  const out = prepareShare({ name: "Desktop 1", description: "my notes", doc: DOC, entry: ENTRY }, { consent: "ask", buildSnapshot: fn }); // prettier-ignore
  assert.equal(out.ok, true);
  assert.deepEqual(fn.seen[0], { name: "Blinker", description: "A 555.", doc: DOC, customChips: undefined }); // prettier-ignore
  const sent = JSON.parse(out.design);
  assert.equal(sent.name, "Blinker");
  assert.ok(
    !out.design.includes("my notes"),
    "the tab's own text never leaves",
  );
  assert.deepEqual(out.entry, { title: "Blinker", author: "Ada", description: "A 555.", tags: ["555"] }); // prettier-ignore
});

test("the snapshot's cap and the ROM cap are main's to hold", () => {
  const huge = { ...DOC, note: "x".repeat(MAX_SNAPSHOT_BYTES) };
  assert.deepEqual(prepareShare({ doc: huge, entry: ENTRY }, { consent: "ask", buildSnapshot: build() }), { ok: false, code: "tooBig" }); // prettier-ignore
  // ROM bytes over their cap in a snapshot still under its own: only main,
  // which holds the bytes, can see this.
  const rom = "AAAA".repeat(Math.ceil((MAX_ROM_BYTES + 1) / 3));
  assert.ok(rom.length < MAX_SNAPSHOT_BYTES);
  const images = {
    images: { g1: { blob: "sha256-x" } },
    blobs: { "sha256-x": rom },
  };
  assert.deepEqual(prepareShare({ doc: DOC, entry: ENTRY }, { consent: "ask", buildSnapshot: build(images) }), { ok: false, code: "romTooBig" }); // prettier-ignore
  const small = {
    images: { g1: { blob: "sha256-y" } },
    blobs: { "sha256-y": "AAEC" },
  };
  assert.equal(prepareShare({ doc: DOC, entry: ENTRY }, { consent: "ask", buildSnapshot: build(small) }).ok, true); // prettier-ignore
});

// ── The MRU-only test ──

test("only a path on the recent list", () => {
  const recent = ["/home/a.chiphippo", "/home/b.chiphippo"];
  assert.equal(onRecentList("/home/a.chiphippo", recent), true);
  for (const p of ["/home/c.chiphippo", "", null, 7, ["/home/a.chiphippo"]]) {
    assert.equal(onRecentList(p, recent), false, String(p));
  }
  assert.equal(onRecentList("/home/a.chiphippo", null), false);
});

// ── What the OS hands over ──

function queue({ window = true, max } = {}) {
  const delivered = [];
  const shown = [];
  const state = { window };
  const q = createOpenQueue({
    deliver: (r) => delivered.push(r.id),
    showWindow: () => shown.push(true),
    hasWindow: () => state.window,
    ...(max ? { max } : {}),
  });
  return { q, delivered, shown, state };
}

test("held until the page is listening, then delivered in order", () => {
  const { q, delivered, shown } = queue();
  q.handOver({ id: 1 });
  q.handOver({ id: 2 });
  assert.deepEqual(delivered, []);
  assert.deepEqual(shown, [], "a starting app shows its window itself");
  q.flush();
  assert.deepEqual(delivered, [1, 2]);
  assert.equal(q.pending, 0);
  q.handOver({ id: 3 });
  assert.deepEqual(delivered, [1, 2, 3], "a listening page gets it at once");
  assert.equal(shown.length, 1, "and the running app comes forward");
});

test("a page that goes (reload, crash, window closed) makes the next wait", () => {
  const { q, delivered, state } = queue();
  q.flush();
  q.reset(); // the window closed
  state.window = false;
  q.handOver({ id: 1 });
  assert.deepEqual(delivered, [], "never sent to a page still loading");
  assert.equal(q.pending, 1);
  state.window = true;
  q.flush(); // the new window's page is listening
  assert.deepEqual(delivered, [1]);
});

test("a ready queue with no window keeps the request", () => {
  const { q, delivered, state } = queue();
  q.flush();
  state.window = false;
  q.handOver({ id: 1 });
  assert.deepEqual(delivered, []);
  assert.equal(q.pending, 1);
});

test("at most `max` wait", () => {
  const { q, delivered } = queue({ max: 3 });
  for (let id = 0; id < 10; id++) q.handOver({ id });
  assert.equal(q.pending, 3);
  q.flush();
  assert.deepEqual(delivered, [0, 1, 2]);
});
