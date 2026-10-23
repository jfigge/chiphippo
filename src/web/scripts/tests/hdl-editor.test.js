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

// The chip designer's code editor (components/hdl-editor.js) takes Tab for
// indenting, which would make the code area a keyboard trap. Shift+Tab is
// left to the browser (focus moves back), and Escape arms the NEXT Tab to
// leave as well (the CodeMirror / VS Code convention) — any other key in
// between disarms it, a bare modifier excepted.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { HdlEditor } = await import("../components/hdl-editor.js");

function mount() {
  resetDom();
  const editor = new HdlEditor();
  document.body.append(editor.element);
  const input = editor.element.querySelector("textarea");
  input.focus();
  /** Press `key` in the textarea; true when the editor took it (prevented). */
  const press = (key, mods = {}) => {
    const e = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...mods,
    });
    input.dispatchEvent(e);
    return e.defaultPrevented;
  };
  return { editor, input, press };
}

test("Tab indents, and is kept from the browser", () => {
  const { editor, press } = mount();
  assert.equal(press("Tab"), true);
  assert.equal(editor.value, "  ");
});

test("Shift+Tab is left to the browser, so focus moves back", () => {
  const { editor, press } = mount();
  assert.equal(press("Tab", { shiftKey: true }), false);
  assert.equal(editor.value, "");
});

test("Escape then Tab leaves the code area instead of indenting", () => {
  const { editor, press } = mount();
  assert.equal(press("Escape"), false);
  assert.equal(press("Tab"), false);
  assert.equal(editor.value, "");
  // Disarmed by the Tab it let through: the next one indents again.
  assert.equal(press("Tab"), true);
  assert.equal(editor.value, "  ");
});

test("any other key between Escape and Tab disarms it", () => {
  const { editor, press } = mount();
  press("Escape");
  press("ArrowLeft");
  assert.equal(press("Tab"), true);
  assert.equal(editor.value, "  ");
});

test("a bare modifier between Escape and Tab leaves it armed", () => {
  const { press } = mount();
  press("Escape");
  press("Shift", { shiftKey: true });
  assert.equal(press("Tab"), false);
});

test("leaving the field disarms it", () => {
  const { input, press } = mount();
  press("Escape");
  input.dispatchEvent(new Event("blur"));
  assert.equal(press("Tab"), true);
});
