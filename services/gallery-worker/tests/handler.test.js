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

// The submission service's rules, request by request — with a fake GitHub
// and an in-memory rate store, so nothing leaves the machine.

import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_NOTE,
  MAX_OPEN,
  RATE_LIMIT,
  addressBlock,
  SHARE_PATH,
  STATUS_PATH,
  handleRequest,
  inert,
  pullBody,
  reviewerNote,
  statusKey,
} from "../src/handler.js";
import { hasRefusedWord, wordingProblem } from "../src/wording.js";
import { makeGitHub } from "../src/github.js";
import { ENTRY_ID_RE, MAX_SNAPSHOT_BYTES } from "../../../src/web/scripts/gallery/entry-format.js"; // prettier-ignore

const DESIGN = JSON.stringify({ version: 5, kind: "desktop", name: "Blinker", doc: { version: 15, boards: [], components: [{ id: "c1" }], wires: [] } }); // prettier-ignore
const ENTRY = { title: "Blinker", author: "Ada", description: "A 555 blinking an LED.", tags: ["555", "led"] }; // prettier-ignore

function fakeGitHub({ open = 0, branches = [], fail = null, pulls = {} } = {}) {
  const made = [];
  const asked = [];
  return {
    made,
    asked,
    pullStatus: async (number) => {
      asked.push(number);
      if (fail) throw fail;
      return pulls[number] ?? null;
    },
    openPullCount: async () => open,
    alreadyShared: async ({ branch }) => {
      if (fail) throw fail;
      return branches.includes(branch);
    },
    openShare: async (share) => {
      if (fail) throw fail;
      made.push(share);
      return { number: made.length };
    },
  };
}

/** Cloudflare's rate-limiting binding: `limit` starts a minute, per key. */
function fakeLimiter(limit = Infinity) {
  const seen = new Map();
  return {
    seen,
    limit: async ({ key }) => {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}
const openLimits = () => ({ address: fakeLimiter(), all: fakeLimiter() });

function fakeRate() {
  const store = new Map();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v, opts) => store.set(k, v) && opts,
  };
}

const post = (
  body,
  {
    ip = "203.0.113.7",
    path = SHARE_PATH,
    method = "POST",
    origin = null,
  } = {},
) =>
  new Request(`https://share.example${path}`, {
    method,
    headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(origin ? { origin } : {}) }, // prettier-ignore
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined, // prettier-ignore
  });

async function share(body, deps = {}, opts) {
  const github = deps.github ?? fakeGitHub();
  const rate = deps.rate ?? fakeRate();
  const limits = deps.limits ?? openLimits();
  const res = await handleRequest(post(body, opts), { github, rate, limits, salt: "pepper", today: () => "2026-11-02" }); // prettier-ignore
  return { status: res.status, body: await res.json(), github, rate };
}

test("a good share opens one pull request with the entry's two files", async () => {
  const { status, body, github } = await share({ entry: ENTRY, design: DESIGN, appVersion: "1.6.0" }); // prettier-ignore
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.match(body.id, ENTRY_ID_RE);
  assert.match(body.id, /^blinker-[0-9a-f]{6}$/);
  const [made] = github.made;
  assert.equal(made.branch, `share/${body.id}`);
  assert.deepEqual(Object.keys(made.files).sort(), [
    `entries/${body.id}/design.desktop.chiphippo`,
    `entries/${body.id}/entry.json`,
  ]);
  assert.equal(made.files[`entries/${body.id}/design.desktop.chiphippo`], DESIGN); // prettier-ignore
  const entry = JSON.parse(made.files[`entries/${body.id}/entry.json`]);
  assert.deepEqual(entry, { schema: 1, id: body.id, kind: "design", ...ENTRY, created: "2026-11-02", source: "shared" }); // prettier-ignore
  assert.match(made.body, /Chip Hippo 1\.6\.0/);
  // The answer names the pull request, with the key that asks after it.
  assert.equal(body.number, 1);
  assert.equal(body.key, await statusKey("pepper", body.id, 1));
  assert.match(body.key, /^[0-9a-f]{64}$/);
});

