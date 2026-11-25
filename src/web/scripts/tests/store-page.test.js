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

// The share link's page (website/store/), run in jsdom on the link it is
// opened with: a store the app would take is shown with Open in Chip Hippo;
// one the app would refuse is shown as broken — never as found.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

import { normalizeStoreRef, storeLink } from "../stores/store-format.js";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "../../../../website/store"); // prettier-ignore
const HTML = readFileSync(join(SITE, "index.html"), "utf8");
const SCRIPT = readFileSync(join(SITE, "store.js"), "utf8");
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

function page(hash) {
  const dom = new JSDOM(HTML.replace(/<script[^>]*src="[^"]*store\.js"[^>]*><\/script>/, ""), { url: `https://chiphippo.com/store/#${hash}`, runScripts: "outside-only" }); // prettier-ignore
  dom.window.TextDecoder = TextDecoder;
  dom.window.eval(SCRIPT);
  const $ = (id) => dom.window.document.getElementById(id);
  return { found: !$("store-found").hidden, bad: !$("store-bad").hidden, name: $("store-name").textContent, where: $("store-where").textContent, open: $("store-open").getAttribute("href"), doc: dom.window.document }; // prettier-ignore
}

test("a store link the app would take is shown, folder and all, with the app's own link", () => {
  const ref = { id: "s-0123456789abcdef", name: "Bench club", kind: "github", where: { repo: "ann/site", dir: "designs/chiphippo" } }; // prettier-ignore
  const link = storeLink(ref);
  const p = page(link.split("#")[1]);
  assert.equal(p.found, true);
  assert.equal(p.name, "Bench club");
  assert.match(p.where, /ann\/site\/designs\/chiphippo/);
  assert.equal(p.open, `chiphippo://store/add#${link.split("#")[1]}`);
  const folder = page(storeLink({ id: "s-0123456789abcdef", name: "Lab", kind: "folder", where: { provider: "dropbox" } }).split("#")[1]); // prettier-ignore
  assert.match(folder.where, /Dropbox/);
});

test("a link the app would refuse is shown as broken — and the step naming its button goes", () => {
  const id = "s-0123456789abcdef";
  for (const bad of [
    "short",
    b64({ v: 1, id: "s-xyz", kind: "folder", where: {} }), // not a store id
    b64({ v: 1, id, kind: "dropbox", where: {} }), // no such kind
    b64({ v: 1, id, kind: "github", where: { repo: "not a repo" } }),
    b64({
      v: 1,
      id,
      kind: "github",
      where: { repo: "ann/site", dir: "../up" },
    }),
  ]) {
    const p = page(bad);
    assert.equal(p.found, false, bad);
    assert.equal(p.bad, true, bad);
    assert.ok([...p.doc.querySelectorAll(".store-step-open")].every((li) => li.hidden)); // prettier-ignore
  }
  // A name that is not text is no name.
  const odd = page(b64({ v: 1, id, name: { x: 1 }, kind: "folder", where: { provider: "other" } })); // prettier-ignore
  assert.equal(odd.name, "A private store");
});

test("the page and the app agree on every link: found exactly when the app would take it", () => {
  const id = "s-0123456789abcdef";
  const cases = [
    { v: 1, id, name: "A", kind: "folder", where: { provider: "dropbox" } },
    { v: 1, id, name: "A", kind: "folder", where: {} },
    { v: 1, id, kind: "github", where: { repo: "ann/site" } },
    { v: 1, id, kind: "github", where: { repo: "ann/site", dir: "/designs/" } },
    { v: 1, id, kind: "github", where: { repo: "ann/site", dir: 5 } },
    { v: 1, id, kind: "github", where: { repo: "ann/site", dir: "a/b/c/d/e" } },
    { v: 1, id, kind: "github", where: { repo: "ann/site", dir: "a/../b" } },
    { v: 1, id, kind: "github", where: { repo: "ann/.." } },
    { v: 1, id, kind: "github", where: { repo: "-ann/site" } },
    { v: 1, id: "s-0123", kind: "folder", where: {} },
    { v: 1, id, kind: "other", where: {} },
  ];
  for (const ref of cases) {
    const app = normalizeStoreRef(ref) != null;
    assert.equal(page(b64(ref)).found, app, JSON.stringify(ref));
  }
});

test("the page shows a name as the app holds it: no bidi or control characters", () => {
  const p = page(b64({ v: 1, id: "s-0123456789abcdef", name: "Lab‮evil\u0007", kind: "folder", where: { provider: "other" } })); // prettier-ignore
  assert.equal(p.name, "Lab evil");
});

test("the page takes no longer a link than the app reads (1024 characters, its address included)", async () => {
  const { parseStoreLink } = await import("../stores/store-format.js");
  const id = "s-0123456789abcdef";
  const sized = (len) => {
    for (let n = 1; n < 2000; n += 1) {
      const p = b64({ v: 1, id, name: "x".repeat(n), kind: "folder", where: { provider: "other" } }); // prettier-ignore
      if (p.length >= len) return p;
    }
    return null;
  };
  const fits = sized(990);
  const over = sized(996);
  assert.ok(fits.length <= 995 && over.length > 995);
  for (const p of [fits, over]) {
    const app = parseStoreLink(`https://chiphippo.com/store/#${p}`) != null;
    assert.equal(page(p).found, app, `length ${p.length}`);
  }
  assert.equal(page(over).found, false);
});
