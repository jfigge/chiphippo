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

// export-ui.test.js — Export To's renderer half (Feature 390): the report
// card, which speaks only in the catalog's words and answers exactly once, and
// the exporter that runs generate → report → main → toast.

import test from "node:test";
import assert from "node:assert/strict";

import { resetDom } from "./jsdom-setup.js";
import { bench, demoDocs } from "./export-fixtures.js";

const { applyCatalog } = await import("../i18n.js");
const { PopupManager } = await import("../popup-manager.js");
const { compactDesignators, openExportReport, reportWorthShowing } =
  await import("../components/export-report-dialog.js");
const { DesktopExporter } = await import("../components/desktop-exporter.js");

const settle = () => new Promise((r) => setTimeout(r, 0));
const buttons = () => [
  ...document.querySelectorAll(".export-report-footer button"),
];

test("designators fold into runs", () => {
  assert.equal(compactDesignators(["R1", "R2", "R3", "R5"]), "R1–R3, R5");
  assert.equal(compactDesignators(["U7"]), "U7");
  assert.equal(compactDesignators(["D2", "D1"]), "D2, D1");
});

test("only something dropped, changed or needing a footprint earns the card", () => {
  assert.equal(reportWorthShowing([]), false);
  assert.equal(reportWorthShowing([{ kind: "dropped" }]), true);
  assert.equal(reportWorthShowing([{ kind: "info" }]), false);
});

test("the card speaks through the catalog, never in the exporter's words", async (t) => {
  resetDom();
  applyCatalog({
    active: "xx",
    lang: "xx",
    messages: {
      common: { cancel: "[cancel]", close: "[close]" },
      popup: { closeNamed: "[close {title}]" },
      export: {
        title: "[to {format}]",
        guide: "[guide]",
        confirm: "[go]",
        note: "[note]",
        group: {
          dropped: { other: "[{count} dropped]" },
          changed: { other: "[{count} changed in {format}]" },
        },
        reason: {
          noDigitalModel: "[no model]",
          resistorMerged: "[a wire]",
          signals: { other: "[{count} signals]" },
        },
      },
    },
  });
  t.after(() => resetDom());
  const answer = openExportReport({
    formatName: "Digital",
    report: [
      { kind: "dropped", code: "noDigitalModel", ref: "74LS240", designators: ["U7"] }, // prettier-ignore
      { kind: "changed", code: "resistorMerged", ref: "resistor", designators: ["R1", "R2"] }, // prettier-ignore
      { kind: "dropped", code: "signals", count: 2 },
    ],
  });
  const text = document.querySelector(".export-report-popup").textContent;
  assert.match(text, /\[to Digital\]/);
  assert.match(text, /\[3 dropped\]/, "one part plus two signals");
  assert.match(text, /\[2 changed in Digital\]/);
  assert.match(text, /U7.*74LS240.*\[no model\]/);
  assert.match(text, /R1–R2/);
  assert.match(text, /\[2 signals\]/);
  assert.match(text, /\[note\]/, "a dropped part says its nets survive");
  buttons()
    .find((b) => b.textContent === "[go]")
    .click();
  assert.equal(await answer, true);
});

test("every way out of the card but Export answers false", async () => {
  resetDom();
  const report = [
    { kind: "footprint", code: "genericFootprint", ref: "seg8cc", designators: ["DS1"] }, // prettier-ignore
  ];
  const cancelled = openExportReport({ formatName: "KiCad", report });
  buttons()
    .find((b) => b.textContent === "Cancel")
    .click();
  assert.equal(await cancelled, false);

  const dismissed = openExportReport({ formatName: "KiCad", report });
  PopupManager.close(); // the ×, Escape, a click outside
  assert.equal(await dismissed, false);
});

/** A fake bridge + toast stack, recording what the exporter did. */
function rig({ answer = { ok: true, path: "/out/x" } } = {}) {
  const calls = [];
  const toasts = [];
  const bridge = {
    desktop: {
      exportTo: async (format, files) => {
        calls.push({ format, files });
        return answer;
      },
    },
  };
  const exporter = new DesktopExporter({
    bridge,
    notifications: { notify: (t) => toasts.push(t) },
  });
  return { exporter, calls, toasts };
}

test("an empty desktop says so and writes nothing", async () => {
  resetDom();
  const { exporter, calls, toasts } = rig();
  const ok = await exporter.export(
    { tabId: "t1", name: "Empty", doc: { components: [] } },
    "kicad",
  );
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
  assert.match(toasts[0].message, /nothing on this desktop/);
});

test("a clean export goes straight to main, then says where it went", async () => {
  resetDom();
  const { exporter, calls, toasts } = rig();
  // The bench has nothing KiCad cannot carry: no report card.
  const ok = await exporter.export(
    { tabId: "t1", name: "Bench", doc: bench() },
    "kicad",
  );
  assert.equal(ok, true);
  assert.equal(calls[0].format, "kicad");
  assert.deepEqual(calls[0].files.map((f) => f.name).sort(), [
    "Bench.kicad_pro",
    "Bench.kicad_sch",
    "chiphippo.kicad_sym",
    "sym-lib-table",
  ]);
  assert.equal(toasts[0].title, "Exported to KiCad");
  assert.match(toasts[0].message, /“Bench” was written to \/out\/x/);
});

test("with a report, nothing is written until the card says Export", async () => {
  resetDom();
  const { exporter, calls } = rig();
  const { doc } = demoDocs().find((d) => d.ref === "74LS240");
  const pending = exporter.export({ tabId: "t1", name: "240", doc }, "digital");
  await settle();
  assert.ok(document.querySelector(".export-report-popup"), "the card is up");
  assert.equal(calls.length, 0, "nothing sent yet");
  buttons()
    .find((b) => b.textContent === "Cancel")
    .click();
  assert.equal(await pending, false);
  assert.equal(calls.length, 0, "a cancelled report writes nothing");
});

test("a folder holding someone else's schematic is explained, not overwritten", async () => {
  resetDom();
  const { exporter } = rig({
    answer: { ok: false, code: "foreign", file: "Bench.kicad_sch" },
  });
  const ok = await exporter.export(
    { tabId: "t1", name: "Bench", doc: bench() },
    "kicad",
  );
  assert.equal(ok, false);
  const message = document.querySelector(".popup-message")?.textContent ?? "";
  assert.match(
    message,
    /Bench\.kicad_sch in that folder was not written by Chip Hippo/,
  );
  PopupManager.close();
});

test("a cancelled dialog is silent", async () => {
  resetDom();
  const { exporter, toasts } = rig({ answer: null });
  const ok = await exporter.export(
    { tabId: "t1", name: "Bench", doc: bench() },
    "kicad",
  );
  assert.equal(ok, false);
  assert.equal(toasts.length, 0);
});