test("the same design with the same title gets the same id", async () => {
  const a = await share({ entry: ENTRY, design: DESIGN });
  const b = await share({ entry: { ...ENTRY, author: "Bob" }, design: DESIGN });
  assert.equal(a.body.id, b.body.id);
  const c = await share({ entry: ENTRY, design: DESIGN }, { github: fakeGitHub({ branches: [`share/${a.body.id}`] }) }); // prettier-ignore
  assert.deepEqual([c.status, c.body.code], [409, "duplicate"]);
});

test("a bad request is refused before GitHub is asked anything", async () => {
  const cases = [
    ["not json", "{", 400, "invalid"],
    ["no entry", { design: DESIGN }, 400, "invalid"],
    ["a null entry", { entry: null, design: DESIGN }, 400, "invalid"],
    ["no title", { entry: { ...ENTRY, title: " " }, design: DESIGN }, 400, "invalid"],
    ["a bad tag", { entry: { ...ENTRY, tags: ["no/slashes"] }, design: DESIGN }, 400, "invalid"],
    ["not a desktop", { entry: ENTRY, design: JSON.stringify({ kind: "project" }) }, 400, "invalid"],
    ["design not text", { entry: ENTRY, design: { kind: "desktop" } }, 400, "invalid"],
    ["too big", { entry: ENTRY, design: `${DESIGN}${" ".repeat(MAX_SNAPSHOT_BYTES)}` }, 413, "tooBig"],
    ["wording", { entry: { ...ENTRY, title: "Sh1t clock" }, design: DESIGN }, 422, "wording"],
  ]; // prettier-ignore
  for (const [what, body, status, code] of cases) {
    const github = fakeGitHub();
    const res = await share(body, { github });
    assert.deepEqual([res.status, res.body.code], [status, code], what);
    assert.equal(github.made.length, 0, what);
  }
});

test("a design near the cap is judged by ITS size, not the escaped body's", async () => {
  // Quotes double when the design travels as a JSON string; a design under
  // the cap must not be refused for that.
  const filler = '"x",'.repeat(Math.floor((MAX_SNAPSHOT_BYTES - 1024) / 4));
  const design = JSON.stringify({ version: 5, kind: "desktop", name: "Big", doc: { version: 15, boards: [], components: [{ id: "c1" }], wires: [], note: [] } }).replace('"note":[]', `"note":[${filler}"x"]`); // prettier-ignore
  assert.ok(new TextEncoder().encode(design).length <= MAX_SNAPSHOT_BYTES);
  assert.ok(JSON.stringify(design).length > MAX_SNAPSHOT_BYTES * 1.4, "the body is well past the cap"); // prettier-ignore
  const res = await share({ entry: ENTRY, design });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const over = await share({ entry: ENTRY, design: design.replace('"Big"', `"${"B".repeat(2048)}"`) }); // prettier-ignore
  assert.deepEqual([over.status, over.body.code], [413, "tooBig"]);
});

test("only POST to the one path", async () => {
  assert.equal((await share({}, {}, { path: "/v1/other" })).status, 404);
  assert.equal((await share(null, {}, { method: "GET" })).status, 405);
});

test("one address may share RATE_LIMIT times, kept only as a salted hash", async () => {
  const rate = fakeRate();
  for (let i = 0; i < RATE_LIMIT; i++) {
    const res = await share({ entry: { ...ENTRY, title: `Blinker ${i}` }, design: DESIGN }, { rate }); // prettier-ignore
    assert.equal(res.status, 200);
  }
  const over = await share({ entry: { ...ENTRY, title: "One more" }, design: DESIGN }, { rate }); // prettier-ignore
  assert.deepEqual([over.status, over.body.code], [429, "rateLimited"]);
  const other = await share({ entry: { ...ENTRY, title: "Elsewhere" }, design: DESIGN }, { rate }, { ip: "198.51.100.2" }); // prettier-ignore
  assert.equal(other.status, 200);
  for (const key of rate.store.keys()) {
    assert.match(key, /^share:[0-9a-f]{64}$/);
    assert.ok(!key.includes("203.0.113.7"));
  }
});

