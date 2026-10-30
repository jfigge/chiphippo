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

test("Rate ▸ Custom… opens a box any rate from 1 Hz to 20 kHz is typed in; past 2 kHz, an (i)", () => {
  const { doc, surface, controller } = desk();
  const clk = controller.addBrickAt("clock", 20, 4, { hz: 5 });
  const params = () => doc.getComponent(clk.id).params;
  openProperties(surface, clk.id);
  const custom = () => row("Custom rate");
  assert.equal(custom(), undefined, "a preset: no box");
  assert.equal(row("Rate").querySelector("select").options[11].textContent, "Custom…"); // prettier-ignore
  pick("Rate", "custom");
  // It opens on the rate the clock had.
  const input = () => custom().querySelector("input");
  assert.equal(input().value, "5Hz");
  assert.deepEqual(params(), { hz: 5 });
  const advice = () => custom().querySelector(".properties-hint-btn");
  const note = () => custom().querySelector(".properties-field-error");
  const type = (text) => {
    input().value = text;
    input().dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  assert.equal(advice().hidden, true);
  // Hz, a k, or kilohertz — read, shown tidy, and set.
  for (const [text, hz, shown] of [
    ["1500", 1500, "1.5kHz"],
    ["2.5k", 2500, "2.5kHz"],
    ["750 Hz", 750, "750Hz"],
    ["3 kHz", 3000, "3kHz"],
    ["10K", 10e3, "10kHz"],
    ["20K", 20e3, "20kHz"],
  ]) {
    type(text);
    assert.equal(params().hz, hz, text);
    assert.equal(input().value, shown, text);
    assert.equal(note().hidden, true, text);
    assert.equal(advice().hidden, hz <= 2000, `${text}: the (i)`);
  }
  // Out of range, or not a rate: red, and the clock keeps its rate.
  for (const text of ["25k", "0.5", "fast", "5V"]) {
    type(text);
    assert.equal(params().hz, 20e3, text);
    assert.equal(note().hidden, false, text);
    assert.equal(input().getAttribute("aria-invalid"), "true", text);
  }
  for (const [text, says] of [
    ["25k", "Out of range: 1Hz to 20kHz"],
    ["fast", "Not a frequency value"],
    ["5V", "That's a voltage, not a frequency"],
  ]) {
    type(text);
    assert.equal(note().textContent, says, text);
  }
  type("4k");
  advice().click();
  const card = custom().querySelector(".properties-advice");
  assert.equal(card.hidden, false);
  assert.equal(card.textContent, "The clock may not be able to run at this rate, and will be slowed as necessary."); // prettier-ignore
  advice().click();
  // Reopened, a custom rate is Custom… with its box; a preset is the preset.
  openProperties(surface, clk.id);
  assert.equal(row("Rate").querySelector("select").value, "custom");
  assert.equal(input().value, "4kHz");
  assert.equal(advice().hidden, false, "the (i) from the start");
  pick("Rate", "250");
  assert.deepEqual(params(), { hz: 250 });
  assert.equal(custom(), undefined);
  // And the clock runs at it: its badge says so.
  pick("Rate", "custom");
  type("1234");
  assert.equal(surface.querySelector(`[data-component-id="${clk.id}"]`).textContent.includes("1.23 kHz"), true); // prettier-ignore
});
