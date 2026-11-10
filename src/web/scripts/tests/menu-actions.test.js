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

// menu-actions.test.js — the ONE statement of the File and Desktop actions.
// Every surface that offers them (the menu bar, the File pill's secondary
// click, a tab's menu, the "+") is drawn from it, so what is held here is
// held everywhere: a key every catalog carries, no stray rules, and the
// menu bar and the popup forms saying the same thing in the same order.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_ACTIONS,
  FILE_ACTIONS,
  GATED_ACTION_IDS,
  SEPARATOR,
  accelHint,
  actionEvent,
  dangerLast,
  isEnabled,
  tidySeparators,
  toElectronTemplate,
  toPopupItems,
} from "../model/menu-actions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.join(here, "..", "..", "locales");

/** Every action, submenus included. */
const flat = (list) =>
  list.flatMap((a) => (a === SEPARATOR ? [] : [a, ...flat(a.submenu ?? [])]));

const lookup = (catalog, key) =>
  key.split(".").reduce((node, part) => node?.[part], catalog);

test("every label key is in every catalog", () => {
  for (const file of fs
    .readdirSync(LOCALES)
    .filter((f) => f.endsWith(".json"))) {
    const catalog = JSON.parse(
      fs.readFileSync(path.join(LOCALES, file), "utf8"),
    );
    for (const action of flat([...FILE_ACTIONS, ...DESKTOP_ACTIONS])) {
      assert.equal(
        typeof lookup(catalog, action.labelKey),
        "string",
        `${file}: ${action.labelKey}`,
      );
    }
  }
});

test("no menu starts, ends or doubles up on a rule", () => {
  for (const list of [
    FILE_ACTIONS,
    DESKTOP_ACTIONS,
    ...flat(DESKTOP_ACTIONS)
      .filter((a) => a.submenu)
      .map((a) => a.submenu),
  ]) {
    // prettier-ignore
    assert.deepEqual(tidySeparators(list), [...list]);
  }
});

test("ids are unique, and every push is re-dispatched by preload and answered by app.js", () => {
  const all = flat([...FILE_ACTIONS, ...DESKTOP_ACTIONS]);
  assert.equal(new Set(all.map((a) => a.id)).size, all.length);
  const preload = fs.readFileSync(
    path.join(here, "..", "..", "..", "app", "preload.js"),
    "utf8",
  );
  // …and that the RENDERER listens for what preload re-dispatches: a row
  // whose listener is missing would pass the half above and do nothing.
  const app = fs.readFileSync(path.join(here, "..", "app.js"), "utf8");
  const listens = (event) =>
    app.includes(`addEventListener("chiphippo:${event}"`) ||
    app.includes(`["chiphippo:${event}",`); // wireProjectMenu's table
  for (const action of all) {
    if (action.submenu || action.list) continue;
    const event = actionEvent(action);
    assert.ok(
      preload.includes(`["menu:${event}", "chiphippo:${event}"]`),
      `preload re-dispatches menu:${event}`,
    );
    assert.ok(listens(event), `app.js answers chiphippo:${event}`);
  }
});

test("the gates: Delete off on the last desktop, Duplicate and Share off while running", () => {
  assert.deepEqual([...GATED_ACTION_IDS].sort(), [
    "desktop-delete",
    "desktop-duplicate",
    "desktop-share",
  ]);
  const byId = Object.fromEntries(flat(DESKTOP_ACTIONS).map((a) => [a.id, a]));
  const state = { canDelete: false, canDuplicate: true };
  assert.equal(isEnabled(byId["desktop-delete"], state), false);
  assert.equal(isEnabled(byId["desktop-duplicate"], state), true);
  assert.equal(
    isEnabled(byId["desktop-share"], { canDuplicate: false }),
    false,
  );
  assert.equal(
    isEnabled(byId["desktop-properties"], { canDuplicate: false }),
    true,
  );
});

