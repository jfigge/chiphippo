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

test("each becomes an icon segment: glyph, readout under it, word as label", () => {
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
    assert.equal(
      readout.parentElement,
      stack,
      "the readout in the glyph's stack",
    );
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

test("the glyphs are drawn in the ink colour; the square and the bus badge show the wire colour", () => {
  resetDom();
  const { wire, bus, wireDot, busWidth } = mount();
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
  // …and so is the bus badge (the colour its wires will be)…
  assert.equal(
    busWidth.element.style.getPropertyValue("--wire-color"),
    "var(--color-wire-blue)",
  );
  // …named on both buttons, for black's and white's border and the digit's ink.
  assert.equal(wire.dataset.wireColor, "blue");
  assert.equal(bus.dataset.wireColor, "blue");
});

// ── Where the readouts are, and when ──
// The square and the badge show only while their tool is ARMED, centred under
// the glyph across and centred ON its pill's bottom border line down —
// never over the glyph or its label — floating (absolute) so the toolbar
// never grows to hold them (Jason, 2026-11-10). jsdom does no layout, so this
// holds the stylesheet to that shape (the line's distance is header-fit.js's
// `publishEdge`, tested there) — and to a fixed px size, part of the 16 px
// icon, never the type scale (at 16 and 18 it buried the glyph).

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
      // Whitespace as Prettier lays it out is no part of the value.
      const value = decl.slice(i + 1).trim().replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")"); // prettier-ignore
      out.push({ selector: selector.trim().replace(/\s+/g, " "), prop: decl.slice(0, i).trim(), value }); // prettier-ignore
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

test("a readout is centred under its glyph and on its pill's bottom line, floating", () => {
  for (const cls of ["wire-swatch-dot--readout", "bus-width-badge--readout"]) {
    const all = declsFor(cls);
    // The scroll step's own placement is held by the next test.
    const decls = all.filter((d) => !d.selector.includes("app-header--scroll"));
    const value = (prop) => decls.filter((d) => d.prop === prop).map((d) => d.value); // prettier-ignore
    assert.deepEqual(value("position"), ["absolute"], `${cls}: floats — the toolbar never grows`); // prettier-ignore
    assert.deepEqual(value("left"), ["50%"], `${cls}: centred across`);
    // Its top at the border line's middle, measured into the stack, and the
    // readout pulled back by half its own size both ways: centred ON the line.
    assert.deepEqual(value("top"), ["var(--to-edge, 100%)"], `${cls}: at the pill's bottom line`); // prettier-ignore
    assert.deepEqual(value("transform"), ["translate(-50%, -50%)"], `${cls}: on its own middle`); // prettier-ignore
    for (const d of all) {
      assert.ok(
        !/^(right|bottom|inset|inset-(inline|block)(-start|-end)?|margin(-(left|top|right|bottom|inline|block)(-start|-end)?)?|translate)$/.test(d.prop), // prettier-ignore
        `${d.selector} { ${d.prop}: ${d.value} } would move ${cls} off centre`,
      );
    }
  }
  // The header lifts itself over the tab strip, or the half below the line
  // would be painted under it.
  const header = declsFor("app-header").filter((d) => d.selector === ".app-header"); // prettier-ignore
  assert.ok(
    header.some((d) => d.prop === "position" && d.value === "relative"),
  );
  const tabs = declsFor("project-tabs").find((d) => d.selector === ".project-tabs" && d.prop === "z-index"); // prettier-ignore
  const z = header.find((d) => d.prop === "z-index");
  assert.ok(z && Number(z.value) > Number(tabs?.value ?? 0), "the header paints over the tabs"); // prettier-ignore
});

test("at the scroll step a readout rests inside the pill, whole, still centred", () => {
  // The scrolling pill clips what hangs past it: the readout's bottom sits
  // on the border's inner edge instead of straddling the line.
  for (const cls of ["wire-swatch-dot--readout", "bus-width-badge--readout"]) {
    const scroll = declsFor(cls).filter((d) => d.selector.includes(".app-header--scroll .toolbar-pill--tools")); // prettier-ignore
    const value = (prop) => scroll.filter((d) => d.prop === prop).map((d) => d.value); // prettier-ignore
    assert.deepEqual(value("top"), ["calc(var(--to-edge, 100%) - 0.5px)"], cls); // prettier-ignore
    assert.deepEqual(value("transform"), ["translate(-50%, -100%)"], `${cls}: still centred across`); // prettier-ignore
  }
  // …and that is the pill that scrolls there, and its border is 1 px.
  const pill = declsFor("toolbar-pill--tools").filter((d) => d.selector === ".app-header--scroll .toolbar-pill--tools"); // prettier-ignore
  assert.ok(pill.some((d) => d.prop === "overflow-x" && d.value === "auto"));
  const border = declsFor("toolbar-pill").find((d) => d.selector === ".toolbar-pill" && d.prop === "border"); // prettier-ignore
  assert.match(border?.value ?? "", /^1px /);
});

test("each glyph stack asks header-fit for the line's distance", () => {
  resetDom();
  const parts = mount();
  for (const btn of [parts.wire, parts.bus]) {
    const stack = btn.querySelector(".toolbar-glyph-stack");
    assert.equal(stack.dataset.edgeOf, ".toolbar-pill", "its pill's line");
  }
});

test("a readout shows only while its tool is armed", () => {
  for (const cls of ["wire-swatch-dot--readout", "bus-width-badge--readout"]) {
    const hidden = declsFor(cls).filter((d) => d.prop === "display" && d.value === "none"); // prettier-ignore
    assert.equal(hidden.length, 1, cls);
    assert.match(hidden[0].selector, new RegExp(`\\.toolbar-pill-btn--glyph-tool:not\\(\\.toolbar-btn--active\\) \\.${cls}`)); // prettier-ignore
  }
});

test("the readouts are fixed with the icon, never on the type scale", () => {
  for (const cls of ["wire-swatch-dot--readout", "bus-width-badge--readout"]) {
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
