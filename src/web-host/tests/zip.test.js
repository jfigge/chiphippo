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

// zip.test.js — the one-download .zip a KiCad export becomes in a browser that
// cannot be handed a folder: read back entry by entry.

import test from "node:test";
import assert from "node:assert/strict";
import { crc32, zipStored } from "../zip.js";

test("crc32 is the standard one", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("a stored zip reads back its files", () => {
  const files = [
    { name: "Demo.kicad_sch", data: new TextEncoder().encode("(kicad_sch)") },
    {
      name: "sym-lib-table",
      data: new TextEncoder().encode("(sym_lib_table)"),
    },
  ];
  const zip = zipStored(files, new Date(2026, 9, 24, 12, 0, 0));
  const view = new DataView(zip.buffer);
  const end = zip.length - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  assert.equal(view.getUint16(end + 10, true), 2);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (const file of files) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const nameLen = view.getUint16(at + 28, true);
    assert.equal(
      decoder.decode(zip.subarray(at + 46, at + 46 + nameLen)),
      file.name,
    );
    const local = view.getUint32(at + 42, true);
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const size = view.getUint32(local + 18, true);
    const nl = view.getUint16(local + 26, true);
    const data = zip.subarray(local + 30 + nl, local + 30 + nl + size);
    assert.deepEqual([...data], [...file.data]);
    assert.equal(view.getUint32(local + 14, true), crc32(file.data));
    at += 46 + nameLen;
  }
});
