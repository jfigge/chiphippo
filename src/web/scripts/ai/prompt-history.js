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

// prompt-history.js — arrowing back through what you have asked for before.
//
// The shell/Claude Code behaviour, stated as a pure state machine so it can be
// tested with no textarea: a list of past prompts, a cursor into it, and the
// DRAFT the cursor left behind.
//
// Three rules, and the last one is the one that is easy to get wrong:
//
//   * CHRONOLOGICAL, NOT MRU. `recent-files.js` moves a repeat to the front,
//     which is right for an Open Recent menu and wrong here: a list you walk
//     with arrows has to stay in the order you typed it, or the third press
//     lands somewhere you have already been. Only CONSECUTIVE repeats collapse
//     (asking the same thing twice in a row is one memory, not two).
//   * THE DRAFT COMES BACK. Whatever was typed but not sent is parked at the
//     cursor's home position, so arrowing all the way down returns it intact.
//     Losing half-written text to a stray arrow is the failure mode that makes
//     people stop trusting history navigation.
//   * NEWEST FIRST on disk (`entries[0]` is the last thing asked), matching
//     `recentProjects` — but "back" means towards the OLDER end, so `index`
//     counts UP as you go back in time. `index === -1` is the draft.
//
// Storage is `settings.aiHistory` — the app's settings, not the project's, so
// the list follows the USER across every design they open. The panel owns
// reading and writing that; this module only decides what the list becomes.

/** How many prompts are remembered. Deliberately app-wide, not per project. */
export const MAX_HISTORY = 100;

/** Drop anything unusable, collapse consecutive repeats, cap the length. */
export function sanitizeHistory(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const text = entry.trim();
    if (!text) continue;
    if (out.length && out[out.length - 1] === text) continue;
    out.push(text);
    if (out.length >= MAX_HISTORY) break;
  }
  return out;
}

/**
 * Remember `prompt` as the most recent entry.
 *
 * A repeat of the entry already at the front is dropped rather than stacked —
 * but a repeat of something OLDER is kept, because the list is a timeline and
 * removing the older copy would silently renumber everything behind it.
 *
 * @param {Array<string>} list  newest first
 * @param {string} prompt
 * @returns {Array<string>} a new array; the input is never mutated
 */
export function rememberPrompt(list, prompt) {
  const clean = sanitizeHistory(list);
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) return clean;
  if (clean[0] === text) return clean;
  return [text, ...clean].slice(0, MAX_HISTORY);
}

/**
 * A cursor walking a history list, with the unsent draft parked at home.
 *
 * Deliberately holds no DOM and no caret: WHERE the caret goes after a move is
 * the panel's business, and keeping it out of here is what makes the whole
 * navigation testable without a window.
 */
export class PromptHistory {
  #entries;
  #index = -1; // -1 is the draft; 0 is the newest entry, and up counts back
  #draft = "";

  /** @param {Array<string>} [entries] newest first, as stored */
  constructor(entries = []) {
    this.#entries = sanitizeHistory(entries);
  }

  /** The stored list, newest first — what the panel persists. */
  get entries() {
    return [...this.#entries];
  }

  get size() {
    return this.#entries.length;
  }

  /** True while the cursor is parked on the draft rather than in the past. */
  get atDraft() {
    return this.#index === -1;
  }

  /**
   * Record a sent prompt and return home.
   *
   * Sending ENDS a navigation: the cursor goes back to the draft (now empty,
   * since the text left with the send), so the next Up starts from the newest
   * entry rather than wherever the user had wandered to.
   */
  remember(prompt) {
    this.#entries = rememberPrompt(this.#entries, prompt);
    this.reset();
    return this.entries;
  }

  /** Abandon any navigation in progress and forget the parked draft. */
  reset() {
    this.#index = -1;
    this.#draft = "";
  }

  /**
   * Step towards OLDER entries.
   *
   * @param {string} current  what is in the box right now — parked as the
   *   draft on the first step back, so it survives the round trip.
   * @returns {string|null} the text to show, or null when there is nowhere
   *   further back to go (the caller leaves the box alone).
   */
  back(current = "") {
    if (this.#index + 1 >= this.#entries.length) return null;
    if (this.#index === -1) this.#draft = current;
    this.#index += 1;
    return this.#entries[this.#index];
  }

  /**
   * Step towards NEWER entries, ending at the parked draft.
   *
   * @returns {string|null} the text to show, or null when already at the
   *   draft — Down at the newest entry restores what was being typed, and a
   *   further Down does nothing.
   */
  forward() {
    if (this.#index === -1) return null;
    this.#index -= 1;
    return this.#index === -1 ? this.#draft : this.#entries[this.#index];
  }
}
