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

// string-decoder.js — Node's StringDecoder for the web build: the serial link
// decodes a device's log text a chunk at a time, and a UTF-8 character can be
// split across two chunks. TextDecoder's streaming mode is the same contract.

export class StringDecoder {
  #decoder;

  constructor(encoding = "utf8") {
    const enc = String(encoding).toLowerCase();
    this.#decoder = new TextDecoder(enc === "utf8" ? "utf-8" : enc);
  }

  write(buf) {
    return this.#decoder.decode(buf, { stream: true });
  }

  end(buf) {
    return this.#decoder.decode(buf ?? new Uint8Array(0));
  }
}

export default { StringDecoder };
