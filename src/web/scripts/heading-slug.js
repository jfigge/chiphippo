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

// heading-slug.js — THE heading id rule for the user guide, in one place.
//
// ONE Markdown source (src/web/docs/*.md) drives THREE outputs: the in-app
// viewer (components/docs-viewer.js), the hosted website and the PDF (both
// through scripts/build-docs.mjs). An author-written `#fragment` link has to
// resolve in all three — and, because the same files are read straight off
// GitHub, there too. So the id a heading gets cannot be a per-renderer
// decision, and this module is deliberately dependency-free (no DOM, no
// imports) so the sandboxed renderer can load it over file:// and a plain
// Node build script can import it by path.
//
// IT WAS TWO COPIES, AND THEY DISAGREED. The website's followed GitHub; the
// viewer's collapsed runs of hyphens on top of it. That is invisible until a
// heading contains punctuation — "Moving a part — with its wiring" slugs to
// `moving-a-part--with-its-wiring` on GitHub and the website and
// `moving-a-part-with-its-wiring` in the app — so a link written against one
// output silently 404s in the other, and the author has no way to write one
// that works in both. Nothing in the guide happened to link to such a heading,
// which is exactly why it survived: the divergence was latent, and the next
// em dash in a heading was going to spend it.
//
// GITHUB'S RULE WINS, for the reason above — the .md files are read on GitHub
// as they are, so its slugger is the only one of the four that cannot be
// changed. Its steps, in order: lowercase, trim, drop everything that is not a
// word character / whitespace / hyphen, then turn EACH whitespace character
// into one hyphen. Consecutive hyphens are NOT collapsed — that last point is
// the whole bug, so it is stated rather than implied.
//
// tests/heading-slug.test.js pins the rule AND sweeps every `#fragment` in the
// guide against the real headings, so a link that resolves nowhere fails the
// suite rather than shipping as a dead anchor.

/** Decode the HTML entities a Markdown renderer emits, so the slug is built
    from the RAW characters ("Power &amp; Clocks" → "Power & Clocks") rather
    than the escaped form, which would leak a literal "amp" into the id. */
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&"); // last, so the others aren't double-decoded
}

/**
 * The heading id for a plain-text heading — GitHub's slugger, exactly.
 *
 * @param {string} text heading text, already decoded and free of markup
 * @returns {string}
 */
export function slugifyHeading(text) {
  return (text ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s/g, "-"); // each whitespace char → one hyphen; NEVER collapsed
}

/**
 * The same id, for a heading still in its rendered HTML form — strip the tags
 * an inline `code`/`em` span leaves behind, decode the entities, then slugify.
 * The website/PDF builder slugs from marked's output and needs both steps; the
 * in-app viewer reads `h.textContent`, which the DOM has already done for it.
 *
 * @param {string} html inner HTML of a heading element
 * @returns {string}
 */
export function slugifyHeadingHtml(html) {
  return slugifyHeading(decodeEntities((html ?? "").replace(/<[^>]+>/g, "")));
}
