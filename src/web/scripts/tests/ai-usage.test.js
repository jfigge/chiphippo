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

// Token arithmetic and its two readouts. Pure — no DOM, no network.

import test from "node:test";
import assert from "node:assert/strict";

import { applyCatalog } from "../i18n.js";
import { addUsage, formatTotal, formatUsage } from "../ai/usage.js";

// ── addUsage ────────────────────────────────────────────────────────────────

test("nothing plus nothing is nothing, not a row of zeroes", () => {
  assert.equal(addUsage(null, null), null);
  assert.equal(addUsage(null, undefined), null);
  assert.equal(addUsage({}, {}), null);
});

test("a null side is absorbed, so it can be folded without a seed", () => {
  assert.deepEqual(addUsage(null, { input: 5 }), { input: 5 });
  assert.deepEqual(addUsage({ input: 5 }, null), { input: 5 });
});

test("fields sum, and a field only one side knows is not lost to NaN", () => {
  assert.deepEqual(
    addUsage({ input: 20, output: 250 }, { input: 5, cacheRead: 1000 }),
    { input: 25, output: 250, cacheRead: 1000 },
  );
});

test("neither argument is mutated", () => {
  const a = { input: 20 };
  const b = { input: 5 };
  addUsage(a, b);
  assert.deepEqual(a, { input: 20 });
  assert.deepEqual(b, { input: 5 });
});

// ── formatUsage ─────────────────────────────────────────────────────────────

test("empty usage formats to nothing at all", () => {
  for (const u of [null, undefined, {}, { input: 0, output: 0 }]) {
    assert.equal(formatUsage(u), "", JSON.stringify(u));
  }
});

test("zero and absent buckets are dropped", () => {
  // A cold send has no cache to speak of; saying "0 cache read" would be noise.
  assert.equal(
    formatUsage({ input: 1203, output: 2412 }),
    "Tokens: 1,203 in · 2,412 out",
  );
  assert.equal(
    formatUsage({
      input: 1203,
      cacheRead: 11776,
      cacheWrite: 12032,
      output: 2412,
    }),
    "Tokens: 1,203 in · 11,776 cache read · 12,032 cache write · 2,412 out",
  );
});

test("the calls clause appears only when there was more than one", () => {
  const u = { input: 20, output: 250 };
  assert.equal(formatUsage(u, 1), "Tokens: 20 in · 250 out");
  assert.match(formatUsage(u, 3), /· 3 calls$/);
});

test("thousands are grouped at the boundary", () => {
  assert.match(formatUsage({ input: 999 }), /999 in/);
  assert.match(formatUsage({ input: 1000 }), /1,000 in/);
  assert.match(formatUsage({ input: 1000000 }), /1,000,000 in/);
});

// ── formatTotal ─────────────────────────────────────────────────────────────

test("the header sums every input bucket into one figure", () => {
  // 1,203 + 11,776 + 12,032 = 25,011. The per-send line's `in` is one bucket
  // of four; the header's is the lot, which is why it says "Session:".
  const { text } = formatTotal(
    { input: 1203, cacheRead: 11776, cacheWrite: 12032, output: 2412 },
    3,
  );
  assert.equal(text, "Session: 25,011 in · 2,412 out");
});

test("the tooltip keeps the split the header drops", () => {
  const { title } = formatTotal(
    { input: 1203, cacheRead: 11776, output: 2412 },
    3,
  );
  assert.match(title, /across 3 sends/);
  assert.match(
    title,
    /1,203 uncached input · 11,776 cache read · 2,412 output/,
  );
  assert.match(title, /Clear resets it\./);
});

test("one send is a send, not sends", () => {
  assert.match(formatTotal({ input: 5 }, 1).title, /across 1 send —/);
});

test("an empty total renders neither text nor tooltip", () => {
  for (const u of [null, {}, { input: 0 }]) {
    assert.deepEqual(
      formatTotal(u, 0),
      { text: "", title: "" },
      JSON.stringify(u),
    );
  }
});

// ── Both readouts go through the catalog ────────────────────────────────────
// Every assertion above runs with NO catalog loaded, so it proves the English
// FALLBACKS — which is what these lines were before, hardcoded. These prove
// the seam is really there, and that the NUMBER moves with the words: a
// hand-grouped "5,200" shown to a German reader states five point two.

test("every word and every separator follows the active locale", (t) => {
  applyCatalog({
    active: "de", // its thousands separator is "." and its decimal ","
    lang: "de",
    messages: {
      ai: {
        usage: {
          tokens: "[T {parts}]",
          session: "[S {parts}]",
          sessionTitle: "[{sends} — {detail}]",
          sends: { one: "{count} Anfrage", other: "{count} Anfragen" },
          calls: { one: "{count} Aufruf", other: "{count} Aufrufe" },
          in: "{n} rein",
          out: "{n} raus",
          cacheRead: "{n} Cache gelesen",
          uncachedInput: "{n} ungecacht",
          output: "{n} Ausgabe",
        },
      },
    },
  });
  // Module state outlives a test — put the rest of the file back on English.
  t.after(() => applyCatalog({}));

  assert.equal(
    formatUsage({ input: 1203, cacheRead: 11776, output: 2412 }, 3),
    "[T 1.203 rein · 11.776 Cache gelesen · 2.412 raus · 3 Aufrufe]",
  );
  const { text, title } = formatTotal({ input: 1200, cacheRead: 4000, output: 340 }, 1); // prettier-ignore
  assert.equal(text, "[S 5.200 rein · 340 raus]");
  assert.equal(
    title,
    "[1 Anfrage — 1.200 ungecacht · 4.000 Cache gelesen · 340 Ausgabe]",
    "one send picks the singular form, and the count phrase is built whole",
  );
});
