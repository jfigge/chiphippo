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

// wording.js — the submission service's word check: a short list of words
// no gallery title, name, description or tag should carry. A first filter
// only — every share is read by a person before it is published — so it is
// deliberately small and errs towards letting a share through to review.
// A word matches whole (with a plural or -ing/-ed/-er ending), after the
// commonest letter-for-digit swaps are undone, so "cockpit" passes and
// "sh1t" does not.
//
// Left OFF the list because electronics and names use them plainly (2026-11-10):
// "retard" (spark/ignition retard, a timing circuit's own word) and "dick" (a
// first name, and the Dick Smith kits). Review is there for the rest.

/** The words refused, lowercase. */
export const REFUSED_WORDS = Object.freeze([
  "fuck",
  "shit",
  "cunt",
  "bitch",
  "asshole",
  "bastard",
  "cock",
  "pussy",
  "whore",
  "slut",
  "nigger",
  "nigga",
  "faggot",
  "fag",
  "rape",
]);

/** The swaps undone before matching: 0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s. */
const SWAPS = Object.freeze({ 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s" }); // prettier-ignore

const WORD_RE = new RegExp(
  `(?:^|[^a-z])(?:${REFUSED_WORDS.join("|")})(?:s|es|ing|ed|er|ers|y)?(?=$|[^a-z])`,
);

/** Does this text carry a refused word? */
export function hasRefusedWord(text) {
  const folded = String(text ?? "")
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => SWAPS[c]);
  return WORD_RE.test(folded);
}

/**
 * The first of the four fields that carries a refused word, or null.
 * @param {{title: string, author: string, description: string,
 *   tags: string[]}} fields
 */
export function wordingProblem({ title, author, description, tags }) {
  for (const [field, text] of [
    ["title", title],
    ["author", author],
    ["description", description],
    ["tags", (tags ?? []).join(" ")],
  ]) {
    if (hasRefusedWord(text)) return field;
  }
  return null;
}