test("a full review queue and a GitHub failure are said as such", async () => {
  const busy = await share({ entry: ENTRY, design: DESIGN }, { github: fakeGitHub({ open: MAX_OPEN }) }); // prettier-ignore
  assert.deepEqual([busy.status, busy.body.code], [503, "busy"]);
  const down = await share({ entry: ENTRY, design: DESIGN }, { github: fakeGitHub({ fail: new Error("boom") }) }); // prettier-ignore
  assert.deepEqual([down.status, down.body.code], [502, "unavailable"]);
  const raced = await share({ entry: ENTRY, design: DESIGN }, { github: fakeGitHub({ fail: Object.assign(new Error("x"), { code: "exists" }) }) }); // prettier-ignore
  assert.deepEqual([raced.status, raced.body.code], [409, "duplicate"]);
  // Each of them reached GitHub, so each counts against its address.
  assert.equal(busy.rate.store.size, 1);
  assert.equal(down.rate.store.size, 1);
});

test("an attempt counts before GitHub is asked: refused duplicates can't be repeated for nothing", async () => {
  const rate = fakeRate();
  const github = fakeGitHub({ branches: ["share/blinker-000000"] });
  github.alreadyShared = async () => true; // every one a duplicate
  for (let i = 0; i < RATE_LIMIT; i++) {
    const res = await share({ entry: ENTRY, design: DESIGN }, { rate, github });
    assert.deepEqual([res.status, res.body.code], [409, "duplicate"]);
  }
  const over = await share({ entry: ENTRY, design: DESIGN }, { rate, github });
  assert.deepEqual([over.status, over.body.code], [429, "rateLimited"]);
});

test("a volley sent at once is cut off by the binding, which the KV counter alone can't do", async () => {
  const rate = fakeRate();
  const limits = { address: fakeLimiter(3), all: fakeLimiter() };
  const github = fakeGitHub();
  const answers = await Promise.all(
    [...Array(8).keys()].map((i) => share({ entry: { ...ENTRY, title: `Volley ${i}` }, design: DESIGN }, { rate, limits, github })), // prettier-ignore
  );
  const codes = answers.map((a) => a.body.code ?? "ok");
  assert.equal(codes.filter((c) => c === "ok").length, 3, codes.join());
  assert.equal(codes.filter((c) => c === "rateLimited").length, 5);
  assert.equal(github.made.length, 3);
  // The binding is keyed by the same salted hash as the counter, never the address.
  for (const key of limits.address.seen.keys()) assert.match(key, /^share:[0-9a-f]{64}$/); // prettier-ignore
});

test("the whole service's limit answers busy, whatever the address", async () => {
  const limits = { address: fakeLimiter(), all: fakeLimiter(2) };
  const ips = ["203.0.113.1", "203.0.113.2", "203.0.113.3"];
  const res = [];
  for (const ip of ips) res.push(await share({ entry: { ...ENTRY, title: ip }, design: DESIGN }, { limits }, { ip })); // prettier-ignore
  assert.deepEqual(res.map((r) => r.status), [200, 200, 503]); // prettier-ignore
  assert.equal(res[2].body.code, "busy");
});

