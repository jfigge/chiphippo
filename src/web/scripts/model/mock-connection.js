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
