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

const FIELDS = ["input", "output", "cacheWrite", "cacheRead"];

/** Thousands separators, without dragging in locale-dependent formatting. */
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

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
  const parts = [];
  const add = (key, label) => {
    if (at(usage, key) > 0) parts.push(`${group(usage[key])} ${label}`);
  };
  add("input", "in");
  add("cacheRead", "cache read");
  add("cacheWrite", "cache write");
  add("output", "out");
  if (!parts.length) return "";
  if (calls > 1) parts.push(`${calls} calls`);
  return `Tokens: ${parts.join(" · ")}`;
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
  if (inputs) parts.push(`${group(inputs)} in`);
  if (output) parts.push(`${group(output)} out`);

  const detail = [];
  const add = (key, label) => {
    if (at(usage, key) > 0) detail.push(`${group(usage[key])} ${label}`);
  };
  add("input", "uncached input");
  add("cacheRead", "cache read");
  add("cacheWrite", "cache write");
  add("output", "output");

  return {
    text: `Session: ${parts.join(" · ")}`,
    title:
      `Session total across ${sends} ${sends === 1 ? "send" : "sends"} — ` +
      `${detail.join(" · ")}. Clear resets it.`,
  };
}