test("an IPv6 address is limited by its /64; an IPv4-mapped one by its IPv4", () => {
  assert.equal(addressBlock("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(addressBlock("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64"); // prettier-ignore
  assert.equal(addressBlock("2001:db8::7"), "2001:db8:0:0::/64");
  assert.equal(addressBlock("::1"), "0:0:0:0::/64");
  assert.equal(addressBlock("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(addressBlock("203.0.113.7"), "203.0.113.7");
  assert.equal(addressBlock(null), "");
});

test("stepping through one IPv6 /64 is still one sharer", async () => {
  const rate = fakeRate();
  for (let i = 0; i < RATE_LIMIT; i++) {
    const res = await share({ entry: { ...ENTRY, title: `Six ${i}` }, design: DESIGN }, { rate }, { ip: `2001:db8:1:2::${i + 1}` }); // prettier-ignore
    assert.equal(res.status, 200);
  }
  const over = await share({ entry: { ...ENTRY, title: "Six more" }, design: DESIGN }, { rate }, { ip: "2001:db8:1:2:ffff::9" }); // prettier-ignore
  assert.deepEqual([over.status, over.body.code], [429, "rateLimited"]);
});

test("what a sharer wrote pings nobody and links nothing in the pull request", () => {
  assert.equal(inert("@octocat #12 [x](https://e.vil)"), "\\@octocat \\#12 \\[x\\]\\(https\\://e\\.vil\\)"); // prettier-ignore
  const body = pullBody({ ...ENTRY, author: "@jfigge", description: "line one\n# heading" }, "1.6.0"); // prettier-ignore
  assert.ok(!/(^|[^\\])@jfigge/.test(body));
  assert.match(body, /^> \\# heading$/m);
  // A setext underline is a heading too.
  assert.match(pullBody({ ...ENTRY, description: "foo\n===" }, "1.6.0"), /^> \\=\\=\\=$/m); // prettier-ignore
});

test("the word check: whole words, with the usual swaps, and no Scunthorpe", () => {
  for (const bad of ["shit", "Sh1t", "FUCKING", "a dick move", "b1tches"]) assert.ok(hasRefusedWord(bad), bad); // prettier-ignore
  for (const ok of ["Dickens counter", "cockpit lights", "Scunthorpe", "grape 555", "74LS00"]) assert.ok(!hasRefusedWord(ok), ok); // prettier-ignore
  assert.equal(wordingProblem({ ...ENTRY, tags: ["led", "shit"] }), "tags");
  assert.equal(wordingProblem(ENTRY), null);
});

test("GitHub: one commit on a new branch off main, then the pull request", async () => {
  const calls = [];
  const reply = (status, data) =>
    new Response(JSON.stringify(data), { status });
  const fetch = async (url, init) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    calls.push(`${init.method} ${path}`);
    assert.equal(init.headers.authorization, "Bearer tok");
    if (path === "/git/ref/heads/main") return reply(200, { object: { sha: "head" } }); // prettier-ignore
    if (path === "/git/commits/head") return reply(200, { tree: { sha: "basetree" } }); // prettier-ignore
    if (path === "/git/trees") {
      const body = JSON.parse(init.body);
      assert.equal(body.base_tree, "basetree");
      assert.deepEqual(
        body.tree.map((e) => e.path),
        ["a.json"],
      );
      return reply(201, { sha: "tree" });
    }
    if (path === "/git/commits") return reply(201, { sha: "commit" });
    if (path === "/git/refs") return reply(201, {});
    if (path === "/pulls") return reply(201, { number: 7 });
    return reply(404, {});
  };
  const gh = makeGitHub({ token: "tok", repo: "o/r", fetch });
  const out = await gh.openShare({ branch: "share/x-abcdef", files: { "a.json": "{}" }, message: "m", title: "t", body: "b" }); // prettier-ignore
  assert.deepEqual(out, { number: 7 });
  assert.deepEqual(calls, [
    "GET /git/ref/heads/main",
    "GET /git/commits/head",
    "POST /git/trees",
    "POST /git/commits",
    "POST /git/refs",
    "POST /pulls",
  ]);
});

test("GitHub: a pull request that can't be opened takes its branch with it", async () => {
  const calls = [];
  const reply = (status, data) => new Response(JSON.stringify(data), { status }); // prettier-ignore
  const fetch = async (url, init) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    calls.push(`${init.method} ${path}`);
    if (path === "/git/ref/heads/main") return reply(200, { object: { sha: "head" } }); // prettier-ignore
    if (path === "/git/commits/head") return reply(200, { tree: { sha: "t" } });
    if (path === "/git/trees" || path === "/git/commits") return reply(201, { sha: "s" }); // prettier-ignore
    if (path === "/git/refs") return reply(201, {});
    if (path === "/pulls") return reply(422, { message: "No commits between main and share/x-abcdef" }); // prettier-ignore
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    return reply(404, {});
  };
  const gh = makeGitHub({ token: "tok", repo: "o/r", fetch });
  await assert.rejects(gh.openShare({ branch: "share/x-abcdef", files: { "a.json": "{}" }, message: "m", title: "t", body: "b" })); // prettier-ignore
  assert.equal(calls.at(-1), "DELETE /git/refs/heads/share/x-abcdef");
});

test("GitHub: already shared means an OPEN pull request or an entry on main; a leftover branch is cleared", async () => {
  const NOW = Date.parse("2026-11-09T12:00:00Z");
  const run = async ({
    branch = false,
    open = [],
    onMain = false,
    age = 3600e3,
  }) => {
    const calls = [];
    const reply = (status, data) => new Response(JSON.stringify(data), { status }); // prettier-ignore
    const fetch = async (url, init) => {
      const path = url.replace("https://api.github.com/repos/o/r", "");
      calls.push(`${init.method} ${path}`);
      if (path === "/git/ref/heads/share/x-abcdef") return branch ? reply(200, { object: { sha: "b" } }) : reply(404, {}); // prettier-ignore
      if (path === "/git/commits/b") return reply(200, { committer: { date: new Date(NOW - age).toISOString() } }); // prettier-ignore
      if (path.startsWith("/pulls?")) {
        assert.match(path, /head=o%3Ashare%2Fx-abcdef/);
        return reply(200, open);
      }
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (path === "/contents/entries/x-abcdef/entry.json?ref=main") return onMain ? reply(200, {}) : reply(404, {}); // prettier-ignore
      return reply(500, {});
    };
    const gh = makeGitHub({ token: "tok", repo: "o/r", fetch, now: () => NOW });
    const shared = await gh.alreadyShared({ branch: "share/x-abcdef", entryPath: "entries/x-abcdef/entry.json" }); // prettier-ignore
    return { shared, calls };
  };
  assert.equal((await run({})).shared, false, "a new design");
  assert.equal((await run({ branch: true, open: [{ number: 4 }] })).shared, true, "waiting for review"); // prettier-ignore
  assert.equal((await run({ onMain: true })).shared, true, "accepted");
  const leftover = await run({ branch: true, open: [] });
  assert.equal(
    leftover.shared,
    false,
    "a branch with no pull request is no share",
  );
  assert.ok(leftover.calls.includes("DELETE /git/refs/heads/share/x-abcdef"), "and is cleared"); // prettier-ignore
  // A YOUNG branch with no pull request yet is a share of the same design
  // under way: shared, and never deleted from under it.
  const racing = await run({ branch: true, open: [], age: 5000 });
  assert.equal(racing.shared, true);
  assert.ok(!racing.calls.some((c) => c.startsWith("DELETE")), "left alone");
});

// ── What became of a share (POST /v1/status) ───────────────────────────────

const ID = "blinker-abcdef";
const pull = (over = {}) => ({ open: true, merged: false, head: `share/${ID}`, comments: [], ...over }); // prettier-ignore

function fakeCache() {
  const store = new Map();
  return { store, get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) }; // prettier-ignore
}

async function status(
  body,
  { github = fakeGitHub(), cache = null, owner = "jfigge" } = {},
) {
  const res = await handleRequest(post(body, { path: STATUS_PATH }), { github, rate: fakeRate(), salt: "pepper", owner, cache }); // prettier-ignore
  return { status: res.status, body: await res.json(), github };
}

test("a share's status: waiting, accepted or declined, by its pull request", async () => {
  const key = await statusKey("pepper", ID, 3);
  const cases = [
    [pull(), "waiting"],
    [pull({ open: false, merged: true }), "accepted"],
    [pull({ open: false }), "declined"],
  ];
  for (const [state, want] of cases) {
    const res = await status({ id: ID, number: 3, key }, { github: fakeGitHub({ pulls: { 3: state } }) }); // prettier-ignore
    assert.deepEqual([res.status, res.body], [200, { ok: true, status: want, note: "" }], want); // prettier-ignore
  }
});

test("only the share's own key asks, and only after its own pull request", async () => {
  const key = await statusKey("pepper", ID, 3);
  const github = fakeGitHub({ pulls: { 3: pull(), 4: pull({ head: "share/other-123456" }) } }); // prettier-ignore
  const wrong = await status({ id: ID, number: 3, key: key.replace(/^./, (c) => (c === "0" ? "1" : "0")) }, { github }); // prettier-ignore
  assert.deepEqual([wrong.status, wrong.body.code], [403, "forbidden"]);
  // A key for another pull request doesn't fit this one.
  const moved = await status({ id: ID, number: 4, key }, { github });
  assert.deepEqual([moved.status, moved.body.code], [403, "forbidden"]);
  assert.deepEqual(github.asked, [], "GitHub is asked nothing without the key");
  // A real key whose pull request carries another branch is not this share.
  const other = await status({ id: ID, number: 4, key: await statusKey("pepper", ID, 4) }, { github }); // prettier-ignore
  assert.deepEqual([other.status, other.body.code], [404, "notFound"]);
  const gone = await status({ id: ID, number: 9, key: await statusKey("pepper", ID, 9) }, { github }); // prettier-ignore
  assert.deepEqual([gone.status, gone.body.code], [404, "notFound"]);
  for (const bad of [
    "{",
    { id: "Nope", number: 3, key },
    { id: ID, number: 0, key },
    { id: ID, number: "3", key },
  ]) {
    // prettier-ignore
    assert.equal((await status(bad, { github })).status, 400, JSON.stringify(bad));
  }
});

test("the reviewer's note is the reviewer's latest comment, never the check's", async () => {
  const comments = [
    { author: "github-actions[bot]", body: "✅ Ready to publish" },
    { author: "jfigge", body: "Nice — but the LED needs a resistor." },
    { author: "someone", body: "+1" },
    { author: "JFigge", body: "  Thanks, closing for now.  " },
  ];
  assert.equal(reviewerNote(comments, "jfigge"), "Thanks, closing for now.");
  assert.equal(reviewerNote(comments.slice(0, 1), "jfigge"), "");
  assert.equal(reviewerNote([{ author: "jfigge", body: "x".repeat(MAX_NOTE + 5) }], "jfigge").length, MAX_NOTE); // prettier-ignore
  assert.equal(reviewerNote(comments, ""), "");
  const key = await statusKey("pepper", ID, 3);
  const res = await status({ id: ID, number: 3, key }, { github: fakeGitHub({ pulls: { 3: pull({ open: false, comments }) } }) }); // prettier-ignore
  assert.deepEqual(res.body, { ok: true, status: "declined", note: "Thanks, closing for now." }); // prettier-ignore
});

test("a status answer is reused, and a GitHub failure is said as such", async () => {
  const key = await statusKey("pepper", ID, 3);
  const cache = fakeCache();
  const github = fakeGitHub({ pulls: { 3: pull() } });
  await status({ id: ID, number: 3, key }, { github, cache });
  const again = await status({ id: ID, number: 3, key }, { github, cache });
  assert.equal(again.body.status, "waiting");
  assert.deepEqual(github.asked, [3], "the second answer came from the cache");
  const down = await status({ id: ID, number: 3, key }, { github: fakeGitHub({ fail: new Error("boom") }) }); // prettier-ignore
  assert.deepEqual([down.status, down.body.code], [502, "unavailable"]);
});

test("the web build's site may call it; another page gets no CORS headers", async () => {
  const deps = { github: fakeGitHub(), rate: fakeRate(), limits: openLimits(), salt: "pepper" }; // prettier-ignore
  const pre = await handleRequest(post(null, { method: "OPTIONS", origin: "https://chiphippo.com" }), deps); // prettier-ignore
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://chiphippo.com"); // prettier-ignore
  assert.match(pre.headers.get("access-control-allow-headers"), /content-type/);
  const ok = await handleRequest(post({ entry: ENTRY, design: DESIGN }, { origin: "https://chiphippo.com" }), deps); // prettier-ignore
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://chiphippo.com"); // prettier-ignore
  const elsewhere = await handleRequest(post({ entry: ENTRY, design: DESIGN }, { origin: "https://e.vil" }), deps); // prettier-ignore
  assert.equal(elsewhere.headers.get("access-control-allow-origin"), null);
  // The desktop app's requests come from main, with no origin at all.
  const app = await handleRequest(post({ entry: { ...ENTRY, title: "Other" }, design: DESIGN }), deps); // prettier-ignore
  assert.equal(app.status, 200);
  assert.equal(app.headers.get("access-control-allow-origin"), null);
});

test("GitHub: a pull request's state and its comments", async () => {
  const calls = [];
  const reply = (status, data) => new Response(JSON.stringify(data), { status }); // prettier-ignore
  const fetch = async (url, init) => {
    const path = url.replace("https://api.github.com/repos/o/r", "");
    calls.push(`${init.method} ${path}`);
    if (path === "/pulls/7") return reply(200, { state: "closed", merged_at: null, head: { ref: "share/x-abcdef" } }); // prettier-ignore
    if (path === "/issues/7/comments?per_page=100") return reply(200, [{ user: { login: "o" }, body: "No" }]); // prettier-ignore
    return reply(404, {});
  };
  const gh = makeGitHub({ token: "tok", repo: "o/r", fetch });
  assert.deepEqual(await gh.pullStatus(7), { open: false, merged: false, head: "share/x-abcdef", comments: [{ author: "o", body: "No" }] }); // prettier-ignore
  assert.equal(await gh.pullStatus(8), null);
  assert.deepEqual(calls, ["GET /pulls/7", "GET /issues/7/comments?per_page=100", "GET /pulls/8"]); // prettier-ignore
});
