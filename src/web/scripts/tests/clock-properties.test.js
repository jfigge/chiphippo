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

// jsdom tests for a clock brick's Properties card: the Wave type offers the
// levels (Square, PWM) in both engines and every other wave under Spice Lite
// only — bar the one the clock holds, which the select must still say — and
// the Pulse width slider, live for a PWM alone, reads out its own percent.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { DeskDoc } from "../model/desk-doc.js";

const { DeskController } = await import("../components/desk-controller.js");
const { PopupManager } = await import("../popup-manager.js");

function desk() {
  resetDom();
  const doc = new DeskDoc(null);
  const viewport = document.createElement("section");
  const surface = document.createElement("div");
  viewport.append(surface);
  document.body.append(viewport);
  const deskView = {
    surface,
    camera: { cx: 0, cy: 0, zoom: 1 },
    worldFromEvent: () => ({ x: 0, y: 0 }),
  };
  const controller = new DeskController({ viewport, deskView, deskDoc: doc });
  return { doc, surface, controller };
}

const openProperties = (surface, id) => {
  PopupManager.close();
  surface.querySelector(`[data-component-id="${id}"]`).dispatchEvent(
    new window.MouseEvent("contextmenu", { bubbles: true, clientX: 9, clientY: 9 }), // prettier-ignore
  );
  [...document.querySelectorAll(".popup-menu-item")]
    .find((b) => b.textContent.trim() === "Properties…")
    .click();
};

/** The open card's row whose label reads `label`. */
const row = (label) =>
  [...document.querySelectorAll(".properties-row")].find(
    (r) => r.querySelector(".properties-label")?.textContent === label,
  );

const waveTexts = () =>
  [...row("Wave type").querySelector("select").options].map(
    (o) => o.textContent,
  );

const pick = (label, value) => {
  const select = row(label).querySelector("select");
  select.value = value;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
};

test("the Wave type offers the levels in both engines, every wave under Spice Lite", () => {
  const { surface, controller } = desk();
  const clk = controller.addBrickAt("clock", 20, 4, { hz: 5 });
  openProperties(surface, clk.id);
  assert.deepEqual(waveTexts(), ["Square", "PWM"]);
  controller.setSpiceLite({ enabled: true });
  openProperties(surface, clk.id);
  assert.deepEqual(waveTexts(), [
    "Square",
    "PWM",
    "Triangle",
    "Trapezoid",
    "Sawtooth (ramp up)",
    "Sawtooth (ramp down)",
    "Sine",
  ]);
  // A triangle clock, Spice Lite off: the select still says Triangle.
  pick("Wave type", "triangle");
  controller.setSpiceLite({ enabled: false });
  openProperties(surface, clk.id);
  assert.deepEqual(waveTexts(), ["Square", "PWM", "Triangle"]);
  assert.equal(row("Wave type").querySelector("select").value, "triangle");
});

test("the Pulse width is live for a PWM alone, and reads out its own percent", () => {
  const { doc, surface, controller } = desk();
  const clk = controller.addBrickAt("clock", 20, 4, { hz: 5 });
  const params = () => doc.getComponent(clk.id).params;
  openProperties(surface, clk.id);
  const slider = () => row("Pulse width").querySelector("input");
  const readout = () =>
    row("Pulse width").querySelector(".properties-range-value").textContent;
  // A square: greyed, at the square's 50 %.
  assert.equal(slider().disabled, true);
  assert.equal(slider().value, "50");
  assert.match(readout(), /^50\s?%$/);
  pick("Wave type", "pwm");
  assert.equal(slider().disabled, false);
  assert.deepEqual(params(), { hz: 5, wave: "pwm" });
  slider().value = "25";
  slider().dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(readout(), /^25\s?%$/);
  assert.deepEqual(params(), { hz: 5, wave: "pwm", duty: 25 });
  // Its own percent at the ends too, not a share of the 1–99 track.
  slider().value = "1";
  slider().dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.match(readout(), /^1\s?%$/);
  // Manual: a switch, square — greyed again.
  pick("Rate", "manual");
  assert.equal(slider().disabled, true);
});
