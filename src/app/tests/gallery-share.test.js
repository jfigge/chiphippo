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

// Share to Gallery's one request (app/gallery/share.js) against a stub
// service, and where it may go (sources.js `shareUrl`).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { shareDesign } = require("../gallery/share");
const { SHARE_URL, shareUrl } = require("../gallery/sources");

const SHARE = {
  design: '{"kind":"desktop","doc":{}}',
  entry: { title: "Gates", author: "Ada", description: "", tags: [] },
  appVersion: "1.6.0",
};

const reply = (status, body) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); // prettier-ignore

test("a share posts the design, the fields and the version — nothing else", async () => {
  let seen = null;
  const fetch = async (url, init) => {
    seen = { url, init };
    return reply(200, { ok: true, id: "gates-abcdef" });
  };
  assert.deepEqual(await shareDesign(SHARE, { fetch }), { id: "gates-abcdef" });
  assert.equal(seen.url, SHARE_URL);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.credentials, "omit");
  assert.deepEqual(Object.keys(JSON.parse(seen.init.body)).sort(), ["appVersion", "design", "entry"]); // prettier-ignore
});

test("the service's own code wins; a status says the rest", async () => {
  const codeOf = async (res) => {
    try {
      await shareDesign(SHARE, { fetch: async () => res });
    } catch (err) {
      return err.code;
    }
    return "resolved";
  };
  assert.equal(await codeOf(reply(429, { ok: false, code: "rateLimited" })), "rateLimited"); // prettier-ignore
  assert.equal(await codeOf(reply(503, { ok: false, code: "unavailable" })), "unavailable"); // prettier-ignore
  assert.equal(await codeOf(reply(409, "not json")), "duplicate");
  assert.equal(await codeOf(reply(503, "")), "busy");
  assert.equal(await codeOf(reply(500, { ok: false, code: "made-up" })), "unavailable"); // prettier-ignore
  // An ok status without an id is no share.
  assert.equal(await codeOf(reply(200, { ok: true })), "unavailable");
});

test("the network failing, or taking too long, is unavailable", async () => {
  await assert.rejects(
    shareDesign(SHARE, { fetch: async () => { throw new TypeError("offline"); } }), // prettier-ignore
    { code: "unavailable" },
  );
  const hang = (_url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); // prettier-ignore
  await assert.rejects(shareDesign(SHARE, { fetch: hang, timeoutMs: 10 }), { code: "unavailable" }); // prettier-ignore
});

test("a dev launch may send to a loopback stand-in, and nowhere else", () => {
  assert.equal(shareUrl(), SHARE_URL);
  assert.equal(shareUrl({ devUrl: "http://127.0.0.1:8787/v1/share" }), "http://127.0.0.1:8787/v1/share"); // prettier-ignore
  assert.equal(shareUrl({ devUrl: "https://evil.example/v1/share" }), SHARE_URL); // prettier-ignore
});
