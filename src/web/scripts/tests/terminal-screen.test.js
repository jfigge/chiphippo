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

// terminal-screen.test.js — the Terminal window's glass TTY
// (model/terminal-screen.js) and the bytes its keys and pastes send.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BAD_FRAME,
  SCROLLBACK,
  TerminalScreen,
  keyBytes,
  textBytes,
} from "../model/terminal-screen.js";

const bytes = (s) => [...s].map((c) => c.charCodeAt(0));

test("text, CR LF and a bare CR land where a glass TTY puts them", () => {
  const s = new TerminalScreen();
  s.write(bytes("HELLO\r\nWORLD\rw"));
  assert.deepEqual(s.lines, ["HELLO", "wORLD"]);
  assert.equal(s.col, 1);
});

test("LF keeps the column; with CR as CR LF a CR alone starts a line", () => {
  const s = new TerminalScreen();
  s.write(bytes("AB\nC"));
  assert.deepEqual(s.lines, ["AB", "  C"]);
  const apple = new TerminalScreen({ crAsCrLf: true });
  apple.write(bytes("\\\r8000R\r"));
  assert.deepEqual(apple.lines, ["\\", "8000R", ""]);
});

test("BS steps back without erasing, TAB goes to the next stop, FF clears", () => {
  const s = new TerminalScreen();
  s.write(bytes("PRINT 11\b2"));
  assert.deepEqual(s.lines, ["PRINT 12"]);
  s.write(bytes("\tX"));
  assert.equal(s.lines[0], "PRINT 12        X");
  s.write(bytes("\fNEW"));
  assert.deepEqual(s.lines, ["NEW"]);
});

test("controls show as ^X, BEL rings, bit 7 is dropped, a bad frame is ▒", () => {
  const s = new TerminalScreen();
  s.write([0x1b, 0x5b, 0x07, 0xc1, 0x00, 0x7f]);
  s.write([{ byte: 0x41, framingError: true }, { byte: 0x42 }]);
  assert.deepEqual(s.lines, [`^[[A${BAD_FRAME}B`]);
  assert.equal(s.bells, 1);
});

test("a line longer than the screen wraps; the scrollback is bounded", () => {
  const s = new TerminalScreen({ columns: 4 });
  s.write(bytes("ABCDEF"));
  assert.deepEqual(s.lines, ["ABCD", "EF"]);
  const long = new TerminalScreen();
  long.takeDirty();
  for (let i = 0; i < SCROLLBACK + 50; i++) long.write(bytes(`${i}\r\n`));
  assert.equal(long.lines.length, SCROLLBACK + 1);
  assert.equal(long.lines[0], "50");
  assert.equal(long.takeDirty(), 0, "everything moved up");
  assert.equal(long.takeDirty(), null);
  long.write(bytes("x"));
  assert.equal(long.takeDirty(), SCROLLBACK);
});

test("keys send the bytes the adapter is set to send", () => {
  const set = { enter: "cr", backspace: "bs" };
  assert.deepEqual(keyBytes({ key: "a" }, set), [0x61]);
  assert.deepEqual(keyBytes({ key: "Enter" }, set), [0x0d]);
  assert.deepEqual(keyBytes({ key: "Enter" }, { ...set, enter: "crlf" }), [0x0d, 0x0a]); // prettier-ignore
  assert.deepEqual(keyBytes({ key: "Backspace" }, set), [0x08]);
  assert.deepEqual(keyBytes({ key: "Backspace" }, { ...set, backspace: "del" }), [0x7f]); // prettier-ignore
  assert.deepEqual(keyBytes({ key: "c", ctrlKey: true }, set), [0x03]);
  assert.equal(
    keyBytes({ key: "c", metaKey: true }, set),
    null,
    "⌘ is the app's",
  );
  assert.equal(keyBytes({ key: "ArrowUp" }, set), null);
  assert.equal(
    keyBytes({ key: "é" }, set).length,
    0,
    "past ASCII sends nothing",
  );
});

test("a paste's newlines become the Enter key's bytes", () => {
  assert.deepEqual(textBytes("10 PRINT 1\r\n20 END\nRUN", { enter: "cr" }), [
    ...bytes("10 PRINT 1"),
    0x0d,
    ...bytes("20 END"),
    0x0d,
    ...bytes("RUN"),
  ]);
});