test("the menu bar and a popup say the same thing in the same order", () => {
  const label = (key) => `L:${key}`;
  const shape = (items, sepOf, subOf, labelOf) =>
    items.map(
      (i) =>
      sepOf(i) ? "—" : subOf(i) ? [labelOf(i), shape(subOf(i), sepOf, subOf, labelOf)] : labelOf(i), // prettier-ignore
    );
  for (const actions of [FILE_ACTIONS, DESKTOP_ACTIONS]) {
    const handlers = Object.fromEntries(flat(actions).map((a) => [a.id, () => {}])); // prettier-ignore
    const electron = toElectronTemplate(actions, {
      label,
      send: () => {},
      lists: { "project-open-recent": [] },
    });
    const popup = toPopupItems(actions, {
      label,
      handlers,
      lists: { "project-open-recent": { items: [] } },
    });
    assert.deepEqual(
      shape(
        popup,
        (i) => i.separator,
        (i) => i.submenu,
        (i) => i.label,
      ),
      shape(electron, (i) => i.type === "separator", (i) => i.submenu, (i) => i.label), // prettier-ignore
    );
  }
});

test("the menu bar's items push their own channel, with a format's payload", () => {
  const sent = [];
  const template = toElectronTemplate(DESKTOP_ACTIONS, {
    label: (k) => k,
    send: (...args) => sent.push(args),
  });
  const exportMenu = template.find(
    (i) => i.label === "menu.desktop.exportMenu",
  );
  exportMenu.submenu
    .find((i) => i.label === "menu.desktop.exportKicad")
    .click();
  template.find((i) => i.label === "menu.desktop.share").click();
  assert.deepEqual(sent, [
    ["menu:desktop-export-to", "kicad"],
    ["menu:desktop-share"],
  ]);
  // The gated items carry the ids main enables and disables them by.
  assert.deepEqual(
    template.filter((i) => i.id).map((i) => i.id),
    ["desktop-duplicate", "desktop-share", "desktop-delete"],
  );
});

test("a popup leaves out what it has no handler for, and tidies the rules", () => {
  const add = () => {};
  const items = toPopupItems(DESKTOP_ACTIONS, {
    label: (k) => k,
    handlers: { "desktop-add": add, "desktop-import": add },
  });
  assert.deepEqual(
    items.map((i) => (i.separator ? "—" : i.label)),
    ["menu.desktop.new", "—", "menu.desktop.import"],
  );
});

test("an accelerator shows as the platform writes it", () => {
  assert.equal(accelHint("CmdOrCtrl+Shift+S", true), "⇧⌘S");
  assert.equal(accelHint("CmdOrCtrl+N", false), "Ctrl+N");
  assert.equal(accelHint("CmdOrCtrl+Shift+B", false), "Ctrl+Shift+B", "Ctrl first, as the menu bar writes it"); // prettier-ignore
  assert.equal(accelHint(undefined, true), undefined);
});

test("an object's menu: no rules, danger last behind exactly one", () => {
  const rule = { separator: true };
  const shape = (items) =>
    dangerLast(items).map((i) => (i.separator ? "—" : i.label));
  assert.deepEqual(
    shape([
      { label: "Pin Assignment…" },
      rule,
      { label: "Properties…" },
      rule,
      { label: "Open CPU Monitor…" },
      rule,
      { label: "Delete Component", danger: true },
    ]),
    ["Pin Assignment…", "Properties…", "Open CPU Monitor…", "—", "Delete Component"], // prettier-ignore
  );
  // A danger item given mid-list still goes last, the others keep their order.
  assert.deepEqual(
    shape([
      { label: "Rename Bus…" },
      { label: "Delete Bus + Wires", danger: true },
      { label: "Red" },
    ]),
    ["Rename Bus…", "Red", "—", "Delete Bus + Wires"],
  );
  // Nothing to set apart: no rule at all.
  assert.deepEqual(shape([{ label: "Properties…" }, rule, { label: "Put Away" }]), ["Properties…", "Put Away"]); // prettier-ignore
  assert.deepEqual(shape([{ label: "Delete", danger: true }]), ["Delete"]);
});
