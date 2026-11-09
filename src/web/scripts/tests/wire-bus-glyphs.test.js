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

// The Wire and Bus segments as glyphs — PROVISIONAL (wire-bus-glyphs.js; the
// label brief §5). Built the way app.js builds them, then converted, so what
// is held here is that the conversion changes the FACE and nothing the
// segments do: a click on the glyph toggles the tool, the corner readouts
// still open their pickers without toggling it, the tooltips stay.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";

const { glyphWireBus } = await import("../components/wire-bus-glyphs.js");
const { createWireColorDot } = await import("../components/wire-color-dot.js");
const { createBusWidthBadge } = await import("../components/bus-width-badge.js"); // prettier-ignore
const { PopupManager } = await import("../popup-manager.js");
const { el } = await import("../dom.js");
const { t } = await import("../i18n.js");

const click = (node) =>
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

function mount() {
  const toggles = { wire: 0, bus: 0 };
  const picked = [];
  const wireDot = createWireColorDot({
    getColor: () => "red",
    onPick: (c) => picked.push(c),
  });
  const busWidth = createBusWidthBadge({
    getName: () => "DATA",
    onPick: (n) => picked.push(n),
  });
  const wire = el(
    "button",
    {
      class: "toolbar-pill-btn toolbar-pill-btn--tool",
      title: t("toolbar.wire.title"),
      onClick: () => (toggles.wire += 1),
    },
    [el("span", { text: t("toolbar.wire.label") }), wireDot.element],
  );
  const bus = el(
    "button",
    {
      class: "toolbar-pill-btn toolbar-pill-btn--tool",
      title: t("toolbar.bus.title"),
      onClick: () => (toggles.bus += 1),
    },
    [el("span", { text: t("toolbar.bus.label") }), busWidth.element],
  );
  document.body.append(wire, bus);
  glyphWireBus({ wire, wireDot, bus, busWidth });
  return { wire, bus, wireDot, busWidth, toggles, picked };
}

test("each becomes an icon segment: glyph, readout on its corner, word as label", () => {
  resetDom();
  const { wire, bus, wireDot, busWidth } = mount();
  for (const [btn, readout, word] of [
    [wire, wireDot.element, t("toolbar.wire.label")],
    [bus, busWidth.element, t("toolbar.bus.label")],
  ]) {
    assert.ok(btn.classList.contains("toolbar-pill-btn--icon"));
    assert.ok(!btn.classList.contains("toolbar-pill-btn--tool"));
    const stack = btn.querySelector(".toolbar-glyph-stack");
    assert.ok(stack.querySelector("svg"), "a glyph");
    assert.equal(readout.parentElement, stack, "the readout on its corner");
    assert.equal(btn.querySelector(".toolbar-pill-label").textContent, word);
    // The name a hidden label can no longer give, and the tooltip unchanged.
    assert.equal(btn.getAttribute("aria-label"), word);
    assert.ok(btn.title);
  }
});

test("the glyph toggles the tool; the readouts open their pickers and do not", () => {
  resetDom();
  const { wire, bus, wireDot, busWidth, toggles } = mount();
  click(wire.querySelector("svg"));
  click(bus.querySelector("svg"));
  assert.deepEqual(toggles, { wire: 1, bus: 1 });

  click(wireDot.element);
  assert.equal(PopupManager.isOpen(), true, "the colour picker");
  PopupManager.close();
  click(busWidth.element);
  assert.equal(PopupManager.isOpen(), true, "the width picker");
  PopupManager.close();
  assert.deepEqual(toggles, { wire: 1, bus: 1 }, "neither toggled a tool");
});

test("the glyphs are drawn in the ink colour; only the square shows the wire colour", () => {
  resetDom();
  const { wire, bus, wireDot } = mount();
  wireDot.setColor("blue");
  for (const btn of [wire, bus]) {
    assert.equal(btn.style.getPropertyValue("--wire-color"), "");
    assert.equal(
      btn.querySelector("svg").getAttribute("stroke"),
      "currentColor",
    );
  }
  assert.equal(
    wireDot.element.style.getPropertyValue("--wire-color"),
    "var(--color-wire-blue)",
  );
  // …and names it on the button, for black's and white's contrasting border.
  assert.equal(wire.dataset.wireColor, "blue");
});
