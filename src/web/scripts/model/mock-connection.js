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

// mock-connection.js — the identity of the built-in MOCK connection
// (docs/chiphippo-mock-connection.md): a connection every installation has,
// that plays the device side of the serial protocol inside Chip Hippo, so an
// integration can be built and tested before a wire is connected.
//
// Dependency-free, and read from BOTH sides of the bridge for the reason
// serial-wire.js is: main's serial-manager.js `require()`s it to recognise the
// connection a run names, and the renderer imports it to offer it. The id is
// what an element stores, so the two must never disagree about it.
//
// The id cannot collide with a user's connection (those are minted
// `conn-<hex>`), and a stored user connection claiming it is dropped on load.
// The NAME is reserved too — a connection is picked by name everywhere the
// user sees one — and is deliberately not translated: it is the connection's
// name, the way "Arduino" is the default of a user's, not a sentence.

/** The id every element on the mock stores. */
export const MOCK_ID = "mock";

/** Its name, on its card, in every Connection list and on its window. */
export const MOCK_NAME = "Mock";

/** Is this the mock's id? */
export function isMockId(id) {
  return id === MOCK_ID;
}

/** Would a user's connection called this be confused with the mock? */
export function isReservedConnectionName(name) {
  return (
    String(name ?? "")
      .trim()
      .toLowerCase() === MOCK_NAME.toLowerCase()
  );
}
