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

// example-desktops.js — what a part's bundled example circuit (Feature 270)
// puts on the desk. Pure. A payload under src/web/demos/ comes in two shapes:
//
//   { ref, title, doc }               the one bench `make demos` builds for a
//                                     benchable part — one desktop;
//   { ref, title, desktops: [         a HAND-BUILT example (demo-build.mjs's
//       { name, doc, description? }   HAND_BUILT), one desktop per thing the
//   ] }                               part does — the 555's three modes.
//
// This is the one place either is read, so the workspace and the export tests
// cannot disagree about what an example holds.
//
// A desktop's tab NAME is its identity: asking for an example again finds the
// desktops it already added by name (see ProjectWorkspace.openExample). So the
// names are built here, from the ref and the stored desktop name, and are
// deliberately not translated — a language change must not turn an open
// example into a missing one.

/** The tab name of an example desktop: `74LS00 example`, `NE555 Astable
    example`. */
function tabName(ref, name) {
  return name ? `${ref} ${name} example` : `${ref} example`;
}

/**
 * The desktops one example adds, in the order it lists them, each with the
 * tab name that identifies it on the strip and the description its tooltip
 * shows. Empty for anything that is not an example payload.
 * @param {string} ref - the part the example belongs to
 * @param {object|null} payload - what `demo:read` answered
 * @returns {{name: string, description: string, doc: object}[]}
 */
export function exampleDesktops(ref, payload) {
  const title = typeof payload?.title === "string" ? payload.title : "";
  if (Array.isArray(payload?.desktops)) {
    return payload.desktops
      .filter((d) => d?.doc && typeof d.name === "string" && d.name)
      .map((d) => ({
        name: tabName(ref, d.name),
        description: typeof d.description === "string" ? d.description : title,
        doc: d.doc,
      }));
  }
  return payload?.doc
    ? [{ name: tabName(ref, ""), description: title, doc: payload.doc }]
    : [];
}
