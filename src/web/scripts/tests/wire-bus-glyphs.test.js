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

// The Wire and Bus segments as glyphs (wire-bus-glyphs.js; the label brief
// §5, kept 2026-11-09). Built the way app.js builds them, then converted, so what
// is held here is that the conversion changes the FACE and nothing the
// segments do: a click on the glyph toggles the tool, the corner readouts
// still open their pickers without toggling it, the tooltips stay.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resetDom } from "./jsdom-setup.js";

const { glyphWireBus, WIRE_GLYPH_SVG, BUS_GLYPH_SVG } = await import("../components/wire-bus-glyphs.js"); // prettier-ignore
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

// ── How much of the glyph a readout may cover ──
// The square and the badge sit over the glyph's lower-right corner, and are
// never to cover more than its right 40 % (Jason, 2026-11-09). jsdom does no
// layout, so this holds the stylesheet to the shape that guarantees it: the
// stack is exactly the glyph's width (its only in-flow child), the readout is
// placed from its LEFT edge at 60 % or more of that width and nothing moves
// it back, and its size is a fixed px — part of the 16 px icon, never the
// type scale, which at 16 and 18 grew it over the whole glyph. (Checked in
// the running app at every font size, labels on and off: 40 % each time.)

const CSS = fs
  .readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../styles/app.css",
    ),
    "utf8",
  )
  .replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration of every rule whose selector names `cls`. */
function declsFor(cls) {
  const out = [];
  for (const [, selector, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!new RegExp(`\\.${cls}(?![\\w-])`).test(selector)) continue;
    for (const decl of body.split(";")) {
      const i = decl.indexOf(":");
      if (i < 0) continue;
      out.push({ selector: selector.trim(), prop: decl.slice(0, i).trim(), value: decl.slice(i + 1).trim() }); // prettier-ignore
    }
  }
  return out;
}

test("the glyph stack is the glyph's own width", () => {
  for (const svg of [WIRE_GLYPH_SVG, BUS_GLYPH_SVG]) {
    assert.match(svg, /^<svg [^>]*width="16"/);
  }
  const stack = declsFor("toolbar-glyph-stack");
  assert.ok(stack.some((d) => d.prop === "position" && d.value === "relative"));
  for (const d of stack) {
    assert.ok(
      !/^(min-|max-)?width$|^padding|^gap$/.test(d.prop),
      `${d.selector} { ${d.prop} } would make the stack wider than its glyph`,
    );
  }
});

test("a corner readout never covers more than the glyph's right 40 %", () => {
  for (const cls of ["wire-swatch-dot--corner", "bus-width-badge--corner"]) {
    const decls = declsFor(cls);
    const left = decls.filter((d) => d.prop === "left");
    assert.equal(left.length, 1, `${cls}: placed by one \`left\``);
    const pct = /^([\d.]+)%$/.exec(left[0].value);
    assert.ok(pct, `${cls}: left is a share of the glyph, not ${left[0].value}`); // prettier-ignore
    const covered = 100 - Number(pct[1]);
    assert.ok(covered <= 40, `${cls} covers ${covered} % of the glyph`);
    assert.ok(decls.some((d) => d.prop === "position" && d.value === "absolute")); // prettier-ignore
    for (const d of decls) {
      assert.ok(
        !/^(right|inset|inset-inline|inset-inline-start|margin|margin-left|margin-inline|margin-inline-start|transform|translate)$/.test(d.prop), // prettier-ignore
        `${d.selector} { ${d.prop}: ${d.value} } could pull ${cls} left`,
      );
    }
  }
});

test("the corner readouts are fixed with the icon, never on the type scale", () => {
  for (const cls of ["wire-swatch-dot--corner", "bus-width-badge--corner"]) {
    for (const d of declsFor(cls)) {
      if (!/^(min-)?width$|^height$|^font-size$|^padding/.test(d.prop))
        continue;
      assert.ok(
        !/var\(--font-size|em\b|%/.test(d.value),
        `${d.selector} { ${d.prop}: ${d.value} } grows with the font`,
      );
    }
  }
});
