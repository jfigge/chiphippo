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

// usage.js — token arithmetic and its two readouts (Feature 260).
//
// A usage object is `{ input, output, cacheWrite, cacheRead }`, every field
// optional, normalised by `app/ai/providers.js` so nothing here knows which
// provider produced it. `input` means UNCACHED prompt tokens: the whole prompt
// is `input + cacheWrite + cacheRead`.
//
// Two different merges live either side of the process boundary and must not be
// confused. Within one request, `app/ai/client.js` merges LAST-WINS, because a
// provider streams cumulative counts. Across repair rounds and across sends,
// the merge is ADDITIVE — that is `addUsage` below, and it is the only one that
// belongs in the renderer.
//
// Deliberately no dollar figures. A price table in the repo goes stale silently
// and the panel starts lying about money; token counts cannot be wrong, and the
// four buckets map one-to-one onto the console's price rows for anyone who
// wants to do the multiplication.

// `tf`, not `t`: this module is pure and its test imports it with no catalog
// loaded, so every string carries its English along (the build-plan.js rule).
import { formatNumber, tf } from "../i18n.js";

const FIELDS = ["input", "output", "cacheWrite", "cacheRead"];

/** Thousands separators, IN THE READER'S OWN CONVENTION. This used to group by
    hand to avoid "dragging in locale-dependent formatting" — but once the words
    around the number are translated, a hand-grouped `5,200` shown to a German
    reader states five point two. The separator is part of the number's meaning,
    not decoration on it. */
const group = (n) => formatNumber(n);

/** A field's value, or 0 — usage objects carry only the fields they know. */
const at = (usage, key) => (Number.isFinite(usage?.[key]) ? usage[key] : 0);

/**
 * Sum two usage objects field-wise.
 *
 * Null-safe both ways and non-mutating, so it can be folded over a run of
 * rounds without a seed value. Returns null when there is nothing to report,
 * which is what keeps a provider that sends no usage from rendering zeroes.
 *
 * @returns {object|null}
 */
export function addUsage(a, b) {
  if (!a && !b) return null;
  const out = {};
  for (const key of FIELDS) {
    const total = at(a, key) + at(b, key);
    if (total > 0) out[key] = total;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The per-send transcript line.
 *
 * Buckets that are zero or absent are dropped, so a cold send reads
 * `Tokens: 1,203 in · 2,412 out` and only a cached one mentions the cache. The
 * call count appears only when it is above one — that clause is the whole point
 * of the line on a failed generation, where a give-up after two repair rounds
 * is three billed calls.
 *
 * Exact counts rather than `2.4k`: a rounded number cannot be multiplied by a
 * rate, which is the one thing someone reading this would want to do with it.
 *
 * @returns {string} "" when there is nothing to report.
 */
export function formatUsage(usage, calls = 1) {
  // Written out rather than driven from a table: a LITERAL key is one the
  // catalog guard can check (tests/i18n-catalogs.test.js reads literals only),
  // and this module's own test runs with no catalog, so it proves the
  // fallbacks and nothing about the keys.
  const parts = [];
  const n = (key) => ({ n: group(usage[key]) });
  if (at(usage, "input") > 0) parts.push(tf("ai.usage.in", "{n} in", n("input"))); // prettier-ignore
  if (at(usage, "cacheRead") > 0) parts.push(tf("ai.usage.cacheRead", "{n} cache read", n("cacheRead"))); // prettier-ignore
  if (at(usage, "cacheWrite") > 0) parts.push(tf("ai.usage.cacheWrite", "{n} cache write", n("cacheWrite"))); // prettier-ignore
  if (at(usage, "output") > 0) parts.push(tf("ai.usage.out", "{n} out", n("output"))); // prettier-ignore
  if (!parts.length) return "";
  // Only ever pushed above one, so the fallback needs no singular — but the
  // catalog entry is still a plural object, since a language may inflect at a
  // boundary English does not.
  if (calls > 1) {
    parts.push(tf("ai.usage.calls", "{count} calls", { count: calls }));
  }
  return tf("ai.usage.tokens", "Tokens: {parts}", { parts: parts.join(" · ") });
}

/**
 * The header readout and its tooltip.
 *
 * Here `in` is every input bucket summed — the at-a-glance volume, where the
 * per-send line's `in` is one bucket of four. The `Session:` prefix is what
 * disambiguates the two, and hints that something resets it. The split lives in
 * the tooltip rather than the line, which has to survive at 11px next to a
 * status that is already competing for the same corner.
 *
 * @returns {{text:string, title:string}} both "" when there is nothing to show.
 */
export function formatTotal(usage, sends) {
  const inputs =
    at(usage, "input") + at(usage, "cacheRead") + at(usage, "cacheWrite");
  const output = at(usage, "output");
  if (!inputs && !output) return { text: "", title: "" };

  const parts = [];
  if (inputs) parts.push(tf("ai.usage.in", "{n} in", { n: group(inputs) }));
  if (output) parts.push(tf("ai.usage.out", "{n} out", { n: group(output) }));

  const detail = [];
  const n = (key) => ({ n: group(usage[key]) });
  if (at(usage, "input") > 0) detail.push(tf("ai.usage.uncachedInput", "{n} uncached input", n("input"))); // prettier-ignore
  if (at(usage, "cacheRead") > 0) detail.push(tf("ai.usage.cacheRead", "{n} cache read", n("cacheRead"))); // prettier-ignore
  if (at(usage, "cacheWrite") > 0) detail.push(tf("ai.usage.cacheWrite", "{n} cache write", n("cacheWrite"))); // prettier-ignore
  if (at(usage, "output") > 0) detail.push(tf("ai.usage.output", "{n} output", n("output"))); // prettier-ignore

  return {
    text: tf("ai.usage.session", "Session: {parts}", {
      parts: parts.join(" · "),
    }),
    title: tf(
      "ai.usage.sessionTitle",
      "Session total across {sends} — {detail}. Clear resets it.",
      {
        // The count phrase is built first and interpolated whole, so a language
        // that puts it elsewhere in the sentence can.
        sends: tf(
          "ai.usage.sends",
          sends === 1 ? "{count} send" : "{count} sends",
          { count: sends },
        ),
        detail: detail.join(" · "),
      },
    ),
  };
}
